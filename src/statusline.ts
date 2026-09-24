// `rulenudge statusline`: print "📏 N broken" for the current project, or nothing.
// Claude Code calls statuslines on every update, so this must never pile up
// (lesson from koji-lens): serve the cached result, and let at most one
// process at a time refresh a stale cache.

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { readStatus, refreshStatus, stateDir } from "./status.js";

const FRESH_MS = Number(process.env.RULENUDGE_STATUS_FRESH_MS ?? 60_000);
const HARD_LIMIT_MS = 10_000;

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

function acquire(): (() => void) | null {
  const lock = path.join(stateDir(), "status.lock");
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
          /* gone */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return null;
      try {
        const { pid, at } = JSON.parse(readFileSync(lock, "utf8")) as { pid: number; at: number };
        if (Date.now() - at < HARD_LIMIT_MS + 5_000 && isPidAlive(pid)) return null;
      } catch {
        /* unreadable = stale */
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

let release: (() => void) | null = null;

function finish(text: string): never {
  release?.();
  process.stdout.write(text ? `${text}\n` : "");
  process.exit(0);
}

export function render(broken: number, always: boolean): string {
  if (broken > 0) return `📏 ${broken} broken`;
  return always ? "📏 ok" : "";
}

export async function runStatusline(args: string[]): Promise<never> {
  setTimeout(() => finish(""), HARD_LIMIT_MS);
  const always = args.includes("--always");
  let input: { cwd?: string; workspace?: { project_dir?: string; current_dir?: string } } = {};
  try {
    input = JSON.parse((await readStdin(500)) || "{}");
  } catch {
    /* no stdin */
  }
  const project = input.workspace?.project_dir ?? input.workspace?.current_dir ?? input.cwd ?? process.cwd();

  const cached = readStatus(project);
  if (cached && Date.now() - cached.at < FRESH_MS) finish(render(cached.broken, always));

  release = acquire();
  if (!release) finish(cached ? render(cached.broken, always) : "");
  try {
    const { status } = refreshStatus(project);
    finish(render(status.broken, always));
  } catch {
    finish(cached ? render(cached.broken, always) : "");
  }
}
