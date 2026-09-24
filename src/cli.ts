#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HELP = `rulenudge — check whether your CLAUDE.md rules were actually followed

Usage:
  rulenudge [--days N] [--project DIR] [--json]   check recent Claude Code sessions
  rulenudge install-hook                          remind Claude of broken rules at session start
  rulenudge uninstall-hook                        remove the hook
  rulenudge hook                                  (used by the hook itself)

Options:
  --days N        how many days back to look (default 7)
  --project DIR   only sessions started in DIR (default: all projects)
  --json          machine-readable output

Everything runs locally. Nothing is sent anywhere.`;

function version(): string {
  const pkg = fileURLToPath(new URL("../package.json", import.meta.url));
  return (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version;
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd === "--help" || cmd === "-h" || cmd === "help") return void console.log(HELP);
  if (cmd === "--version" || cmd === "-v") return void console.log(version());
  if (cmd === "hook") {
    const { runHook } = await import("./hook.js");
    return void (await runHook());
  }
  if (cmd === "install-hook") return (await import("./install.js")).installHook();
  if (cmd === "uninstall-hook") return (await import("./install.js")).uninstallHook();
  if (cmd && !cmd.startsWith("-")) {
    console.error(`Unknown command: ${cmd}\n\n${HELP}`);
    process.exit(2);
  }

  const days = Number(arg(args, "--days") ?? 7);
  if (!Number.isFinite(days) || days <= 0) throw new Error("--days must be a positive number");
  const project = arg(args, "--project");
  const since = Date.now() - days * 86_400_000;

  const { readSessions, encodeProjectDir } = await import("./sessions.js");
  const { check } = await import("./check.js");
  const path = await import("node:path");
  const { events, sessions } = readSessions({
    since,
    projectFolders: project ? [encodeProjectDir(path.resolve(project))] : undefined,
  });
  const result = check(events, sessions, since);

  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const { renderReport } = await import("./report.js");
    console.log(renderReport(result, days));
  }
  process.exitCode = result.results.some((r) => r.verdict === "violated") ? 1 : 0;
}

main().catch((err) => {
  console.error(`rulenudge: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
