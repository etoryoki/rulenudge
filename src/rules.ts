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
  | "commit-format"
  | "run-before";

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
  /** run-before: the command must run before this git action. */
  trigger?: "push" | "commit";
  /** forbidden-cmd: only forbidden in the repository's main checkout ("…in the main checkout"). */
  where?: "main-checkout";
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

const NEG_EN = /\b(?:never|don['’]t|do not|must not|mustn['’]t|shall not|not allowed|forbidden|prohibited|avoid)\b/i;
const NEG_JA =
  /禁止|厳禁|不可|不採用|避ける|避けて|しない(?:こと|で)?|使わない|触らない|触れない|読まない|書かない|作らない|置かない|残さない|送らない|押さない|含めない|入れない|書き換えない|変えない|いじらない|消さない|行わない|やらない|走らせない|[てで]は(?:いけない|いけません|ならない|なりません|だめ|ダメ|駄目)|べきではない|べきでない/;
export const NEGATION = new RegExp(`${NEG_EN.source}|${NEG_JA.source}`, "i");
// "only when …", "〜する場合は", "〜ないと": a condition, not a plain prohibition
// ("even if" stresses the rule; 「〜ではいけない」 is a prohibition, not 「〜では」)
const CONDITIONAL =
  /\b(?:only when|only if|unless|in case)\b|(?<!\beven\s)\b(?:if|when|while)\b|場合|とき|時は|際|次第|限り|ないと|なければ|たら|なら[、,\s]|ならば|では(?!(?:いけ|なら|なり|だめ|ダメ|駄目|ない))/i;
// "in the main checkout": checkable — the command's folder tells whether it ran there
// (a modifier × a noun, so that "primary checkout" or "shared working copy" are read the same way)
const CHECKOUT_NOUN = String.raw`(?:checkout|clone|worktree|working\s+(?:tree|copy|directory)|repo(?:sitory)?(?:\s+(?:folder|directory))?)`;
const MAIN_CHECKOUT = new RegExp(
  String.raw`\b(?:in|on|from|inside)\s+(?:the\s+|your\s+)?(?:main|primary|root|original|default|shared|base|top-level)\s+${CHECKOUT_NOUN}\b|(?:メイン|本体|元|共有)の?(?:チェックアウト|作業ツリー|作業フォルダ|ワークツリー|クローン)`,
  "i",
);
const MAIN_CHECKOUT_PHRASE = new RegExp(`(?:${MAIN_CHECKOUT.source})(?:では|には|で|に)?`, "gi");
// "on main", "to production", "in staging", "本番では", "main ブランチに": the branch or environment
// is not in the session log, so such a rule cannot be judged without guessing.
// The scope word has to end the phrase: not "to release infrastructure", "the main menu".
const SCOPE_END = String.raw`(?:\s+(?:branch|environment|env|server))?(?=\s*(?:[.,;:)!?]|$|\s+(?:and|or|but|unless|if|when|without|until|before|after|directly)\b))`;
const SCOPE = new RegExp(
  [
    String.raw`\b(?:on|in|to|into|against|from)\s+(?:the\s+)?(?:main|master|develop|trunk|production|prod|staging|release)${SCOPE_END}`,
    String.raw`\b(?:on|in|to)\s+(?:the\s+)?[\w./-]+\s+(?:branch|environment|env)\b`,
    String.raw`\bin\s+CI\b`,
    // another checkout that is not the main one ("in the other checkout"): not judged
    String.raw`\b(?:in|on|from)\s+(?:the\s+|another\s+|a\s+)?[\w'’-]+\s+${CHECKOUT_NOUN}\b`,
    String.raw`(?:main|master|develop|本番|ステージング|staging|production|prod)\s*(?:ブランチ|環境)?\s*(?:で|に|へ|上で)`,
  ].join("|"),
  "i",
);
// "consider avoiding", "〜を避けることを検討", "なるべく"
const HEDGE = /\b(?:consider|ideally|try to|if possible)\b|検討|なるべく|できれば|できるだけ|推奨/i;
// "〜しない設定になっている", "〜でマスクしている": describes the system, not a rule for Claude
const DESCRIPTION = /(?:ている|ていた|てある|てあります|ています|なっている|なっています|される|された|されている)[。．.]?$/;
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
const JA_RULE_END =
  // (not 〜ではない / 〜れない / 〜できない: descriptions such as 「全許可ではない」「では行われない」)
  /(?:許可されない|認められない|(?<![でれきがはく])ない|ないこと|ないで(?:ください)?|ないように|てください|でください|すること|こと|べき|べからず|禁止|厳禁|不可|不採用|必須|厳守|徹底)[。．.！!]?$/;
const FILE_VERB = /\b(?:save|write|create|generate)s?\b|\bfiles?\b|保存|作成|生成|書き出|出力|ファイル/i;
const CLAUSE_BREAK =/;|。|\binstead\b|\bbut\b|代わりに|ではなく/i;
const CLAUSE_SPLIT = /[,;、（）()]|\bbut\b|けど|けれど|が、/i;
const CLI =/^(git|gh|npm|pnpm|yarn|bun|npx|pnpx|bunx|rm|docker|kubectl|helm|terraform|cdk|aws|gcloud|az|curl|wget|pip|pip3|python|python3|node|make|cargo|go|chmod|chown|psql|mysql|vercel|firebase|supabase|prisma|drizzle-kit)\b/;
// checks people run before pushing: CLIs plus linters, type checkers and task runners
const RUNNABLE =
  /^(?:(?:git|gh|npm|pnpm|yarn|bun|npx|pnpx|bunx|node|make|cargo|go|python|python3|pip|deno|dotnet|mvn|gradle|\.\/gradlew|tsc|vue-tsc|eslint|biome|prettier|oxlint|ruff|mypy|pyright|black|flake8|pytest|vitest|jest|turbo|nx|just|tox|golangci-lint|rustfmt|clippy|swiftlint|rubocop|bundle|composer|phpstan)\b)/;
const PMS =["npm", "pnpm", "yarn", "bun"] as const;

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

/** The clause of `text` that holds `token` (split at , ; 、 brackets, but …). */
function clauseOf(text: string, token: string): string {
  return sentenceWith(text, token).split(CLAUSE_SPLIT).find((c) => c.includes(token)) ?? "";
}

/** A conditional, hedged or descriptive statement: not a rule rulenudge can hold Claude to. */
function softened(clause: string): boolean {
  return CONDITIONAL.test(clause) || HEDGE.test(clause) || DESCRIPTION.test(clause.trim());
}

/**
 * Is the command at `idx` (length `len`, including backticks) what the line forbids?
 * English: a negation before it, in the same clause ("Never run `x`").
 * Japanese: a prohibition right after it that ends the clause ("`x` を使ってはいけない"),
 * not "`x` を見ても使わない情報" or "`x` の後、公開しない".
 */
function commandNegated(line: string, idx: number, len: number): boolean {
  let last = -1;
  for (const n of line.slice(0, idx).matchAll(new RegExp(NEG_EN.source, "gi"))) last = n.index ?? -1;
  if (last >= 0 && idx - last <= 80 && !CLAUSE_BREAK.test(line.slice(last, idx))) return true;
  const after = line.slice(idx + len);
  const n = after.match(NEG_JA);
  if (!n || (n.index ?? 0) > 12 || /[`、。,;；]/.test(after.slice(0, n.index))) return false;
  const rest = after.slice((n.index ?? 0) + n[0].length);
  return /^(?:こと|です|ください|で(?:ください)?|ように)?\s*(?:[。．.!！（(、,;；]|$)/.test(rest);
}

/** Nothing but a list of code spans between two points ("`a`, `b` and `c`"), or no clause break. */
function sameClause(between: string): boolean {
  const rest = between.replace(/`[^`]*`/g, "").replace(/\b(?:and|or)\b|と|や|・/g, "");
  return !/[,、;；。]/.test(rest) || /^[\s,、]*$/.test(rest);
}

/**
 * Does the command at `token` have to run before a push / commit in this sentence?
 * "Run `x` before pushing", "Before committing, run `x`", "push 前に `x`", "`x` を実行してから push",
 * "Never push without running `x`". Not "push してから `x`" (the other way round).
 */
function orderTrigger(text: string, token: string): "push" | "commit" | null {
  const seg = sentenceWith(text, token).split(/[;；]|\bbut\b|ただし/i).find((s) => s.includes(token)) ?? "";
  const pos = seg.indexOf(token);
  const kind = (t: string) => (/push|プッシュ/i.test(t) ? "push" : "commit");
  const triggers = [...seg.matchAll(/\bpush(?:es|ed|ing)?\b|プッシュ|\bcommit(?:s|ted|ting)?\b|コミット/gi)];
  for (const t of triggers) {
    const at = t.index ?? 0;
    const end = at + t[0].length;
    // English: "before pushing" / "prior to commit" / "without … push"
    const before = seg.slice(Math.max(0, at - 14), at);
    if (/\b(?:before|prior to)\s+(?:(?:you|the|a|any|each|every)\s+)?$/i.test(before)) {
      if (pos > end || sameClause(seg.slice(pos + token.length, at))) return kind(t[0]);
    }
    if (/\bwithout\b/i.test(seg.slice(end, pos)) && NEG_EN.test(seg.slice(0, at))) return kind(t[0]);
    // Japanese: "push 前に `x`" / "`x` を push の前に実行" / "`x` を実行してから push"
    if (/^\s*(?:を?する|の|し)?\s*前/.test(seg.slice(end, end + 8))) {
      if (pos > end || sameClause(seg.slice(pos + token.length, at))) return kind(t[0]);
    }
    if (pos < at && /(?:して|てから|実行後|通してから|回してから)/.test(seg.slice(pos + token.length, at)) && /から|後/.test(seg.slice(pos + token.length, at))) {
      if (sameClause(seg.slice(pos + token.length, at))) return kind(t[0]);
    }
    if (pos < at && /せずに|せず|しないで|なしで|なしに/.test(seg.slice(pos + token.length, at)) && NEG_JA.test(seg.slice(end))) {
      return kind(t[0]);
    }
  }
  return null;
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
    // 0c) order rule: run a check before pushing / committing ("push 前に `tsc --noEmit`",
    // "Run `pnpm lint` before pushing", "Never push without running `pnpm lint`")
    if (ruleLine && !EXEMPTION.test(line)) {
      let found = false;
      for (const m of line.matchAll(/`([^`]+)`/g)) {
        const cmd = m[1].trim();
        if (!RUNNABLE.test(cmd) || /^git\s/.test(cmd) || /[<>{}]|\.\.\./.test(cmd) || cmd.split(/\s+/).length > 6) continue;
        // a condition anywhere in the sentence applies ("If you changed types, run `tsc` before pushing")
        // (the part before the command, outside brackets: 「（vitest だけでは…）」 is a reason, not a condition)
        const sentence = sentenceWith(base.text, m[0]);
        const lead = sentence.slice(0, sentence.indexOf(m[0])).replace(/[（(][^）)]*[）)]/g, "");
        // "before pushing to main": the branch is not in the session log
        if (softened(clauseOf(base.text, m[0])) || CONDITIONAL.test(lead)) continue;
        if (SCOPE.test(sentence.replace(/[（(][^）)]*[）)]/g, ""))) continue;
        const trigger = orderTrigger(base.text, m[0]);
        if (!trigger) continue;
        rules.push({ kind: "run-before", value: cmd, trigger, ...base, text: sentenceWith(base.text, m[0]) });
        found = true;
      }
      if (found) return;
    }

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
          if (!commandNegated(line, m.index ?? 0, m[0].length)) continue;
          // (「メインの作業ツリーでは」 names a place, not a condition: take it out before looking for one)
          if (softened(clauseOf(base.text, m[0]).replace(MAIN_CHECKOUT_PHRASE, " "))) continue;
          if (amendRule && /--amend\b/.test(cmd)) continue;
          if (!CLI.test(cmd)) continue;
          if (/[<>{}]|\.\.\./.test(cmd)) continue; // placeholders like <pkg>
          if (cmd.split(/\s+/).length > 4) continue;
          // a scope applies to the whole sentence ("Don't `git switch`, `git reset`, … in the main checkout")
          const sentence = sentenceWith(base.text, m[0]);
          const mainOnly = MAIN_CHECKOUT.test(sentence);
          if (!mainOnly && SCOPE.test(sentence)) continue;
          rules.push({ kind: "forbidden-cmd", value: cmd, ...base, text: sentence, ...(mainOnly ? { where: "main-checkout" as const } : {}) });
        }
        // 1b) protected paths: "Never edit `dist/`", "`*.lock` を手で書き換えない"
        for (const m of line.matchAll(/`([^`]+)`/g)) {
          const p = m[1].trim();
          // a file type: "save as `.md` (`.txt` は不採用)", "Never create `.txt` files"
          if (/^\.[A-Za-z0-9]{1,8}$/.test(p) && !/^\.env$/i.test(p)) {
            const clause = clauseOf(base.text, m[0]);
            // "never commit `.log` output" bans committing, not the file type
            if (
              NEGATION.test(clause) &&
              !softened(clause) &&
              !SCOPE.test(sentenceWith(base.text, m[0])) &&
              !MAIN_CHECKOUT.test(sentenceWith(base.text, m[0])) &&
              (FILE_VERB.test(clause) || (/不採用|禁止|厳禁|不可|使わない/.test(clause) && FILE_VERB.test(line)))
            ) {
              rules.push({ kind: "protected-path", value: `*${p}`, ...base, text: sentenceWith(base.text, "`" + m[1] + "`") });
            }
            continue;
          }
          if (!looksLikePath(p) || CLI.test(p) || /^\.env\b/.test(p)) continue;
          const sentence = sentenceWith(base.text, "`" + m[1] + "`");
          // the negation and the edit verb must be in the same clause:
          // "You may hand-edit `dist/`, but never commit it" does not forbid editing
          // (the clause that holds this path — "never edit `dist/`, but you may regenerate `build/`")
          const clause = clauseOf(base.text, m[0]);
          if (!NEGATION.test(clause) || !EDIT_VERB.test(clause) || softened(clause)) continue;
          if (SCOPE.test(sentence) || MAIN_CHECKOUT.test(sentence)) continue;
          rules.push({ kind: "protected-path", value: p.replace(/^\.\//, ""), ...base, text: sentence });
        }
      }
      // 2) don't merge it yourself
      if (/\bmerge\b|マージ/i.test(line) && /yourself|your own|\bPRs?\b|pull request|自分で|勝手に/i.test(line)) {
        rules.push({ kind: "forbidden-cmd", value: "gh pr merge", ...base, text: sentenceWith(base.text, /merge|マージ/i) });
      }
      // 3) secrets
      const envSentence = sentenceWith(base.text, /\.env/);
      // "`.env` の値はマスクしている" describes the code; it is not a rule for Claude
      if (/(^|[\s`'"(])\.env\b/.test(line) && NEGATION.test(envSentence) && !softened(clauseOf(base.text, ".env")) && !SCOPE.test(envSentence)) {
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
    // Japanese rules end in a request or a prohibition: 〜しない。/ 〜すること / 〜してください
    const isRuleLike =
      sentences.some(
        (s) =>
          /^(never|don['’]t|do not|always|must|make sure|avoid|only|use|run|prefer|keep|write|put|please)\b/i.test(s.trim()) ||
          JA_RULE_END.test(s.replace(/[（(][^）)]*[）)]\s*$/, "").trim()),
      ) || /\bmust\b|必ず|禁止|厳禁|しないこと|すること|厳守/i.test(line);
    if (rules.length === before && isRuleLike && (BULLET.test(raw) || /^\*\*/.test(line))) {
      uncheckable.push({ text: base.text, file, line: i + 1 });
    }
  });

  // dedupe (same kind + value in the same file keeps the first line)
  const seen = new Set<string>();
  const unique = rules.filter((r) => {
    const k = `${r.file}|${r.kind}|${r.value ?? ""}|${r.where ?? ""}`;
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
