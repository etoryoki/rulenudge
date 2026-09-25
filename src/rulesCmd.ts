// `rulenudge rules`: which rules in CLAUDE.md / AGENTS.md can be checked, which can't,
// and how to rewrite the ones that almost could. Useful even when nothing was broken.

import path from "node:path";

import { ruleFilesFor } from "./check.js";
import { extractRules, NEGATION, type Rule, type Uncheckable } from "./rules.js";

const DIV = "─".repeat(56);

function stamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function short(s: string, n: number): string {
  const one = s.replace(/\*\*|__/g, "").replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

export function describeRule(r: Rule): string {
  switch (r.kind) {
    case "forbidden-cmd":
      return `never runs \`${r.value}\`${r.where === "main-checkout" ? " in the main checkout" : ""}`;
    case "no-env":
      return "never reads .env files";
    case "package-manager":
      return `uses ${r.value} (not other package managers)`;
    case "worktree-only":
      return "works in a git worktree, not the main checkout";
    case "commit-format":
      return r.value === "conventional"
        ? "writes commit messages as Conventional Commits (feat:, fix(scope): …)"
        : "writes commit messages in English";
    case "no-amend-pushed":
      return "never amends a commit that was already pushed";
    case "protected-path":
      return /^\*\.[A-Za-z0-9]+$/.test(r.value ?? "") ? `never writes ${r.value!.slice(1)} files` : `never edits \`${r.value}\``;
    case "run-before":
      return `runs \`${r.value}\` before ${r.trigger === "commit" ? "committing" : "pushing"} code changes`;
    case "test-before-commit":
      return `runs tests${r.value ? ` (\`${r.value}\`)` : ""} before committing code changes`;
  }
}

const COMMAND_WORD =
  /\b(git (?:push|commit|reset|rebase|merge|checkout|switch|stash|clean|amend|tag)|gh pr \w+|npm (?:install|i|publish)|pnpm (?:add|install|publish)|yarn add|docker(?: compose)? \w+|rm -rf|kubectl \w+|terraform \w+)\b[^.,;:)]*/i;

/** Why a rule is not checkable, and how it could be (if at all). */
export function hintFor(u: Uncheckable): string {
  const t = u.text;
  if (/test|テスト/i.test(t) && /commit|コミット/i.test(t)) {
    return "say when the tests must run to make it checkable, e.g.  - Run the tests before committing";
  }
  if (!/`/.test(t)) {
    const m = t.match(COMMAND_WORD);
    if (m) {
      return `write the command in backticks to make it checkable, e.g.  - Never run \`${m[0].trim()}\``;
    }
  }
  // looks like a shell command: lowercase program name followed by arguments (not `camelCaseFn`)
  const code = t.match(/`([a-z][a-z0-9-]*)\s+[^`]+`/);
  if (code && NEGATION.test(t)) {
    return `\`${code[1]}\` is not a command rulenudge knows yet (supported: git, gh, npm, pnpm, yarn, docker, rm, kubectl, terraform, …)`;
  }
  return "needs judgement (style, design, where/how to do something) — not machine-checkable";
}

function label(file: string): string {
  return `${path.basename(path.dirname(file))}/${path.basename(file)}`;
}

export function renderRules(dir: string): string {
  const out: string[] = [];
  const files = ruleFilesFor(dir);
  out.push("");
  out.push(`  rulenudge rules — ${dir}`);
  out.push("");
  if (!files.length) {
    out.push("  No CLAUDE.md or AGENTS.md applies to this directory.");
    out.push("  Claude Code sessions started here run without project rules.");
    out.push("");
    return out.join("\n");
  }
  let checkable = 0;
  let notCheckable = 0;
  for (const file of files) {
    const { rules, uncheckable } = extractRules(file);
    checkable += rules.length;
    notCheckable += uncheckable.length;
    out.push(`  ${DIV}`);
    out.push(`  ${label(file)}   (${file})`);
    out.push(`  ${DIV}`);
    if (!rules.length && !uncheckable.length) {
      out.push("    no rule-like lines found");
      out.push("");
      continue;
    }
    if (rules.length) {
      out.push(`    ✓ checked (${rules.length})`);
      for (const r of rules) {
        out.push(`      line ${String(r.line).padEnd(4)} ${describeRule(r)}   since ${stamp(r.since)}`);
        out.push(`                "${short(r.text, 80)}"`);
      }
    }
    if (uncheckable.length) {
      out.push(`    · not checked (${uncheckable.length})`);
      for (const u of uncheckable) {
        out.push(`      line ${String(u.line).padEnd(4)} "${short(u.text, 80)}"`);
        out.push(`                → ${hintFor(u)}`);
      }
    }
    out.push("");
  }
  out.push(`  ${checkable} rule(s) checked, ${notCheckable} not checked.`);
  out.push("  Checked rules are verified against your session logs by `rulenudge`.");
  out.push("");
  return out.join("\n");
}
