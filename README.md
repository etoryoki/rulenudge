# rulenudge

**Checks whether your CLAUDE.md rules were actually followed — not how they are written.**

Linters read your CLAUDE.md. rulenudge reads your Claude Code session logs and tells you which rules were broken, when, and by which command. Then it can remind Claude at the start of the next session.

**It does not stop anything. It tells you, and it tells Claude next time.** It is for one person using Claude Code who wants the same mistake not to happen twice:

- No model and no API key: a rule is judged only when the session log proves it, otherwise it is left as "not checkable"
- No dependencies, nothing leaves your machine
- Rules written in English or Japanese
- Checks the order of things, not just single commands ("run the tests before committing", "no amend after a push")

日本語の説明は [下にあります](#日本語)。

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

This adds a `SessionStart` hook to `~/.claude/settings.json` (if the file exists, a backup is written first). When a new session starts in a project, rulenudge checks the earlier sessions there and, if a rule was broken, tells Claude:

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
Rules can be written in English or Japanese (`〜しない`, `〜してはいけない`, `〜は禁止`, `〜は不採用`, …).

| Rule in CLAUDE.md / AGENTS.md | Broken when Claude… |
|---|---|
| `- Never run \`git push --force\`` (any negated bullet with a command in backticks) | runs that command |
| `- Never force-push` / `強制プッシュしない` | pushes with `--force`, `-f`, `--force-with-lease` or a `+branch` refspec. `--force-with-lease` is allowed when the line says so ("use `--force-with-lease` instead"), and is never counted for a rule written as `` `git push --force` `` |
| `- Never push directly to main` / `main に直接 push しない` | runs a push that names `main` (`git push origin main`, `HEAD:main`). A bare `git push` is not judged: the session log does not reliably say which branch was checked out, so "never commit to main" is left unchecked too |
| `- Don't merge PRs yourself` | runs `gh pr merge` |
| `- Never read \`.env\` files` | reads `.env`, `.env.local`, … (not `.env.example`) |
| `- Never commit \`.env\` files` | runs `git add` / `git commit` with a `.env` file (reading it is not a violation) |
| `- Use pnpm` / `- Use pnpm. Do not use npm or yarn.` | installs with npm / yarn / bun |
| `- Always work in a git worktree, never in the main checkout` | edits files or runs `git switch/commit/reset/…` in the main checkout |
| ``- Never edit `dist/` `` / `` `*.lock` を手で書き換えない `` | edits or writes a file under that path with a file tool (Edit/Write). Folders (`dist/`), globs (`src/gen/**`, `*.lock`) and file names (`package-lock.json`) |
| ``- Never create `.txt` files`` / ``生成ファイルは `.md` で保存（`.txt` は不採用）`` | writes a file with that extension with a file tool (Edit/Write) |
| `- Never amend a commit that was already pushed` / `push 済みのコミットを amend しない` | runs `git commit --amend` after a `git push` in that checkout with no new commit in between (tracked across sessions) |
| `- Write commit messages as Conventional Commits` / `コミットメッセージは英語で書く` | commits with a subject that is not `type(scope): …` (feat, fix, docs, chore, …) / that contains Japanese text. The message is read from `-m`, `-m "$(cat <<'EOF' …)"` and `-F - <<EOF`; merge, revert and fixup commits are skipped |
| ``- Run `pnpm lint` before pushing`` / ``push 前に `tsc --noEmit` `` | pushes (or commits) after editing code in that repository without running the command since. Package scripts that run it (`pnpm type-check` → `tsc --noEmit`) count, and so does a pre-push / pre-commit hook that runs it — unless hooks were skipped with `--no-verify` |
| `- Run the tests before committing` / ``- Never commit without running `pnpm test` `` | runs `git commit` after editing code in that repository without a test run since (npm/pnpm/yarn/bun test, vitest, jest, pytest, go test, cargo test, …). Docs-only changes, `--amend`, and repositories with no test command are skipped |

How it avoids false positives:

- **Rules are only applied after they were written.** rulenudge uses `git blame` to find when each line was added, so it never judges older sessions by a newer CLAUDE.md.
- **Quoted text is not a command.** `grep "git push --force" notes.md` does not count.
- **"You asked for it" is shown as unclear**, not as a violation — when your own last messages asked for that action (e.g. "please merge it"). A prohibition ("don't force push") never counts as asking.
- **Subagent transcripts are skipped**, and only files inside the project are judged.

It also lists sessions that started where no CLAUDE.md / AGENTS.md exists, so no project rules were loaded at all.

## Measured false positives

A checker that cries wolf twice stops being read, so false positives are treated as the main bug. These are real runs on the author's own session logs, and what changed:

| Check | Run | First result | After the fix |
|---|---|---|---|
| Rules added later | 14 days, ~3,550 tool calls | 37 violations, all from before the rule was written | 0 (each rule line is dated with `git blame`) |
| Test before commit | 14 days, 151 commits | 11 violations, all command forms it could not read (`git -c … commit`, `timeout 600 npx vitest run`, …) | 0 |
| Conditional prohibitions | "never … on main" read as "never …" | correct runs elsewhere reported | conditional sentences are "not checkable" |
| Japanese rules | 「メインのチェックアウト**では**」 read as a condition | the rule silently did nothing | judged per clause and bracket |
| Type check before push | 180 days, 215 pushes | 0 → 2 → 4 as the scope was widened (worktrees, per-package edits) | 1 real violation (a test file edited after the check, pushed with hooks skipped) |
| Main-checkout rule | 7 days in another project of the author's | `git merge-base` counted as `git merge` | 0 (fixed in 0.7.2, with `git commit-tree` and `git checkout-index`) |
| Rules written in words (0.8.1) | 297 public CLAUDE.md files from GitHub code search, every new rule read by hand | 122 new rules, 14 misread (`force push to main` as a ban on every force push, "the matching commit to main", "without asking first", a rule quoted inside another sentence, `use pnpm exec`); review found more ("…, unless it's a docs change", the branch Claude Code records lagging behind in worktrees) | 71 new rules, none misread; 3 rules 0.8.0 read (`use pnpm's --filter`, `corepack use pnpm@11`, `use pnpm scripts if available`) are now left unchecked, and 0.8.0's misreading of "Tests use bun's test runner" as "use bun" is gone. Exceptions anywhere in the sentence leave the rule unchecked; pushes are judged only by the branch named in the command |

Known misreadings (since 0.7): ``Don't use `npm`, use `pnpm`.`` reads both commands as forbidden — write it as `Use pnpm, not npm.` A line naming two managers (`Use pnpm or yarn.`, `Use npm for scripts, pnpm for installs.`) keeps only the first.

After these fixes, one real violation was left in the author's own logs. If rulenudge reports something a person looking at the same evidence would not call a violation, please [open an issue](https://github.com/etoryoki/rulenudge/issues).

## Options

```
rulenudge [--days N] [--project DIR] [--json]
rulenudge install-hook | uninstall-hook
```

Exit code is `1` when a rule was broken (useful in scripts), `0` otherwise.

## Limitations

- Rules that need judgement ("reply in Japanese", "keep functions small") are not checked.
- Rules limited to a branch or an environment ("never `git push --force` to main", "本番では `x` を実行しない") are listed as not checkable: the session log does not say which branch or environment a command ran against. "…in the main checkout" is checked, because the command's folder tells.
- "Run `x` before pushing" in a monorepo: edits are tracked per workspace package. A run of the check covers the packages it ran in and the workspace packages they depend on — through `package.json` (`dependencies`, `devDependencies`, `peerDependencies`) or tsconfig `references` / `paths` (followed through `extends`; a wildcard path such as `"@x/*"` counts only for the packages the source actually imports). Connections made some other way (a bundler alias, a relative import into another package) are not seen, so such a push can be reported although the check did look at them.
- "Unclear" means one of your last three messages mentioned that action (e.g. "merge", "push", the file name) in a sentence that was not a prohibition. A loosely related message can therefore turn a real violation into "unclear" — the evidence is always shown so you can judge.
- Commands inside quoted strings (`bash -c "git push --force"`, `"$(…)"`) are not inspected.
- Claude Code's documentation describes loading CLAUDE.md from the folder a session **started** in, the folders above it, folders below it when files there are read, and `~/.claude/CLAUDE.md`. It says nothing about a sibling project. When a session started in project A changes files or runs commits in project B, B's CLAUDE.md may not have been in Claude's context — the session log does not show which files were loaded — so rulenudge lists this under "Rules that may not have been loaded" instead of counting violations. (Other worktrees of the same repository carry the same CLAUDE.md and are treated as loaded.)
- "Test before commit" checks that tests ran. When the rule says they must **pass** ("make sure the tests pass before committing", "テストが通ってから"), a commit after a failed run also counts. The exit status belongs to the whole tool call, so a failure is only seen when the test is the last command of that call (`npm test | tail` or `npm test; git log` hide it, and such runs count as passed). A test run elsewhere (another session, CI) is not seen. In a monorepo, test scripts in `apps/*` / `packages/*` count as the repository's test setup.
- Package-manager rules are recognised in the form "Use pnpm" / "pnpm only". A sentence like "Don't use npm, use pnpm" is read as a prohibition and not checked.
- It reads Claude Code's local logs (`~/.claude/projects`). The log format is not a public API and may change.
- Node.js 20 or later.

## 日本語

CLAUDE.md（と AGENTS.md）のルールが、実際のセッションで守られたかを、Claude Code のセッション記録から点検します。破られたルールは、次のセッションの開始時に Claude 本人に知らせます。

- **止めません。知らせます。** Claude Code を 1 人で使う人が、同じ失敗を次の回に繰り返させないための道具です
- モデルも API キーも使いません。記録から確実に言えるものだけを判定し、判断が要るルールは「点検できない」として数だけ出します
- 依存パッケージなし。記録は手元で読むだけで、どこにも送りません
- 日本語のルールも読めます（「〜しない」「〜してはいけない」「〜は禁止」「〜は不採用」など）

```sh
npx rulenudge                 # 直近 7 日の点検
npm i -g rulenudge
rulenudge install-hook        # 次のセッションの開始時に知らせる（~/.claude/settings.json に追加。ファイルが既にあれば先にバックアップを作ります）
rulenudge rules               # どのルールが点検でき、どれができないか。点検できる書き方のヒントつき
```

点検できるルールの例:

| CLAUDE.md の書き方 | 違反になるのは |
|---|---|
| ``- `rm -rf` を実行しない`` | そのコマンドを実行したとき |
| `- 強制プッシュしない` | `--force`・`-f`・`--force-with-lease` などで push したとき |
| `- main に直接 push しない` | `main` を指定して push したとき（`git push origin main` など。ブランチを書かない `git push` は判定しない） |
| ``- `.env` をコミットしない`` | `.env` を `git add` / `git commit` したとき（読むだけなら違反にしない） |
| ``- 生成ファイルは `.md` で保存（`.txt` は不採用）`` | `.txt` のファイルを書いたとき |
| ``- `dist/` を手で書き換えない`` | そのフォルダのファイルを編集したとき |
| `- push 済みのコミットを amend しない` | push の後に、新しいコミットを挟まずに `git commit --amend` したとき |
| ``- push 前に `tsc --noEmit` `` | コードを編集してから、それを実行せずに push したとき |
| `- コミットメッセージは英語で書く` | 日本語を含むメッセージでコミットしたとき |

「main では〜しない」のように条件がついた文は、推測で判定せず「点検できない」に回します。誤検知を見つけたら [Issue](https://github.com/etoryoki/rulenudge/issues) で教えてください。

## License

MIT
