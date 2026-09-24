// Add / remove the SessionStart hook in ~/.claude/settings.json.
// Always writes a backup first and leaves every other setting untouched.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const COMMAND = "rulenudge hook";

interface HookEntry {
  matcher?: string;
  hooks?: { type?: string; command?: string; timeout?: number }[];
}

function settingsPath(): string {
  return path.join(process.env.RULENUDGE_HOME ?? homedir(), ".claude", "settings.json");
}

function load(): Record<string, unknown> {
  const p = settingsPath();
  if (!existsSync(p)) return {};
  const raw = readFileSync(p, "utf8");
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`${p} is not valid JSON. Fix it first, then run this again.`);
  }
}

function save(settings: Record<string, unknown>): string | null {
  const p = settingsPath();
  mkdirSync(path.dirname(p), { recursive: true });
  let backup: string | null = null;
  if (existsSync(p)) {
    backup = `${p}.rulenudge-backup`;
    copyFileSync(p, backup);
  }
  writeFileSync(p, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return backup;
}

function isOurs(entry: HookEntry): boolean {
  return (entry.hooks ?? []).some((h) => (h.command ?? "").includes(COMMAND));
}

function onPath(): boolean {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", ["rulenudge"], {
    stdio: "ignore",
    windowsHide: true,
  });
  return r.status === 0;
}

export function installHook(): void {
  const settings = load();
  const hooks = (settings.hooks ?? {}) as Record<string, HookEntry[]>;
  const list = hooks.SessionStart ?? [];
  if (list.some(isOurs)) {
    console.log("rulenudge: the SessionStart hook is already installed.");
    return;
  }
  list.push({ matcher: "startup", hooks: [{ type: "command", command: COMMAND, timeout: 10 }] });
  hooks.SessionStart = list;
  settings.hooks = hooks;
  const backup = save(settings);
  console.log(`rulenudge: added a SessionStart hook to ${settingsPath()}`);
  if (backup) console.log(`           backup: ${backup}`);
  if (!onPath()) {
    console.log("");
    console.log("  The hook runs `rulenudge hook`, but `rulenudge` is not on your PATH.");
    console.log("  Install it globally:  npm i -g rulenudge");
  }
  console.log("  From the next Claude Code session, broken rules are reminded at startup.");
}

export function uninstallHook(): void {
  const settings = load();
  const hooks = (settings.hooks ?? {}) as Record<string, HookEntry[]>;
  const list = hooks.SessionStart ?? [];
  const kept = list.filter((e) => !isOurs(e));
  if (kept.length === list.length) {
    console.log("rulenudge: no rulenudge hook found.");
    return;
  }
  if (kept.length) hooks.SessionStart = kept;
  else delete hooks.SessionStart;
  if (Object.keys(hooks).length) settings.hooks = hooks;
  else delete settings.hooks;
  const backup = save(settings);
  console.log(`rulenudge: removed the SessionStart hook from ${settingsPath()}`);
  if (backup) console.log(`           backup: ${backup}`);
}
