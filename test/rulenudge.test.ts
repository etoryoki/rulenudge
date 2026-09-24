import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
    expect(uncheckable.map((u) => u.text)).toEqual(["Never reply in English."]);
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

describe("shell lexing", () => {
  it("ignores quoted strings and heredoc bodies", () => {
    expect(splitCommands(`grep "git push --force" notes.md`)).toEqual(["grep _Q_ notes.md"]);
    expect(splitCommands("cat <<EOF > x\ngit push --force\nEOF\nls")).toEqual(["cat  > x", "ls"]);
    expect(splitCommands("cd a && git status; npm test | tail -1")).toEqual(["cd a", "git status", "npm test", "tail -1"]);
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
