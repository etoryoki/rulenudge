// Extract machine-checkable rules from CLAUDE.md / AGENTS.md.
// Only strict, explicit phrasing is used; everything else that looks like a
// rule is reported as "not checkable" instead of being guessed.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

export type RuleKind =
  | "forbidden-cmd"
  | "no-env"
  | "package-manager"
  | "worktree-only"
  | "test-before-commit"
  | "protected-path"
  | "no-amend-pushed"
  | "commit-format";

export interface Rule {
  kind: RuleKind;
  /** forbidden-cmd: command prefix. package-manager: the required manager. */
  value?: string;
  text: string;
  file: string;
  line: number;
  /** When this line was written (ms). Actions before this are not judged. */
  since: number;
  /** test-before-commit: the rule asks for passing tests, not just a test run. */
  pass?: boolean;
}

export interface Uncheckable {
  text: string;
  file: string;
  line: number;
}

export interface RuleSet {
  rules: Rule[];
  uncheckable: Uncheckable[];
}

export const NEGATION = /\b(never|don['’]t|do not|must not|mustn['’]t|shall not|not allowed|forbidden|prohibited)\b|禁止|しない(?:こと|で)?|使わない|触らない|触れない|読まない|実行しない|書き換えない|変えない|いじらない|消さない|入れない/i;
const NOT_A_RULE = /\b(forget|worry|hesitate)\b|忘れ/i;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/;
const EDIT_VERB = /\b(?:edit|modify|change|touch|write|overwrite|update|hand-edit|alter)\b|編集|変更|書き換え|手で|触|修正|更新|いじ/i;

/** `dist/`, `src/gen/**`, `*.lock`, `package-lock.json`, `apps/api/prisma/migrations/` */
export function looksLikePath(s: string): boolean {
  if (/\s/.test(s) || /^[-$<]/.test(s) || /[()=,;]/.test(s)) return false;
  return /[\\/*]/.test(s) || /^[\w.-]+\.[A-Za-z0-9]{1,8}$/.test(s);
}

const TEST_WORD = /\btests?\b|テスト/i;
const COMMIT_WORD = /\bcommit(?:s|ting)?\b|コミット/i;
const ORDER_WORD = /\bbefore\b|\bpass(?:es|ing)?\b|\bgreen\b|\bwithout\b|前に|前は|してから|通って|通して|通過|なしで|せずに/i;
// exemptions read like the rule but mean the opposite ("docs-only commits do not need tests",
// "you can commit before running the suite; CI will run the tests") — never turn them into rules
const EXEMPTION =
  /\b(?:can|may|okay|ok|fine|allowed to)\b[^.]*\bcommit|\b(?:don['’]t|do not|doesn['’]t|does not|no)\s+(?:need|require)|\bnot\s+(?:needed|required|necessary)\b|\bno need\b|\bCI\s+(?:will|runs?|handles?)\b|\boptional\b|不要|いらない|しなくて(?:も)?(?:いい|良い|よい|構わない)|(?:なく|なし|無し)でも(?:いい|良い|よい|構わない|OK)|でも構わない|省略(?:して|可)|任意/i;
const CLAUSE_BREAK = /;|。|\binstead\b|\bbut\b|代わりに|ではなく/i;
const CLAUSE_SPLIT = /[,;、]|\bbut\b|けど|けれど|が、/i;
const CLI =/^(git|gh|npm|pnpm|yarn|bun|npx|pnpx|bunx|rm|docker|kubectl|helm|terraform|cdk|aws|gcloud|az|curl|wget|pip|pip3|python|python3|node|make|cargo|go|chmod|chown|psql|mysql|vercel|firebase|supabase|prisma|drizzle-kit)\b/;
const PMS = ["npm", "pnpm", "yarn", "bun"] as const;

/** When was each line written? git blame author-time, falling back to file mtime. */
export function lineTimes(file: string): number[] | null {
  try {
    const out = execFileSync(
      "git",
      ["blame", "--line-porcelain", "--", path.basename(file)],
      { cwd: path.dirname(file), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    const mtime = statSync(file).mtimeMs;
    const times: number[] = [];
    let cur: number | null = null;
    let uncommitted = false;
    for (const l of out.split("\n")) {
      if (/^[0-9a-f]{40} /.test(l)) {
        uncommitted = l.startsWith("0000000000000000000000000000000000000000");
        cur = null;
      } else if (l.startsWith("author-time ")) {
        cur = Number(l.slice("author-time ".length)) * 1000;
      } else if (l.startsWith("\t")) {
        times.push(uncommitted ? mtime : (cur ?? mtime));
      }
    }
    return times;
  } catch {
    return null;
  }
}

function negationIndex(line: string): number {
  const m = line.match(NEGATION);
  return m?.index ?? -1;
}

/** The sentence of `text` that contains `needle` (whole text if there is only one). */
export function sentenceWith(text: string, needle: string | RegExp): string {
  text = text.replace(/\*\*|__/g, "");
  const sentences = text.split(/(?<=[.!?。！？])\s+|(?<=[。！？])/).filter((x) => x.trim());
  if (sentences.length <= 1) return text;
  const hit = sentences.find((x) => (typeof needle === "string" ? x.includes(needle) : needle.test(x)));
  return (hit ?? text).trim();
}

export function extractRulesFromText(
  text: string,
  file: string,
  times: number[] | null,
  fallbackTime: number,
): RuleSet {
  const rules: Rule[] = [];
  const uncheckable: Uncheckable[] = [];
  const lines = text.split(/\r?\n/);
  let inCodeBlock = false;

  lines.forEach((raw, i) => {
    if (/^\s*```/.test(raw)) {
      inCodeBlock = !inCodeBlock;
      return;
    }
    if (inCodeBlock) return;
    const line = raw.trim();
    if (!line) return;
    const base = { text: line.replace(/^[-*+]\s+|^\d+[.)]\s+/, ""), file, line: i + 1, since: times?.[i] ?? fallbackTime };
    const neg = negationIndex(line);
    const isNegated = neg >= 0 && !NOT_A_RULE.test(line);
    const before = rules.length;

    // 0) order rule: run tests before committing ("commit 前にテスト", "never commit without
    // running `pnpm test`"). Checked first so the test command is not read as a forbidden one.
    const ruleLine = BULLET.test(raw) || /^\*\*/.test(line);
    if (ruleLine && TEST_WORD.test(line) && COMMIT_WORD.test(line) && ORDER_WORD.test(line) && !EXEMPTION.test(line)) {
      const explicit = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).find((c) => /test|vitest|jest|pytest/i.test(c));
      const pass = /\bpass(?:es|ing)?\b|\bgreen\b|\bsucceed|通って|通して|通す|通過|成功|グリーン/i.test(line);
      rules.push({ kind: "test-before-commit", value: explicit, ...base, text: sentenceWith(base.text, COMMIT_WORD), pass });
      return;
    }

    // 0a) commit message format: Conventional Commits / English
    if (ruleLine && /commit messages?|commit subject|コミットメッセージ/i.test(line) && !EXEMPTION.test(line)) {
      const text = sentenceWith(base.text, /commit|コミット/i);
      let matched = false;
      if (/conventional\s*commits?/i.test(line) || /`(?:feat|fix|chore|docs)(?:\([^)`]*\))?:?`/.test(line)) {
        rules.push({ kind: "commit-format", value: "conventional", ...base, text });
        matched = true;
      }
      if (/\bin english\b|英語/i.test(line) && !isNegated) {
        rules.push({ kind: "commit-format", value: "english", ...base, text });
        matched = true;
      }
      if (matched) return;
    }

    // 0b) order rule: don't amend commits that were already pushed ("pushed", "push 済み" —
    // not "never push after amending"). The same line may hold other rules, so no return;
    // the amend command itself is then not read as a forbidden command.
    let amendRule = false;
    if (ruleLine && isNegated) {
      const s = sentenceWith(base.text, /amend|アメンド/i);
      if (/amend|アメンド/i.test(s) && /\bpushed\b|push\s*済|プッシュ済|pushした|プッシュした/i.test(s) && NEGATION.test(s) && !EXEMPTION.test(s)) {
        rules.push({ kind: "no-amend-pushed", ...base, text: s });
        amendRule = true;
      }
    }

    if (isNegated) {
      // 1) forbidden commands: inline code after the negation, on a bullet line
      if (BULLET.test(raw) || /^\*\*/.test(line)) {
        for (const m of line.matchAll(/`([^`]+)`/g)) {
          const cmd = m[1].trim();
          const idx = m.index ?? 0;
          if (idx < neg || idx - neg > 80) continue;
          // "Don't hand-edit `x`; run `npm install` instead": the command is in another clause
          if (CLAUSE_BREAK.test(line.slice(neg, idx))) continue;
          if (amendRule && /--amend\b/.test(cmd)) continue;
          if (!CLI.test(cmd)) continue;
          if (/[<>{}]|\.\.\./.test(cmd)) continue; // placeholders like <pkg>
          if (cmd.split(/\s+/).length > 4) continue;
          rules.push({ kind: "forbidden-cmd", value: cmd, ...base, text: sentenceWith(base.text, "`" + m[1] + "`") });
        }
        // 1b) protected paths: "Never edit `dist/`", "`*.lock` を手で書き換えない"
        for (const m of line.matchAll(/`([^`]+)`/g)) {
          const p = m[1].trim();
          if (!looksLikePath(p) || CLI.test(p) || /^\.env\b/.test(p)) continue;
          const sentence = sentenceWith(base.text, "`" + m[1] + "`");
          // the negation and the edit verb must be in the same clause:
          // "You may hand-edit `dist/`, but never commit it" does not forbid editing
          const clauses = sentence.split(CLAUSE_SPLIT);
          if (!clauses.some((c) => NEGATION.test(c) && EDIT_VERB.test(c))) continue;
          rules.push({ kind: "protected-path", value: p.replace(/^\.\//, ""), ...base, text: sentence });
        }
      }
      // 2) don't merge it yourself
      if (/\bmerge\b|マージ/i.test(line) && /yourself|your own|\bPRs?\b|pull request|自分で|勝手に/i.test(line)) {
        rules.push({ kind: "forbidden-cmd", value: "gh pr merge", ...base, text: sentenceWith(base.text, /merge|マージ/i) });
      }
      // 3) secrets
      if (/(^|[\s`'"(])\.env\b/.test(line)) {
        rules.push({ kind: "no-env", ...base, text: sentenceWith(base.text, /\.env/) });
      }
    }

    // 4) package manager ("use pnpm", "pnpm を使う", "pnpm only")
    const pm =
      line.match(/\b(?:always\s+)?use\s+(pnpm|yarn|bun|npm)\b(?!\s+to\b)/i) ??
      line.match(/\b(pnpm|yarn|bun|npm)\s*(?:を使う|を使用|を使って|のみ|only\b)/i);
    if (pm && !isNegated) {
      rules.push({ kind: "package-manager", value: pm[1].toLowerCase(), ...base, text: sentenceWith(base.text, pm[1]) });
    }

    // 5) worktree only
    if (/worktree/i.test(line) && /(never|not|don['’]t)\b[^.]{0,40}main (checkout|working (tree|copy))|メインのチェックアウト|always work in a (git )?worktree/i.test(line)) {
      rules.push({ kind: "worktree-only", ...base, text: sentenceWith(base.text, /worktree/i) });
    }

    // A line is rule-like when one of its sentences starts with an instruction word,
    // or it says must / 必ず / 禁止. "…and never aborts the scan" (description) is not.
    const sentences = line.replace(/^[-*+]\s+|^\d+[.)]\s+|\*\*/g, "").split(/(?<=[.!?。！？])\s*/);
    const isRuleLike =
      sentences.some((s) =>
        /^(never|don['’]t|do not|always|must|make sure|avoid|only|use|run|prefer|keep|write|put)\b/i.test(s.trim()),
      ) || /\bmust\b|必ず|禁止|しないこと|すること|厳守/i.test(line);
    if (rules.length === before && isRuleLike && (BULLET.test(raw) || /^\*\*/.test(line))) {
      uncheckable.push({ text: base.text, file, line: i + 1 });
    }
  });

  // dedupe (same kind + value in the same file keeps the first line)
  const seen = new Set<string>();
  const unique = rules.filter((r) => {
    const k = `${r.file}|${r.kind}|${r.value ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { rules: unique, uncheckable };
}

export function extractRules(file: string): RuleSet {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { rules: [], uncheckable: [] };
  }
  const fallback = statSync(file).mtimeMs;
  return extractRulesFromText(text, file, lineTimes(file), fallback);
}

export const PACKAGE_MANAGERS = PMS;
