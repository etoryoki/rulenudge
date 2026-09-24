// SessionStart hook: tell Claude about rules broken since it was last told.
// Must be fast, never hang, never pile up (lessons from koji-lens statusline):
// single-instance lock, hard time limit, explicit exit on every path.

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { renderNudge } from "./report.js";
import { refreshStatus, stateDir } from "./status.js";

const HARD_LIMIT_MS = 8_000;
const MAX_REMEMBERED = 1000;

let releaseLock: (() => void) | null = null;

/** The only way out: release the lock, flush, exit. (process.exit skips finally blocks.) */
function exit(output?: object): never {
  releaseLock?.();
  if (output) process.stdout.write(JSON.stringify(output) + "\n");
  process.exit(0);
}

function readStdin(timeoutMs: number): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let buf = "";
    const done = () => {
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve(buf);
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c: string) => (buf += c));
    process.stdin.on("end", done);
    process.stdin.on("error", done);
    setTimeout(done, timeoutMs).unref();
  });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function acquireLock(): (() => void) | null {
  const lock = path.join(stateDir(), "hook.lock");
  mkdirSync(stateDir(), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, "wx");
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      closeSync(fd);
      return () => {
        try {
          const { pid } = JSON.parse(readFileSync(lock, "utf8")) as { pid: number };
          if (pid === process.pid) unlinkSync(lock);
        } catch {
          /* already gone */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return null;
      try {
        const { pid, at } = JSON.parse(readFileSync(lock, "utf8")) as { pid: number; at: number };
        if (Date.now() - at < HARD_LIMIT_MS + 5_000 && isPidAlive(pid)) return null;
      } catch {
        /* unreadable lock = stale */
      }
      try {
        unlinkSync(lock);
      } catch {
        /* someone else removed it */
      }
    }
  }
  return null;
}

interface State {
  notified: Record<string, number>;
}

function loadState(): State {
  try {
    return JSON.parse(readFileSync(path.join(stateDir(), "state.json"), "utf8")) as State;
  } catch {
    return { notified: {} };
  }
}

function saveState(state: State): void {
  const entries = Object.entries(state.notified).sort((a, b) => b[1] - a[1]).slice(0, MAX_REMEMBERED);
  const file = path.join(stateDir(), "state.json");
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ notified: Object.fromEntries(entries) }));
    renameSync(tmp, file);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

export async function runHook(): Promise<never> {
  setTimeout(() => exit(), HARD_LIMIT_MS);
  let input: { cwd?: string; source?: string; session_id?: string } = {};
  try {
    input = JSON.parse((await readStdin(1_000)) || "{}");
  } catch {
    /* no or invalid stdin */
  }
  if (input.source && input.source !== "startup") exit();
  const cwd = input.cwd ?? process.cwd();

  releaseLock = acquireLock();
  if (!releaseLock) exit();
  try {
    // also records the per-project count read by statuslines
    const { result } = refreshStatus(cwd, input.session_id);
    const state = loadState();
    const fresh = result.results
      .filter((r) => r.verdict === "violated")
      .map((r) => ({
        ...r,
        violations: r.violations.filter((v) => !state.notified[`${r.rule.file}|${r.rule.line}|${v.sessionId}|${v.ts}`]),
      }))
      .filter((r) => r.violations.length > 0);

    if (!fresh.length) {
      if (!result.results.length) exit();
      exit({ systemMessage: `rulenudge: ${result.results.length} checkable rule(s), no new violations.` });
    }
    for (const r of fresh) {
      for (const v of r.violations) state.notified[`${r.rule.file}|${r.rule.line}|${v.sessionId}|${v.ts}`] = Date.now();
    }
    saveState(state);
    exit({
      systemMessage: `rulenudge: reminded Claude of ${fresh.length} broken CLAUDE.md rule(s).`,
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: renderNudge(fresh) },
    });
  } catch {
    exit(); // never block session start; exit() releases the lock
  }
}
