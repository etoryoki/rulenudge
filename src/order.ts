// Order rules ("run tests before committing") need state across tool calls, unlike the
// other rules which look at one call at a time. State is kept per session AND per
// repository: one session often edits several repositories (`cd` between them), and a
// per-session flag would blame a commit in repo A for an untested edit in repo B.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { fileRoot, isUnder, norm, ruleCovers, worktreeRoot } from "./git.js";
import type { Rule } from "./rules.js";
import type { ToolEvent } from "./sessions.js";
import { runsCheck } from "./scripts.js";
import { commandsWithCwd, normalizeMsysPath, startsWithCommand, unquote } from "./shell.js";

const TEST_CMD =
  /^(?:(?:npm|pnpm|yarn|bun)\s+(?:(?:-r|--recursive|-w|--workspace(?:=\S+|\s+\S+)?|--filter(?:=\S+|\s+\S+)|-F\s+\S+)\s+)*(?:run\s+)?test\b|(?:npx|pnpx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+exec)\s+(?:vitest|jest|mocha|ava|playwright\s+test)\b|(?:npm|pnpm|yarn)\s+(?:(?:-r|--filter(?:=\S+|\s+\S+)|-F\s+\S+)\s+)*exec\s+(?:vitest|jest)\b|vitest\b|jest\b|mocha\b|pytest\b|python3?\s+-m\s+(?:pytest|unittest)\b|go\s+test\b|cargo\s+(?:test|nextest)\b|make\s+(?:test|check)\b|deno\s+test\b|mvn\s+(?:test|verify)\b|(?:\.\/)?gradlew?\s+test\b|(?:bundle\s+exec\s+)?rspec\b|phpunit\b|dotnet\s+test\b)/i;
const COMMIT = /^git\s+commit\b/;
// docs, prose and images are not "code changes" that need a test run
const NOT_CODE = /\.(md|mdx|markdown|txt|rst|adoc|png|jpe?g|gif|svg|webp|ico|pdf)$|[\\/]docs?[\\/]/i;
const SKIP_TESTS = /\b(skip|without|no need|don['’]t need|not needed|later)\b|不要|いらない|いい(?:の|から|です|よ)|後で|なしで|省略|飛ばして/i;

export interface OrderHit {
  ts: number;
  sessionId: string;
  what: string;
  unclear: boolean;
}

const hasTestsCache = new Map<string, boolean>();

/**
 * Does this checkout have a test command at all? Without one, "test before commit"
 * cannot be followed, so the rule is not applied there.
 */
export function hasTestSetup(root: string): boolean {
  const k = norm(root);
  const hit = hasTestsCache.get(k);
  if (hit !== undefined) return hit;
  let found = false;
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    const test = pkg.scripts?.test ?? "";
    found = !!test && !/no test specified/i.test(test);
  } catch {
    /* no package.json */
  }
  if (!found) {
    // monorepo: no test script at the root, but in workspace packages (apps/*, packages/*, …)
    for (const group of ["apps", "packages", "services", "libs", "modules"]) {
      let names: string[] = [];
      try {
        names = readdirSync(path.join(root, group));
      } catch {
        continue;
      }
      found = names.some((n) => {
        try {
          const pkg = JSON.parse(readFileSync(path.join(root, group, n, "package.json"), "utf8")) as {
            scripts?: Record<string, string>;
          };
          const t = pkg.scripts?.test ?? "";
          return !!t && !/no test specified/i.test(t);
        } catch {
          return false;
        }
      });
      if (found) break;
    }
  }
  if (!found) {
    found = ["pytest.ini", "tox.ini", "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts", "Gemfile"].some(
      (f) => existsSync(path.join(root, f)),
    );
  }
  if (!found) {
    try {
      found = /^\[tool\.pytest/m.test(readFileSync(path.join(root, "pyproject.toml"), "utf8"));
    } catch {
      /* none */
    }
  }
  if (!found) {
    try {
      found = /^test:/m.test(readFileSync(path.join(root, "Makefile"), "utf8"));
    } catch {
      /* none */
    }
  }
  hasTestsCache.set(k, found);
  return found;
}

// test runners invoked by file: `node node_modules/vitest/vitest.mjs run`, `node …/jest/bin/jest.js`
const TEST_BY_PATH = /^node\s+\S*(?:vitest|jest|mocha)[\\/](?:vitest\.mjs|bin[\\/]\S+)/i;

function isTestCommand(text: string, explicit?: string): boolean {
  const t = unquote(text);
  return (!!explicit && startsWithCommand(t, explicit)) || TEST_CMD.test(t) || TEST_BY_PATH.test(t);
}

/** The user asked to commit without tests in one of their last messages. */
function userSkippedTests(ev: ToolEvent): boolean {
  return ev.lastUserText
    .toLowerCase()
    .split(/[\n。！？!?]+|\.\s/)
    .some((s) => /\btests?\b|テスト/i.test(s) && SKIP_TESTS.test(s) && !/^(?:never|don['’]t|do not)\b/i.test(s.trim()));
}

function fileOf(ev: ToolEvent): string | null {
  const p = ev.input.file_path ?? ev.input.notebook_path;
  return typeof p === "string" ? normalizeMsysPath(p) : null;
}

const HEAD_MOVE = /^git\s+(?:checkout|switch|cherry-pick|merge|rebase|revert|pull|am|reset)\b/;

export interface OrderTracker {
  step(ev: ToolEvent): OrderHit | null;
}

/**
 * "Never amend a pushed commit": after `git push`, the next `git commit --amend` in the same
 * checkout (with no new commit in between) rewrites a pushed commit. Push state belongs to the
 * checkout, so it is tracked across sessions (events are processed in time order).
 */
export class AmendAfterPushTracker implements OrderTracker {
  private pushed = new Map<string, boolean>();

  constructor(private readonly scope: string | null) {}

  step(ev: ToolEvent): OrderHit | null {
    if ((ev.tool !== "Bash" && ev.tool !== "PowerShell") || typeof ev.input.command !== "string") return null;
    for (const c of commandsWithCwd(ev.input.command, ev.cwd, ev.tool === "PowerShell")) {
      const root = worktreeRoot(c.cwd);
      if (!root || (this.scope && !isUnder(root, this.scope) && !isUnder(this.scope, root))) continue;
      const k = norm(root);
      if (/^git\s+push\b/.test(c.text)) {
        // a failed push (non-zero exit) pushed nothing
        if (ev.isError !== true) this.pushed.set(k, true);
        continue;
      }
      // HEAD moved to a commit we know nothing about (another branch, a cherry-pick, a rebase …):
      // whether it was pushed is unknown, so an amend after this is not judged
      if (HEAD_MOVE.test(c.text)) {
        this.pushed.delete(k);
        continue;
      }
      if (!COMMIT.test(c.text)) continue;
      if (/--amend\b/.test(c.text)) {
        const wasPushed = this.pushed.get(k) === true;
        this.pushed.set(k, false);
        if (wasPushed) {
          return {
            ts: ev.ts,
            sessionId: ev.sessionId,
            what: `${unquote(c.text).slice(0, 80)}  (the last commit had already been pushed)`,
            unclear: /amend|アメンド/i.test(ev.lastUserText),
          };
        }
      } else {
        this.pushed.set(k, false);
      }
    }
    return null;
  }
}

/** A git hook in the checkout (husky or .git/hooks) that runs the check on this action. */
function hookRuns(root: string, hook: string, cmd: string): boolean {
  for (const file of [path.join(root, ".husky", hook), path.join(root, ".git", "hooks", hook)]) {
    let body: string;
    try {
      body = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = body.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
    if (lines.some((l) => runsCheck(l.trim(), cmd, root, root))) return true;
  }
  return false;
}

/**
 * "Run `x` before pushing / committing": after a code change in a session, the check must run
 * before the next push (or commit) from that checkout. A git hook that runs the check counts,
 * unless the push / commit skips hooks with --no-verify.
 */
export class RunBeforeTracker implements OrderTracker {
  /** key = sessionId|repoRoot → code changed since the check last ran */
  private dirty = new Map<string, boolean>();

  constructor(
    private readonly rule: Rule,
    private readonly scope: string | null,
  ) {}

  private inScope(root: string): boolean {
    return ruleCovers(this.scope, root);
  }

  step(ev: ToolEvent): OrderHit | null {
    const cmd = this.rule.value!;
    const trigger = this.rule.trigger ?? "push";
    if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(ev.tool)) {
      const file = fileOf(ev);
      if (!file || NOT_CODE.test(file)) return null;
      const root = fileRoot(file);
      if (root && this.inScope(root)) this.dirty.set(`${ev.sessionId}|${norm(root)}`, true);
      return null;
    }
    if ((ev.tool !== "Bash" && ev.tool !== "PowerShell") || typeof ev.input.command !== "string") return null;
    for (const c of commandsWithCwd(ev.input.command, ev.cwd, ev.tool === "PowerShell")) {
      const root = worktreeRoot(c.cwd);
      if (!root || !this.inScope(root)) continue;
      const k = `${ev.sessionId}|${norm(root)}`;
      if (runsCheck(c.text, cmd, root, c.cwd)) {
        this.dirty.set(k, false);
        continue;
      }
      const isTrigger =
        trigger === "push"
          ? /^git\s+push\b/.test(c.text) && !/\s(?:-n|--dry-run)\b/.test(c.text)
          : COMMIT.test(c.text) && !/--amend\b/.test(c.text);
      if (!isTrigger) continue;
      if (this.dirty.get(k) !== true) continue;
      // (`git push -n` is a dry run; `git commit -n` skips hooks)
      const noVerify = (trigger === "push" ? /\s--no-verify\b/ : /\s(?:--no-verify|-n)\b/).test(c.text);
      if (!noVerify && hookRuns(root, trigger === "push" ? "pre-push" : "pre-commit", cmd)) {
        this.dirty.set(k, false);
        continue;
      }
      this.dirty.set(k, false);
      return {
        ts: ev.ts,
        sessionId: ev.sessionId,
        what: `${unquote(c.text).slice(0, 80)}  (files were edited, \`${cmd}\` not run since${noVerify ? "; hooks skipped with --no-verify" : ""})`,
        unclear: userSkipped(ev, cmd),
      };
    }
    return null;
  }
}

/** The user asked to push / commit without the check ("skip lint", "型チェックなしで"). */
function userSkipped(ev: ToolEvent, cmd: string): boolean {
  const word = cmd.split(/\s+/)[0].replace(/^.*[\\/]/, "");
  return ev.lastUserText
    .toLowerCase()
    .split(/[\n。！？!?]+|\.\s/)
    .some((s) => (s.includes(word.toLowerCase()) || /check|lint|チェック|型/.test(s)) && SKIP_TESTS.test(s) && !/^(?:never|don['’]t|do not)\b/i.test(s.trim()));
}

export class TestBeforeCommitTracker implements OrderTracker {
  /** key = sessionId|repoRoot → the code changed since the last test run / commit */
  private dirty = new Map<string, boolean>();
  /** key → the latest test run since the last change failed (only tracked for "must pass" rules) */
  private failed = new Map<string, boolean>();

  constructor(
    private readonly rule: Rule,
    private readonly scope: string | null,
  ) {}

  private inScope(root: string): boolean {
    return ruleCovers(this.scope, root) && hasTestSetup(root);
  }

  step(ev: ToolEvent): OrderHit | null {
    if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(ev.tool)) {
      const file = fileOf(ev);
      if (!file || NOT_CODE.test(file)) return null;
      const root = fileRoot(file);
      if (root && this.inScope(root)) this.dirty.set(`${ev.sessionId}|${norm(root)}`, true);
      return null;
    }
    if ((ev.tool !== "Bash" && ev.tool !== "PowerShell") || typeof ev.input.command !== "string") return null;

    const cmds = commandsWithCwd(ev.input.command, ev.cwd, ev.tool === "PowerShell");
    for (const [i, c] of cmds.entries()) {
      const root = worktreeRoot(c.cwd);
      if (!root || !this.inScope(root)) continue;
      const k = `${ev.sessionId}|${norm(root)}`;
      if (isTestCommand(c.text, this.rule.value)) {
        // "tests must pass": a failed run leaves the change untested. (A pipe such as
        // `npm test | tail` hides the exit code; then the run counts as passed.)
        // The exit status belongs to the whole call, so it only tells about the test when the
        // test is the call's last command (`pnpm test; git log` would hide a failure).
        const last = i === cmds.length - 1;
        if (this.rule.pass && ev.isError === true && last) {
          this.failed.set(k, true);
        } else {
          this.dirty.set(k, false);
          this.failed.set(k, false);
        }
        continue;
      }
      if (COMMIT.test(c.text) && !/--amend\b/.test(c.text)) {
        const wasDirty = this.dirty.get(k) === true;
        const failed = this.failed.get(k) === true;
        this.dirty.set(k, false);
        this.failed.set(k, false);
        if (!wasDirty) continue;
        return {
          ts: ev.ts,
          sessionId: ev.sessionId,
          what: `${unquote(c.text).slice(0, 80)}  (${failed ? "the last test run failed" : "files were edited in this session, no test run since"})`,
          unclear: userSkippedTests(ev),
        };
      }
    }
    return null;
  }
}

