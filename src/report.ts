// Human-readable report. Every violation shows rule text, file:line, when, and
// the exact command, so users can judge false positives themselves.

import path from "node:path";

import type { CheckResult, RuleResult } from "./check.js";

const DIV = "─".repeat(56);

function stamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function where(r: RuleResult): string {
  const f = r.rule.file;
  return `${path.basename(path.dirname(f))}/${path.basename(f)}:${r.rule.line}`;
}

function short(s: string, n: number): string {
  // drop Markdown emphasis markers (**bold**, __bold__) copied from CLAUDE.md
  const one = s.replace(/\*\*|__/g, "").replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

export function renderReport(res: CheckResult, days: number, hookInstalled = false): string {
  const out: string[] = [];
  const by = (v: string) => res.results.filter((r) => r.verdict === v);
  const violated = by("violated").sort((a, b) => b.violations.length - a.violations.length);
  const unclear = by("unclear");
  const followed = by("followed");
  const na = by("not-applicable");

  out.push("");
  out.push("  rulenudge — were your CLAUDE.md rules actually followed?");
  out.push("");
  out.push(`  Last ${days} days · ${res.sessionCount} sessions · ${res.toolCallCount} tool calls`);
  out.push("");
  if (!res.results.length) {
    out.push("  No machine-checkable rules found in your CLAUDE.md / AGENTS.md files.");
    out.push("  rulenudge checks bullet rules like:  - Never run `git push --force`");
    if (res.uncheckable.length) {
      out.push(`  (${res.uncheckable.length} other rule(s) need judgement and are not checked in this version.)`);
    }
    out.push("");
    return out.join("\n");
  }

  out.push(`  ${res.results.length} checkable rule(s)`);
  out.push(`    ✓ followed         ${followed.length}`);
  out.push(`    ✗ broken           ${violated.length}`);
  out.push(`    ? unclear          ${unclear.length}   (you had just asked for it)`);
  out.push(`    - not applicable   ${na.length}   (rule added later, or no session ran under it)`);
  if (res.uncheckable.length) out.push(`    · not checkable    ${res.uncheckable.length}   (needs judgement — not checked yet)`);
  if (res.uncheckable.length) out.push("  See which rules are checked and how to make more of them checkable:  rulenudge rules");
  out.push("");

  if (violated.length) {
    out.push(`  ${DIV}`);
    out.push("  Broken rules");
    out.push(`  ${DIV}`);
    for (const r of violated) {
      const sessions = new Set(r.violations.map((v) => v.sessionId)).size;
      out.push("");
      out.push(`  ✗ ${short(r.rule.text, 90)}`);
      out.push(`    ${where(r)} · ${r.violations.length}x in ${sessions} session(s) · rule since ${stamp(r.rule.since)}`);
      for (const v of r.violations.slice(-3)) out.push(`      ${stamp(v.ts)}  ${short(v.what, 100)}`);
    }
    out.push("");
  } else {
    out.push("  Every checkable rule was followed in this period.");
    out.push("");
  }

  if (unclear.length) {
    out.push(`  ${DIV}`);
    out.push("  Unclear (the action matched your own request just before it)");
    out.push(`  ${DIV}`);
    for (const r of unclear) {
      out.push(`  ? ${short(r.rule.text, 90)}  (${where(r)})`);
      for (const v of r.unclear.slice(-2)) out.push(`      ${stamp(v.ts)}  ${short(v.what, 100)}`);
    }
    out.push("");
  }

  if (res.sessionsWithoutRules.length) {
    out.push(`  ${res.sessionsWithoutRules.length} session(s) started where no CLAUDE.md / AGENTS.md was found,`);
    out.push("  so no project rules were loaded. For example:");
    for (const s of res.sessionsWithoutRules.slice(0, 3)) out.push(`      ${stamp(s.firstTs)}  ${s.cwd}`);
    out.push("");
  }

  if (hookInstalled) {
    out.push("  The SessionStart hook is on: broken rules are reminded at the start of each session.");
    out.push("");
    return out.join("\n");
  }
  out.push(`  ${DIV}`);
  out.push("  Next: remind Claude of broken rules at the start of each session");
  out.push(`  ${DIV}`);
  out.push("    npm i -g rulenudge && rulenudge install-hook");
  out.push("");
  return out.join("\n");
}

/** Text for Claude at SessionStart. Short, factual, with evidence. */
export function renderNudge(results: RuleResult[]): string {
  const lines = ["[rulenudge] In earlier sessions in this project, these CLAUDE.md rules were broken:"];
  results.forEach((r, i) => {
    const last = r.violations[r.violations.length - 1];
    lines.push(`${i + 1}. "${short(r.rule.text, 120)}" (${where(r)}) — ${stamp(last.ts)}: ${short(last.what, 100)}`);
  });
  lines.push("Follow these rules in this session. If the user explicitly asks for one of these actions, confirm with them first.");
  return lines.join("\n");
}
