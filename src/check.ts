// Judge tool events against rules. Four outcomes per rule:
//   violated   - at least one clear violation
//   unclear    - only actions the user had just asked for in their last message
//   followed   - the rule was active during at least one session, no violations
//   not-applicable - the rule did not exist yet / no session ran under it

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { inMainCheckout, isUnder, repoInfo } from "./git.js";
import { extractRules, type Rule, type Uncheckable } from "./rules.js";
import type { SessionInfo, ToolEvent } from "./sessions.js";
import { leadingCd, normalizeMsysPath, splitCommands, startsWithCommand } from "./shell.js";

export type Verdict = "violated" | "unclear" | "followed" | "not-applicable";

export interface Hit {
  ts: number;
  sessionId: string;
  what: string;
}

export interface RuleResult {
  rule: Rule;
  verdict: Verdict;
  violations: Hit[];
  unclear: Hit[];
  sessionsUnderRule: number;
}

export interface CheckResult {
  since: number;
  sessionCount: number;
  toolCallCount: number;
  results: RuleResult[];
  uncheckable: Uncheckable[];
  /** Sessions that started where no CLAUDE.md/AGENTS.md could be found. */
  sessionsWithoutRules: SessionInfo[];
}

const RULE_FILES = ["CLAUDE.md", "AGENTS.md", path.join(".claude", "CLAUDE.md")];
const OTHER_PMS = /^(npm|pnpm|yarn|bun)\s+(install|i|add|ci|remove|uninstall|rm)\b/;
const READERS = /^(cat|less|more|head|tail|type|source|\.|bat|grep|rg|sed|awk)\b/;
const ENV_FILE = /(^|[\s/\\])\.env(?:\.(?!example\b|sample\b|template\b|dist\b)[\w.-]+)?(?=$|\s)/;
const MUTATING_GIT = /^git\s+(switch|checkout|reset|commit|merge|rebase|stash|restore|clean|cherry-pick|revert|am|apply)\b/;
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

const JA_SYNONYMS: Record<string, string[]> = {
  merge: ["マージ"],
  push: ["プッシュ", "push"],
  reset: ["リセット"],
  switch: ["切り替え", "切替"],
  checkout: ["チェックアウト"],
  rm: ["削除", "消して"],
  install: ["インストール", "入れて"],
  commit: ["コミット"],
  env: [".env", "環境変数"],
  hooks: ["フック", "hook"],
  settings: ["設定"],
};

function userAsked(ev: ToolEvent, keywords: string[]): boolean {
  const t = ev.lastUserText.toLowerCase();
  if (!t) return false;
  return keywords.some((k) => {
    const words = [k, ...(JA_SYNONYMS[k] ?? [])];
    return words.some((w) => {
      const lw = w.toLowerCase();
      // ASCII words must match as whole words ("rm" should not match "format")
      if (/^[a-z0-9._-]+$/.test(lw)) {
        const esc = lw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(t);
      }
      return t.includes(lw);
    });
  });
}

function globalRuleFiles(): string[] {
  const homes = new Set([homedir(), process.env.RULENUDGE_HOME ?? homedir()]);
  return [...homes].map((h) => path.resolve(h, ".claude", "CLAUDE.md"));
}

function nonEmpty(p: string): boolean {
  try {
    return statSync(p).size > 0;
  } catch {
    return false;
  }
}

/** Project rule files that apply to a working directory (nearest first). */
export function projectRuleFilesFor(cwd: string): string[] {
  const globals = globalRuleFiles();
  const out: string[] = [];
  let dir = cwd;
  for (let i = 0; i < 12; i++) {
    for (const f of RULE_FILES) {
      const p = path.resolve(dir, f);
      if (!globals.includes(p) && existsSync(p) && nonEmpty(p)) out.push(p);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

/** Project rule files + the user's global ~/.claude/CLAUDE.md. */
export function ruleFilesFor(cwd: string): string[] {
  const globalMd = path.resolve(process.env.RULENUDGE_HOME ?? homedir(), ".claude", "CLAUDE.md");
  const out = projectRuleFilesFor(cwd);
  if (nonEmpty(globalMd)) out.push(globalMd);
  return out;
}

function ruleRoot(rule: Rule): string | null {
  const dir = path.dirname(rule.file);
  const globalDir = path.join(process.env.RULENUDGE_HOME ?? homedir(), ".claude");
  if (path.resolve(dir) === path.resolve(globalDir)) return null; // global: applies everywhere
  return path.basename(dir) === ".claude" ? path.dirname(dir) : dir;
}

function commandOf(ev: ToolEvent): string | null {
  return ev.tool === "Bash" && typeof ev.input.command === "string" ? ev.input.command : null;
}

function fileOf(ev: ToolEvent): string | null {
  const p = ev.input.file_path ?? ev.input.notebook_path ?? ev.input.path;
  return typeof p === "string" ? normalizeMsysPath(p) : null;
}

/** Returns what was violated (a short description), or null. */
function detect(rule: Rule, ev: ToolEvent): { what: string; keywords: string[] } | null {
  const cmd = commandOf(ev);
  const file = fileOf(ev);
  const root = ruleRoot(rule);

  if (cmd !== null) {
    const cwd = leadingCd(cmd) ?? ev.cwd;
    if (root && !isUnder(cwd, root)) return null;
    const cmds = splitCommands(cmd);
    switch (rule.kind) {
      case "forbidden-cmd": {
        const hit = cmds.find((c) => startsWithCommand(c, rule.value!));
        if (hit) {
          // the action word the user would have used when asking for it: last non-flag token
          const words = rule.value!.split(/\s+/).filter((w) => !w.startsWith("-"));
          return { what: hit, keywords: [words[words.length - 1]] };
        }
        return null;
      }
      case "package-manager": {
        const hit = cmds.find((c) => {
          const m = c.match(OTHER_PMS);
          return m !== null && m[1] !== rule.value;
        });
        return hit ? { what: hit, keywords: [hit.split(/\s+/)[0]] } : null;
      }
      case "no-env": {
        const hit = cmds.find((c) => READERS.test(c) && ENV_FILE.test(c));
        return hit ? { what: hit, keywords: ["env"] } : null;
      }
      case "worktree-only": {
        const hit = cmds.find((c) => MUTATING_GIT.test(c));
        if (!hit) return null;
        const repo = repoInfo(cwd);
        if (!repo || !inMainCheckout(cwd, repo)) return null;
        return { what: `${hit}  (in the main checkout: ${cwd})`, keywords: [hit.split(/\s+/)[1]] };
      }
    }
  }

  if (file !== null && FILE_TOOLS.has(ev.tool)) {
    if (root && !isUnder(file, root)) return null;
    if (rule.kind === "no-env") {
      const base = path.basename(file);
      if (/^\.env(\.|$)/.test(base) && !/\.(example|sample|template|dist)$/.test(base)) {
        return { what: `${ev.tool} ${file}`, keywords: ["env", base] };
      }
    }
    if (rule.kind === "worktree-only" && WRITE_TOOLS.has(ev.tool)) {
      const repo = repoInfo(path.dirname(file));
      if (repo && inMainCheckout(file, repo)) {
        return {
          what: `${ev.tool} ${file}  (in the main checkout)`,
          keywords: [path.basename(file), path.basename(path.dirname(file))],
        };
      }
    }
  }
  return null;
}

export function check(events: ToolEvent[], sessions: SessionInfo[], since: number): CheckResult {
  const ruleCache = new Map<string, { rules: Rule[]; uncheckable: Uncheckable[] }>();
  const loadFile = (f: string) => {
    let r = ruleCache.get(f);
    if (!r) {
      r = extractRules(f);
      ruleCache.set(f, r);
    }
    return r;
  };
  const filesByCwd = new Map<string, string[]>();
  const filesFor = (cwd: string) => {
    let f = filesByCwd.get(cwd);
    if (!f) {
      f = ruleFilesFor(cwd);
      filesByCwd.set(cwd, f);
    }
    return f;
  };

  const results = new Map<string, RuleResult>();
  const key = (r: Rule) => `${r.file}|${r.kind}|${r.value ?? ""}`;
  const resultFor = (r: Rule) => {
    let res = results.get(key(r));
    if (!res) {
      res = { rule: r, verdict: "not-applicable", violations: [], unclear: [], sessionsUnderRule: 0 };
      results.set(key(r), res);
    }
    return res;
  };

  const sessionsWithoutRules: SessionInfo[] = [];
  for (const s of sessions) {
    const files = filesFor(s.cwd);
    if (!projectRuleFilesFor(s.cwd).length) sessionsWithoutRules.push(s);
    for (const f of files) for (const r of loadFile(f).rules) resultFor(r);
  }
  // a rule counts as "exercised" by a session that acted after the rule was written
  const exercised = new Map<string, Set<string>>();

  for (const ev of events) {
    for (const f of filesFor(ev.cwd)) {
      for (const r of loadFile(f).rules) {
        if (ev.ts < r.since) continue; // never judge actions taken before the rule was written
        const set = exercised.get(key(r)) ?? new Set<string>();
        set.add(ev.sessionId);
        exercised.set(key(r), set);
        const d = detect(r, ev);
        if (!d) continue;
        const res = resultFor(r);
        const hit = { ts: ev.ts, sessionId: ev.sessionId, what: d.what };
        if (userAsked(ev, d.keywords)) res.unclear.push(hit);
        else res.violations.push(hit);
      }
    }
  }

  for (const res of results.values()) {
    res.sessionsUnderRule = exercised.get(key(res.rule))?.size ?? 0;
    if (res.violations.length) res.verdict = "violated";
    else if (res.unclear.length) res.verdict = "unclear";
    else if (res.sessionsUnderRule > 0) res.verdict = "followed";
    else res.verdict = "not-applicable";
  }

  const uncheckable = [...new Set([...ruleCache.values()].flatMap((r) => r.uncheckable))];
  return {
    since,
    sessionCount: sessions.length,
    toolCallCount: events.length,
    results: [...results.values()],
    uncheckable,
    sessionsWithoutRules,
  };
}
