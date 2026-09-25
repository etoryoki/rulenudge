# rulenudge

**Checks whether your CLAUDE.md rules were actually followed — not how they are written.**

Linters read your CLAUDE.md. rulenudge reads your Claude Code session logs and tells you which rules were broken, when, and by which command. Then it can remind Claude at the start of the next session.

```sh
npx rulenudge
```

```
  rulenudge — were your CLAUDE.md rules actually followed?

  Last 7 days · 42 sessions · 3120 tool calls

  5 checkable rule(s)
    ✓ followed         3
    ✗ broken           1
    ? unclear          1   (you had just asked for it)
    - not applicable   0   (rule added later, or no session ran under it)
    · not checkable    6   (needs judgement — not checked yet)

  ────────────────────────────────────────────────────────
  Broken rules
  ────────────────────────────────────────────────────────

  ✗ Never run `git push --force`.
    my-app/CLAUDE.md:12 · 2x in 2 session(s) · rule since 2026-09-10 14:02
      2026-09-21 18:44  git push --force origin feature/login
      2026-09-23 09:12  git push --force
```

Everything runs locally. Nothing is sent anywhere. No dependencies.

## Remind Claude at the start of each session

```sh
npm i -g rulenudge
rulenudge install-hook
```

This adds a `SessionStart` hook to `~/.claude/settings.json` (a backup is written first). When a new session starts in a project, rulenudge checks the earlier sessions there and, if a rule was broken, tells Claude:

```
[rulenudge] In earlier sessions in this project, these CLAUDE.md rules were broken:
1. "Never run `git push --force`." (my-app/CLAUDE.md:12) — 2026-09-23 09:12: git push --force
Follow these rules in this session. If the user explicitly asks for one of these actions, confirm with them first.
```

Each violation is reminded once. With no new violations, you only see one line (`no new violations`). Remove it with `rulenudge uninstall-hook`.

## See which rules are checked

```sh
npx rulenudge rules            # current directory
npx rulenudge rules --project ~/code/my-app
```

Lists every rule-like line in the CLAUDE.md / AGENTS.md files that apply to the directory: the ones rulenudge checks (and since when), and the ones it doesn't, with a hint — for example, a command written without backticks (`Never git push --force`) becomes checkable when written as ``Never run `git push --force` ``. Descriptions of how the code works are not listed.

## Show the count in your statusline

```json
"statusLine": { "type": "command", "command": "rulenudge statusline" }
```

Prints `📏 2 broken` for the current project when a checkable rule was broken in the last 7 days, and nothing otherwise (`--always` prints `📏 ok` too). It serves a cached result and lets only one process at a time refresh it, so it stays fast (~0.2 s) and never piles up processes.

Other statuslines can show the same count without running rulenudge: the result is kept in `~/.rulenudge/status.json`:

```json
{ "version": 1, "projects": { "<project dir, non-alphanumerics replaced by ->": { "at": 1790000000000, "broken": 2, "rules": 5 } } }
```

## What it can check

rulenudge only judges rules it can check without guessing. Everything else is counted as "not checkable" and left alone.

| Rule in CLAUDE.md / AGENTS.md | Broken when Claude… |
|---|---|
| `- Never run \`git push --force\`` (any negated bullet with a command in backticks) | runs that command |
| `- Don't merge PRs yourself` | runs `gh pr merge` |
| `- Never read \`.env\` files` | reads `.env`, `.env.local`, … (not `.env.example`) |
| `- Use pnpm` | installs with npm / yarn / bun |
| `- Always work in a git worktree, never in the main checkout` | edits files or runs `git switch/commit/reset/…` in the main checkout |
| ``- Never edit `dist/` `` / `` `*.lock` を手で書き換えない `` | edits or writes a file under that path with a file tool (Edit/Write). Folders (`dist/`), globs (`src/gen/**`, `*.lock`) and file names (`package-lock.json`) |
| `- Run the tests before committing` / ``- Never commit without running `pnpm test` `` | runs `git commit` after editing code in that repository without a test run since (npm/pnpm/yarn/bun test, vitest, jest, pytest, go test, cargo test, …). Docs-only changes, `--amend`, and repositories with no test command are skipped |

How it avoids false positives:

- **Rules are only applied after they were written.** rulenudge uses `git blame` to find when each line was added, so it never judges older sessions by a newer CLAUDE.md.
- **Quoted text is not a command.** `grep "git push --force" notes.md` does not count.
- **"You asked for it" is shown as unclear**, not as a violation — when your own last messages asked for that action (e.g. "please merge it"). A prohibition ("don't force push") never counts as asking.
- **Subagent transcripts are skipped**, and only files inside the project are judged.

It also lists sessions that started where no CLAUDE.md / AGENTS.md exists, so no project rules were loaded at all.

## Options

```
rulenudge [--days N] [--project DIR] [--json]
rulenudge install-hook | uninstall-hook
```

Exit code is `1` when a rule was broken (useful in scripts), `0` otherwise.

## Limitations

- Rules that need judgement ("reply in Japanese", "keep functions small") are not checked.
- "Unclear" means one of your last three messages mentioned that action (e.g. "merge", "push", the file name) in a sentence that was not a prohibition. A loosely related message can therefore turn a real violation into "unclear" — the evidence is always shown so you can judge.
- Commands inside quoted strings (`bash -c "git push --force"`, `"$(…)"`) are not inspected.
- Claude Code loads CLAUDE.md from the folder a session **started** in. When a session started in project A changes files or runs commits in project B, B's CLAUDE.md was never in Claude's context — rulenudge lists this under "Rules that were never loaded" instead of counting violations. (Other worktrees of the same repository carry the same CLAUDE.md and are treated as loaded.)
- "Test before commit" checks that tests ran. When the rule says they must **pass** ("make sure the tests pass before committing", "テストが通ってから"), a commit after a failed run also counts. The exit status belongs to the whole tool call, so a failure is only seen when the test is the last command of that call (`npm test | tail` or `npm test; git log` hide it, and such runs count as passed). A test run elsewhere (another session, CI) is not seen. In a monorepo, test scripts in `apps/*` / `packages/*` count as the repository's test setup.
- Package-manager rules are recognised in the form "Use pnpm" / "pnpm only". A sentence like "Don't use npm, use pnpm" is read as a prohibition and not checked.
- It reads Claude Code's local logs (`~/.claude/projects`). The log format is not a public API and may change.
- Node.js 20 or later.

## License

MIT
