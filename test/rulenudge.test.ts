import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { check } from "../src/check.js";
import { extractRulesFromText } from "../src/rules.js";
import { encodeProjectDir, readSessions } from "../src/sessions.js";
import { splitCommands } from "../src/shell.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const DAY = 86_400_000;

let home: string;
let repo: string;
let projects: string;

function git(args: string[], cwd: string, date?: string): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
    },
  });
}

/** Write a session transcript. Each step: user text or tool call. */
function session(
  id: string,
  cwd: string,
  steps: ({ user: string; at: number } | { bash: string; at: number } | { tool: string; file: string; at: number })[],
  opts: { sidechain?: boolean } = {},
): void {
  const dir = path.join(projects, encodeProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  const lines = steps.map((s) => {
    const base = { sessionId: id, cwd, timestamp: new Date(s.at).toISOString(), isSidechain: !!opts.sidechain };
    if ("user" in s) return JSON.stringify({ ...base, type: "user", message: { role: "user", content: s.user } });
    const input = "bash" in s ? { command: s.bash } : { file_path: s.file };
    const name = "bash" in s ? "Bash" : s.tool;
    return JSON.stringify({
      ...base,
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "x", name, input }] },
    });
  });
  writeFileSync(path.join(dir, `${id}.jsonl`), lines.join("\n") + "\n");
}

function run(since = Date.now() - 7 * DAY) {
  const { events, sessions } = readSessions({ since });
  return check(events, sessions, since);
}

function verdictOf(kind: string, value?: string) {
  return run().results.find((r) => r.rule.kind === kind && (value === undefined || r.rule.value === value));
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "rulenudge-"));
  projects = path.join(home, ".claude", "projects");
  mkdirSync(projects, { recursive: true });
  process.env.RULENUDGE_PROJECTS_DIR = projects;
  process.env.RULENUDGE_HOME = home;
  repo = path.join(home, "repo");
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"], repo);
});

afterEach(() => {
  delete process.env.RULENUDGE_PROJECTS_DIR;
  delete process.env.RULENUDGE_HOME;
  rmSync(home, { recursive: true, force: true });
});

function commitClaudeMd(text: string, at: number): void {
  writeFileSync(path.join(repo, "CLAUDE.md"), text);
  git(["add", "CLAUDE.md"], repo);
  git(["commit", "-q", "-m", "rules"], repo, new Date(at).toISOString());
}

describe("rule extraction", () => {
  it("extracts forbidden commands only from negated bullet lines", () => {
    const { rules, uncheckable } = extractRulesFromText(
      [
        "- Never run `git push --force`.",
        "- Don't forget to run `pnpm build` first.",
        "- Rebuild with `pnpm build --filter=<pkg>...` before testing.",
        "Run `git push --force` only in emergencies.",
        "- Never reply in English.",
        "```",
        "- Never run `rm -rf /`",
        "```",
      ].join("\n"),
      "CLAUDE.md",
      null,
      0,
    );
    expect(rules.map((r) => r.value)).toEqual(["git push --force"]);
    // "Don't forget to run …" is an instruction (listed as not checkable), not a prohibition
    expect(uncheckable.map((u) => u.text)).toEqual(["Don't forget to run `pnpm build` first.", "Never reply in English."]);
  });

  it("detects merge, .env, package manager and worktree rules", () => {
    const { rules } = extractRulesFromText(
      [
        "- Open a PR. Don't merge it yourself.",
        "- Never read `.env` files.",
        "- Use pnpm for everything.",
        "- Always work in a git worktree, never in the main checkout.",
      ].join("\n"),
      "CLAUDE.md",
      null,
      0,
    );
    expect(rules.map((r) => `${r.kind}:${r.value ?? ""}`).sort()).toEqual(
      ["forbidden-cmd:gh pr merge", "no-env:", "package-manager:pnpm", "worktree-only:"].sort(),
    );
  });
});

describe("test before commit", () => {
  const rule = "- Never commit without running `pnpm test`.\n";
  const withTests = () =>
    writeFileSync(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));

  it("reads the rule (and does not treat the test command as forbidden)", () => {
    const read = (line: string) =>
      extractRulesFromText(line, "CLAUDE.md", null, 0).rules.map((r) => `${r.kind}:${r.value ?? ""}`);
    expect(read(rule.trim())).toEqual(["test-before-commit:pnpm test"]);
    expect(read("- コミット前に必ずテストを通すこと")).toEqual(["test-before-commit:"]);
    expect(read("- Run the tests before committing.")).toEqual(["test-before-commit:"]);
    expect(read("- Tests live in packages/*/test.")).toEqual([]);
  });

  it("never reads exemptions as the rule (CTO review)", () => {
    const read = (line: string) =>
      extractRulesFromText(line, "CLAUDE.md", null, 0).rules.filter((r) => r.kind === "test-before-commit");
    for (const line of [
      "- You can commit before running the full test suite locally; CI will run the tests.",
      "- Docs-only commits do not need tests first.",
      "- This is the first commit; tests will follow in the next PR.",
      "- Do not require tests before every commit for typo fixes.",
      "- ドキュメントだけのコミットはテストなしでも構わない",
      "- 軽微な修正はコミット前のテストは不要",
    ]) {
      expect(read(line), line).toEqual([]);
    }
  });

  it("flags a commit after code edits with no test run, and accepts one after tests", () => {
    commitClaudeMd(rule, Date.now() - 3 * DAY);
    withTests();
    const t = Date.now() - DAY;
    session("s1", repo, [
      { tool: "Edit", file: path.join(repo, "src.ts"), at: t },
      { bash: "git add -A && git commit -m x", at: t + 1000 },
    ]);
    session("s2", repo, [
      { tool: "Edit", file: path.join(repo, "src.ts"), at: t },
      { bash: "pnpm --filter @x/app test", at: t + 500 },
      { bash: "git commit -am y", at: t + 1000 },
    ]);
    const r = verdictOf("test-before-commit");
    expect(r?.verdict).toBe("violated");
    expect(r?.violations.map((v) => v.sessionId)).toEqual(["s1"]);
  });

  it("ignores docs-only changes, amends, and edits in another repository", () => {
    commitClaudeMd(rule, Date.now() - 3 * DAY);
    withTests();
    const other = path.join(home, "other");
    mkdirSync(other);
    git(["init", "-q", "-b", "main"], other);
    const t = Date.now() - DAY;
    session("s1", repo, [
      { tool: "Edit", file: path.join(repo, "README.md"), at: t },
      { bash: "git commit -m docs", at: t + 100 },
      { tool: "Edit", file: path.join(other, "lib.ts"), at: t + 200 },
      { bash: "git commit -m unrelated", at: t + 300 },
      { tool: "Edit", file: path.join(repo, "src.ts"), at: t + 400 },
      { bash: "git commit --amend --no-edit", at: t + 500 },
    ]);
    expect(verdictOf("test-before-commit")?.verdict).toBe("followed");
  });

  it("does not apply to a repository without any test command", () => {
    commitClaudeMd(rule, Date.now() - 3 * DAY);
    const t = Date.now() - DAY;
    session("s1", repo, [
      { tool: "Edit", file: path.join(repo, "src.ts"), at: t },
      { bash: "git commit -m x", at: t + 1000 },
    ]);
    expect(verdictOf("test-before-commit")?.violations).toHaveLength(0);
  });

  it("recognises tests run through a file path after a PowerShell variable cd", () => {
    commitClaudeMd(rule, Date.now() - 3 * DAY);
    withTests();
    const t = Date.now() - DAY;
    const ps = [`$wt="${repo}"`, `Set-Location "$wt"; node "$wt/node_modules/vitest/vitest.mjs" run`].join("\n");
    session("s1", repo, [
      { tool: "Edit", file: path.join(repo, "src.ts"), at: t },
      { bash: ps, at: t + 500 },
      { bash: "git commit -m y", at: t + 1000 },
    ]);
    expect(verdictOf("test-before-commit")?.verdict).toBe("followed");
  });

  it("with 'tests must pass', a commit after a failed run is a violation", () => {
    commitClaudeMd("- Make sure the tests pass before committing.\n", Date.now() - 3 * DAY);
    withTests();
    const t = Date.now() - DAY;
    const dir = path.join(projects, encodeProjectDir(repo));
    mkdirSync(dir, { recursive: true });
    const line = (o: object) => JSON.stringify({ sessionId: "p1", cwd: repo, timestamp: new Date(t).toISOString(), ...o });
    writeFileSync(
      path.join(dir, "p1.jsonl"),
      [
        line({ type: "assistant", message: { content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: path.join(repo, "a.ts") } }] } }),
        line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test" } }] } }),
        line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "Exit code 1" }] } }),
        line({ type: "assistant", message: { content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "git commit -m x" } }] } }),
      ].join("\n") + "\n",
    );
    const r = verdictOf("test-before-commit");
    expect(r?.verdict).toBe("violated");
    expect(r?.violations[0].what).toContain("the last test run failed");
  });

  it("finds test scripts in monorepo packages", async () => {
    const { hasTestSetup } = await import("../src/order.js");
    mkdirSync(path.join(repo, "packages", "core"), { recursive: true });
    writeFileSync(path.join(repo, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
    expect(hasTestSetup(repo)).toBe(false);
    const mono = path.join(home, "mono");
    mkdirSync(path.join(mono, "packages", "core"), { recursive: true });
    writeFileSync(path.join(mono, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
    writeFileSync(path.join(mono, "packages", "core", "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    expect(hasTestSetup(mono)).toBe(true);
  });

  it("is unclear when the user asked to commit without tests", () => {
    commitClaudeMd(rule, Date.now() - 3 * DAY);
    withTests();
    const t = Date.now() - DAY;
    session("s1", repo, [
      { tool: "Edit", file: path.join(repo, "src.ts"), at: t },
      { user: "テストはいいのでコミットしてください", at: t + 500 },
      { bash: "git commit -m x", at: t + 1000 },
    ]);
    expect(verdictOf("test-before-commit")?.verdict).toBe("unclear");
  });
});

describe("commit message format", () => {
  it("reads Conventional Commits and English rules", () => {
    const read = (line: string) =>
      extractRulesFromText(line, "CLAUDE.md", null, 0).rules.map((r) => `${r.kind}:${r.value ?? ""}`);
    expect(read("- Write commit messages as Conventional Commits.")).toEqual(["commit-format:conventional"]);
    expect(read("- コミットメッセージは `feat:` / `fix:` で始める")).toEqual(["commit-format:conventional"]);
    expect(read("- Commit messages in English.")).toEqual(["commit-format:english"]);
    expect(read("- コミットメッセージは英語で書く")).toEqual(["commit-format:english"]);
    expect(read("- Commit messages may be in Japanese.")).toEqual([]);
    expect(read("- Commit messages don't need to follow Conventional Commits for WIP branches.")).toEqual([]);
  });

  it("reads every commit on a line joined with &&", async () => {
    const { commitSubjects } = await import("../src/shell.js");
    expect(commitSubjects('git commit -m "feat: first" && git commit -m "bad message"')).toEqual([
      "feat: first",
      "bad message",
    ]);
    expect(commitSubjects('git commit -a && git commit -m "x"')).toEqual(["x"]);
    expect(commitSubjects("git commit -F - <<'EOF' && git push\nfix: y\nEOF")).toEqual(["fix: y"]);
  });

  it("flags messages that break the format, from -m and heredocs", () => {
    commitClaudeMd("- Write commit messages as Conventional Commits, in English.\n", Date.now() - 3 * DAY);
    const t = Date.now() - DAY;
    session("s1", repo, [
      { bash: `git commit -m "feat(cli): add rules command"`, at: t },
      { bash: `git commit -F - <<'EOF'\nfix: handle empty logs\n\nbody\nEOF`, at: t + 100 },
      { bash: `git commit -m "update stuff"`, at: t + 200 },
      { bash: `git commit -m "docs: 日本語の説明を追加"`, at: t + 300 },
      { bash: "git commit --amend --no-edit", at: t + 400 },
      { bash: `git commit -m "$(cat <<'EOF'\nchore: bump deps\n\nbody\nEOF\n)"`, at: t + 500 },
      { bash: `git commit -m "$(cat <<'EOF'\nbump deps again\nEOF\n)"`, at: t + 600 },
    ]);
    const conv = verdictOf("commit-format", "conventional");
    const en = verdictOf("commit-format", "english");
    expect(conv?.violations.map((v) => v.what)).toEqual([
      'git commit: "update stuff"',
      'git commit: "bump deps again"',
    ]);
    expect(en?.violations.map((v) => v.what)).toEqual(['git commit: "docs: 日本語の説明を追加"']);
  });
});

describe("amend after push", () => {
  const rule = "- Never `git commit --amend` a commit that was already pushed.\n";

  it("reads the rule as an order rule, not a ban on every amend", () => {
    const read = (line: string) =>
      extractRulesFromText(line, "CLAUDE.md", null, 0).rules.map((r) => r.kind);
    expect(read(rule.trim())).toEqual(["no-amend-pushed"]);
    expect(read("- push 済みのコミットを amend しない")).toEqual(["no-amend-pushed"]);
    // other rules on the same line survive; the opposite order is not this rule
    expect(read("- Never `git push --force` or amend a commit that has already been pushed.").sort()).toEqual([
      "forbidden-cmd",
      "no-amend-pushed",
    ]);
    expect(read("- Never push after amending a commit that has not been reviewed yet.")).toEqual([]);
  });

  it("does not judge an amend after HEAD moved to another commit", () => {
    commitClaudeMd(rule, Date.now() - 3 * DAY);
    const t = Date.now() - DAY;
    session("s1", repo, [
      { bash: "git commit -m a && git push", at: t },
      { bash: "git switch -c other && git cherry-pick abc123", at: t + 100 },
      { bash: "git commit --amend -m fixed", at: t + 200 },
    ]);
    expect(verdictOf("no-amend-pushed")?.violations ?? []).toHaveLength(0);
  });

  it("flags an amend right after a push, also across sessions, but not after a new commit", () => {
    commitClaudeMd(rule, Date.now() - 3 * DAY);
    const t = Date.now() - DAY;
    session("s1", repo, [
      { bash: "git commit -m a && git push", at: t },
      { bash: "git commit --amend --no-edit", at: t + 100 },
    ]);
    session("s2", repo, [
      { bash: "git push origin main", at: t + 200 },
      { bash: "git commit -m b", at: t + 300 },
      { bash: "git commit --amend -m b2", at: t + 400 },
    ]);
    session("s3", repo, [{ bash: "git push -u origin main", at: t + 500 }]);
    session("s4", repo, [{ bash: "git commit --amend --no-edit", at: t + 600 }]);
    const r = verdictOf("no-amend-pushed");
    expect(r?.verdict).toBe("violated");
    expect(r?.violations.map((v) => v.sessionId)).toEqual(["s1", "s4"]);
  });
});

describe("protected paths", () => {
  it("reads path rules, not commands or usage notes", () => {
    const read = (line: string) =>
      extractRulesFromText(line, "CLAUDE.md", null, 0).rules.map((r) => `${r.kind}:${r.value ?? ""}`);
    expect(read("- Never edit `dist/` by hand.")).toEqual(["protected-path:dist/"]);
    expect(read("- `*.lock` を手で書き換えない")).toEqual(["protected-path:*.lock"]);
    expect(read("- Do not modify files in `apps/api/prisma/migrations/`.")).toEqual([
      "protected-path:apps/api/prisma/migrations/",
    ]);
    expect(read("- Use `src/lib/http.ts` for all requests.")).toEqual([]);
    expect(read("- Never run `git push --force`.")).toEqual(["forbidden-cmd:git push --force"]);
  });

  it("matches folders, globs and bare file names", async () => {
    const { matchesPath } = await import("../src/check.js");
    expect(matchesPath("dist/index.js", "dist/")).toBe(true);
    expect(matchesPath("src/dist.ts", "dist/")).toBe(false);
    expect(matchesPath("a/b/yarn.lock", "*.lock")).toBe(true);
    expect(matchesPath("pnpm-lock.yaml", "*.lock")).toBe(false);
    expect(matchesPath("src/gen/a/b.ts", "src/gen/**")).toBe(true);
    expect(matchesPath("package-lock.json", "package-lock.json")).toBe(true);
    expect(matchesPath("Dist/a.js", "dist/", true)).toBe(false);
    expect(matchesPath("Dist/a.js", "dist/", false)).toBe(true);
  });

  it("does not read 'may edit …, but never commit' as a ban on editing", () => {
    const read = (line: string) =>
      extractRulesFromText(line, "CLAUDE.md", null, 0).rules.map((r) => `${r.kind}:${r.value ?? ""}`);
    expect(read("- You may hand-edit `dist/` locally for testing, but never commit those changes without review.")).toEqual([]);
    // the recommended command in the other clause is not forbidden
    expect(read("- Don't hand-edit `package-lock.json`; run `npm install` instead to regenerate it.")).toEqual([
      "protected-path:package-lock.json",
    ]);
  });

  it("checks folder patterns from the global CLAUDE.md against the file's repository", () => {
    const global = path.join(home, ".claude", "CLAUDE.md");
    mkdirSync(path.dirname(global), { recursive: true });
    writeFileSync(global, "- Never edit `dist/` by hand.\n");
    const old = new Date(Date.now() - 3 * DAY);
    utimesSync(global, old, old);
    session("s1", repo, [{ tool: "Write", file: path.join(repo, "dist", "a.js"), at: Date.now() - DAY }]);
    expect(verdictOf("protected-path")?.verdict).toBe("violated");
  });

  it("flags an edit inside a protected folder", () => {
    commitClaudeMd("- Never edit `dist/` by hand.\n", Date.now() - 3 * DAY);
    session("s1", repo, [
      { tool: "Edit", file: path.join(repo, "src", "a.ts"), at: Date.now() - DAY },
      { tool: "Write", file: path.join(repo, "dist", "a.js"), at: Date.now() - DAY + 100 },
    ]);
    const r = verdictOf("protected-path");
    expect(r?.verdict).toBe("violated");
    expect(r?.violations).toHaveLength(1);
  });
});

describe("rule text", () => {
  it("shows the sentence that holds the rule, not the start of the line", () => {
    const { rules } = extractRulesFromText(
      [
        "2. Commit there, push, and open a PR against `main`. Don't merge it yourself. The user reviews and merges.",
        "- **Always work in a git worktree, never in the main checkout.** Other sessions may be working here.",
        "- Never read `.env` files. Secrets live in the vault.",
      ].join("\n"),
      "CLAUDE.md",
      null,
      0,
    );
    expect(rules.map((r) => r.text)).toEqual([
      "Don't merge it yourself.",
      "Always work in a git worktree, never in the main checkout.",
      "Never read `.env` files.",
    ]);
  });
});

describe("rules command", () => {
  it("lists rule-like lines but not descriptions", () => {
    const { uncheckable } = extractRulesFromText(
      [
        "- Each worker is wrapped so a failure never aborts the scan.",
        "- Non-WordPress sites get a placeholder score. Don't let empty findings produce a score of 100.",
        "- Always reply in Japanese.",
        "- 検証は必ず `origin/develop` 基準で行う。",
        "- The dashboard lives in apps/web.",
      ].join("\n"),
      "CLAUDE.md",
      null,
      0,
    );
    expect(uncheckable.map((u) => u.line)).toEqual([2, 3, 4]);
  });

  it("gives a rewrite hint for commands written without backticks", async () => {
    const { hintFor } = await import("../src/rulesCmd.js");
    expect(hintFor({ text: "Never git push --force to main", file: "x", line: 1 })).toContain("`git push --force to main`");
    expect(hintFor({ text: "Always keep the tests green for every commit you make", file: "x", line: 1 })).toContain(
      "Run the tests before committing",
    );
    expect(hintFor({ text: "Keep functions small", file: "x", line: 1 })).toContain("judgement");
  });

  it("prints checked and not-checked rules for a directory", async () => {
    commitClaudeMd("- Never run `git push --force`.\n- Always reply in Japanese.\n", Date.now() - DAY);
    const { renderRules } = await import("../src/rulesCmd.js");
    const out = renderRules(repo);
    expect(out).toContain("✓ checked (1)");
    expect(out).toContain("never runs `git push --force`");
    expect(out).toContain("· not checked (1)");
    expect(out).toContain("Always reply in Japanese.");
  });
});

describe("shell lexing", () => {
  it("ignores quoted strings and heredoc bodies", () => {
    const quoted = splitCommands(`grep "a && git push --force" notes.md`);
    expect(quoted).toHaveLength(1);
    expect(quoted[0].startsWith("grep ")).toBe(true);
    expect(splitCommands("cat <<EOF > x\ngit push --force\nEOF\nls")).toEqual(["cat  > x", "ls"]);
    expect(splitCommands("cd a && git status; npm test | tail -1")).toEqual(["cd a", "git status", "npm test", "tail -1"]);
    expect(splitCommands("timeout 600 npx vitest run --pool=threads")).toEqual(["npx vitest run --pool=threads"]);
  });

  it("follows git global options and variable-based cd", async () => {
    const { commandsWithCwd } = await import("../src/shell.js");
    const [c] = commandsWithCwd("git -c core.hooksPath=/dev/null commit --no-verify -m x", "/repo");
    expect(c.text).toBe("git commit --no-verify -m x");
    const cmds = commandsWithCwd('$wt="/work/wt"\nSet-Location "$wt/apps"; npm test', "/repo");
    expect(cmds.map((x) => [x.text, x.cwd.replace(/\\/g, "/").replace(/^[A-Z]:/, "")])).toEqual([["npm test", "/work/wt/apps"]]);
  });
});

describe("checking sessions", () => {
  it("never judges actions taken before the rule was written", () => {
    const t0 = Date.now() - 2 * DAY;
    commitClaudeMd("- Never run `git push --force`.\n", t0 + 60_000);
    session("s1", repo, [
      { bash: "git push --force", at: t0 },
      { bash: "git status", at: t0 + 120_000 },
    ]);
    expect(verdictOf("forbidden-cmd")?.verdict).toBe("followed");

    session("s2", repo, [{ bash: "git push --force origin main", at: t0 + 180_000 }]);
    const r = verdictOf("forbidden-cmd");
    expect(r?.verdict).toBe("violated");
    expect(r?.violations).toHaveLength(1);
  });

  it("does not count quoted text as a command", () => {
    commitClaudeMd("- Never run `git push --force`.\n", Date.now() - 3 * DAY);
    session("s1", repo, [{ bash: `grep -n "git push --force" docs/*.md`, at: Date.now() - DAY }]);
    expect(verdictOf("forbidden-cmd")?.verdict).toBe("followed");
  });

  it("keeps a violation when the user had just forbidden it", () => {
    commitClaudeMd("- Never run `git push --force`.\n", Date.now() - 3 * DAY);
    session("s1", repo, [
      { user: "Do not force push to this remote.", at: Date.now() - DAY },
      { bash: "git push --force", at: Date.now() - DAY + 1000 },
    ]);
    expect(verdictOf("forbidden-cmd")?.verdict).toBe("violated");
  });

  it("follows cd and git -C to the directory a command really runs in", () => {
    commitClaudeMd("- Always work in a git worktree, never in the main checkout.\n", Date.now() - 3 * DAY);
    const wt = path.join(home, "repo-wt2");
    git(["worktree", "add", "-q", "-b", "f2", wt], repo);
    writeFileSync(path.join(wt, "CLAUDE.md"), readFileSync(path.join(repo, "CLAUDE.md")));
    session("s1", wt, [{ bash: `git -C "${repo}" commit -m x`, at: Date.now() - DAY }]);
    expect(run().results.some((r) => r.rule.kind === "worktree-only" && r.verdict === "violated")).toBe(true);
  });

  it("checks PowerShell tool commands too", () => {
    commitClaudeMd("- Never read `.env` files.\n", Date.now() - 3 * DAY);
    const dir = path.join(projects, encodeProjectDir(repo));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "ps.jsonl"),
      JSON.stringify({
        sessionId: "ps",
        cwd: repo,
        timestamp: new Date(Date.now() - DAY).toISOString(),
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "PowerShell", input: { command: "Get-Content .env.local" } }] },
      }) + "\n",
    );
    expect(verdictOf("no-env")?.verdict).toBe("violated");
  });

  it("marks actions the user just asked for as unclear, not violations", () => {
    commitClaudeMd("- Open a PR. Don't merge it yourself.\n", Date.now() - 3 * DAY);
    session("s1", repo, [
      { user: "Looks good, please merge it now", at: Date.now() - DAY },
      { bash: "gh pr merge 12 --squash", at: Date.now() - DAY + 1000 },
    ]);
    expect(verdictOf("forbidden-cmd", "gh pr merge")?.verdict).toBe("unclear");
  });

  it("ignores subagent transcripts", () => {
    commitClaudeMd("- Never run `git push --force`.\n", Date.now() - 3 * DAY);
    session("s1", repo, [{ bash: "git push --force", at: Date.now() - DAY }], { sidechain: true });
    session("s2", repo, [{ bash: "git status", at: Date.now() - DAY }]);
    expect(verdictOf("forbidden-cmd")?.verdict).toBe("followed");
  });

  it("detects .env reads but not .env.example", () => {
    commitClaudeMd("- Never read `.env` files.\n", Date.now() - 3 * DAY);
    session("s1", repo, [
      { tool: "Read", file: path.join(repo, ".env.example"), at: Date.now() - DAY },
      { bash: "cat .env.example", at: Date.now() - DAY },
    ]);
    expect(verdictOf("no-env")?.verdict).toBe("followed");
    session("s2", repo, [{ tool: "Read", file: path.join(repo, ".env.local"), at: Date.now() - DAY }]);
    expect(verdictOf("no-env")?.verdict).toBe("violated");
  });

  it("detects the wrong package manager", () => {
    commitClaudeMd("- Use pnpm for everything.\n", Date.now() - 3 * DAY);
    session("s1", repo, [{ bash: "pnpm install && npx vitest run", at: Date.now() - DAY }]);
    expect(verdictOf("package-manager")?.verdict).toBe("followed");
    session("s2", repo, [{ bash: "npm install lodash", at: Date.now() - DAY }]);
    expect(verdictOf("package-manager")?.verdict).toBe("violated");
  });

  it("allows work in linked worktrees but flags the main checkout", () => {
    commitClaudeMd("- Always work in a git worktree, never in the main checkout.\n", Date.now() - 3 * DAY);
    const wt = path.join(home, "repo-wt");
    git(["worktree", "add", "-q", "-b", "feature", wt], repo);
    writeFileSync(path.join(wt, "CLAUDE.md"), readFileSync(path.join(repo, "CLAUDE.md")));
    session("s1", wt, [
      { bash: "git commit -m x", at: Date.now() - DAY },
      { tool: "Edit", file: path.join(wt, "src.ts"), at: Date.now() - DAY },
    ]);
    expect(verdictOf("worktree-only")?.verdict).toBe("followed");
    session("s2", repo, [{ tool: "Write", file: path.join(repo, "src.ts"), at: Date.now() - DAY }]);
    expect(run().results.some((r) => r.rule.kind === "worktree-only" && r.verdict === "violated")).toBe(true);
  });

  it("reports changes made where the project rules were not loaded, but not other worktrees", () => {
    commitClaudeMd("- Never run `git push --force`.\n", Date.now() - 3 * DAY);
    const start = path.join(home, "elsewhere");
    mkdirSync(start);
    const wt = path.join(home, "repo-wt3");
    git(["worktree", "add", "-q", "-b", "f3", wt], repo);
    session("s1", start, [
      { tool: "Write", file: path.join(repo, "a.ts"), at: Date.now() - DAY },
      { bash: `cd "${repo}" && git commit -m x`, at: Date.now() - DAY + 100 },
      { tool: "Read", file: path.join(repo, "b.ts"), at: Date.now() - DAY + 200 },
    ]);
    session("s2", repo, [{ tool: "Write", file: path.join(wt, "c.ts"), at: Date.now() - DAY }]);
    const u = run().unloaded;
    expect(u).toHaveLength(1);
    expect(u[0].actions).toBe(2); // the write and the commit; reads are not counted
    expect(u[0].sessions).toBe(1);
  });

  it("still reports a sibling project when both share an ancestor CLAUDE.md (CTO review)", () => {
    const work = path.join(home, "work");
    const projA = path.join(work, "projA");
    const projB = path.join(work, "projB");
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });
    writeFileSync(path.join(work, "CLAUDE.md"), "- Never run `rm -rf /`.\n");
    writeFileSync(path.join(projB, "CLAUDE.md"), "- Never run `git push --force`.\n");
    session("s1", projA, [{ tool: "Write", file: path.join(projB, "x.ts"), at: Date.now() - DAY }]);
    const u = run().unloaded;
    expect(u.map((x) => path.basename(x.dir))).toEqual(["projB"]);
  });

  it("reports sessions that started where no rule file exists", () => {
    const elsewhere = path.join(home, "scratch");
    mkdirSync(elsewhere);
    session("s1", elsewhere, [{ bash: "ls", at: Date.now() - DAY }]);
    expect(run().sessionsWithoutRules.map((s) => s.cwd)).toEqual([elsewhere]);
  });
});

describe("hook and install (CLI)", () => {
  function cli(args: string[], stdin?: string) {
    return spawnSync(process.execPath, [CLI, ...args], {
      input: stdin ?? "",
      encoding: "utf8",
      env: { ...process.env, RULENUDGE_PROJECTS_DIR: projects, RULENUDGE_HOME: home },
      timeout: 15_000,
    });
  }

  it("reminds once per violation and stays quiet for non-startup sources", () => {
    commitClaudeMd("- Never run `git push --force`.\n", Date.now() - 3 * DAY);
    session("s1", repo, [{ bash: "git push --force", at: Date.now() - DAY }]);
    const input = JSON.stringify({ cwd: repo, source: "startup", session_id: "new" });

    const first = cli(["hook"], input);
    expect(first.status).toBe(0);
    const out = JSON.parse(first.stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain("git push --force");

    const second = JSON.parse(cli(["hook"], input).stdout);
    expect(second.hookSpecificOutput).toBeUndefined();
    expect(second.systemMessage).toContain("no new violations");

    const resume = cli(["hook"], JSON.stringify({ cwd: repo, source: "resume" }));
    expect(resume.status).toBe(0);
    expect(resume.stdout).toBe("");
    expect(existsSync(path.join(home, ".rulenudge", "hook.lock"))).toBe(false);
  });

  it("statusline shows the broken count, serves the cache, and leaves no lock", () => {
    commitClaudeMd("- Never run `git push --force`.\n", Date.now() - 3 * DAY);
    const input = JSON.stringify({ workspace: { project_dir: repo, current_dir: repo } });

    expect(cli(["statusline"], input).stdout).toBe("");
    expect(cli(["statusline", "--always"], JSON.stringify({ cwd: repo })).stdout.trim()).toBe("📏 ok");

    session("s1", repo, [{ bash: "git push --force", at: Date.now() - DAY }]);
    // cached result (fresh for 60s) is served as-is
    expect(cli(["statusline"], input).stdout).toBe("");
    const refreshed = spawnSync(process.execPath, [CLI, "statusline"], {
      input,
      encoding: "utf8",
      env: { ...process.env, RULENUDGE_PROJECTS_DIR: projects, RULENUDGE_HOME: home, RULENUDGE_STATUS_FRESH_MS: "0" },
    });
    expect(refreshed.stdout.trim()).toBe("📏 1 broken");

    const status = JSON.parse(readFileSync(path.join(home, ".rulenudge", "status.json"), "utf8"));
    expect(status.version).toBe(1);
    expect(Object.values(status.projects)).toEqual([expect.objectContaining({ broken: 1, rules: 1 })]);
    expect(existsSync(path.join(home, ".rulenudge", "status.lock"))).toBe(false);
  });

  it("installs the hook without touching other settings, idempotently", () => {
    const settings = path.join(home, ".claude", "settings.json");
    writeFileSync(settings, JSON.stringify({ model: "x", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo" }] }] } }));
    expect(cli(["install-hook"]).status).toBe(0);
    expect(cli(["install-hook"]).stdout).toContain("already installed");
    const s = JSON.parse(readFileSync(settings, "utf8"));
    expect(s.model).toBe("x");
    expect(s.hooks.Stop).toHaveLength(1);
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(existsSync(settings + ".rulenudge-backup")).toBe(true);

    expect(cli(["uninstall-hook"]).status).toBe(0);
    const after = JSON.parse(readFileSync(settings, "utf8"));
    expect(after.hooks.SessionStart).toBeUndefined();
    expect(after.hooks.Stop).toHaveLength(1);
  });
});
