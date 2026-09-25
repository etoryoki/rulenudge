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
  | "worktree-only";

export interface Rule {
  kind: RuleKind;
  /** forbidden-cmd: command prefix. package-manager: the required manager. */
  value?: string;
  text: string;
  file: string;
  line: number;
  /** When this line was written (ms). Actions before this are not judged. */
  since: number;
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

export const NEGATION = /\b(never|don['’]t|do not|must not|mustn['’]t|shall not|not allowed|forbidden|prohibited)\b|禁止|しない(?:こと|で)?|使わない|触らない|読まない|実行しない/i;
const NOT_A_RULE = /\b(forget|worry|hesitate)\b|忘れ/i;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/;
const CLI = /^(git|gh|npm|pnpm|yarn|bun|npx|pnpx|bunx|rm|docker|kubectl|helm|terraform|cdk|aws|gcloud|az|curl|wget|pip|pip3|python|python3|node|make|cargo|go|chmod|chown|psql|mysql|vercel|firebase|supabase|prisma|drizzle-kit)\b/;
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

    if (isNegated) {
      // 1) forbidden commands: inline code after the negation, on a bullet line
      if (BULLET.test(raw) || /^\*\*/.test(line)) {
        for (const m of line.matchAll(/`([^`]+)`/g)) {
          const cmd = m[1].trim();
          const idx = m.index ?? 0;
          if (idx < neg || idx - neg > 80) continue;
          if (!CLI.test(cmd)) continue;
          if (/[<>{}]|\.\.\./.test(cmd)) continue; // placeholders like <pkg>
          if (cmd.split(/\s+/).length > 4) continue;
          rules.push({ kind: "forbidden-cmd", value: cmd, ...base });
        }
      }
      // 2) don't merge it yourself
      if (/\bmerge\b|マージ/i.test(line) && /yourself|your own|\bPRs?\b|pull request|自分で|勝手に/i.test(line)) {
        rules.push({ kind: "forbidden-cmd", value: "gh pr merge", ...base });
      }
      // 3) secrets
      if (/(^|[\s`'"(])\.env\b/.test(line)) {
        rules.push({ kind: "no-env", ...base });
      }
    }

    // 4) package manager ("use pnpm", "pnpm を使う", "pnpm only")
    const pm =
      line.match(/\b(?:always\s+)?use\s+(pnpm|yarn|bun|npm)\b(?!\s+to\b)/i) ??
      line.match(/\b(pnpm|yarn|bun|npm)\s*(?:を使う|を使用|を使って|のみ|only\b)/i);
    if (pm && !isNegated) {
      rules.push({ kind: "package-manager", value: pm[1].toLowerCase(), ...base });
    }

    // 5) worktree only
    if (/worktree/i.test(line) && /(never|not|don['’]t)\b[^.]{0,40}main (checkout|working (tree|copy))|メインのチェックアウト|always work in a (git )?worktree/i.test(line)) {
      rules.push({ kind: "worktree-only", ...base });
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
