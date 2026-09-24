// Git helpers with per-path caching (git calls are the slow part).

import { execFileSync } from "node:child_process";
import path from "node:path";

export interface RepoInfo {
  /** Main worktree root (normalized, forward slashes). */
  main: string;
  /** Linked worktree roots. */
  linked: string[];
}

const cache = new Map<string, RepoInfo | null>();

export function norm(p: string): string {
  return path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function isUnder(child: string, parent: string): boolean {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + "/");
}

export function repoInfo(dir: string): RepoInfo | null {
  const key = norm(dir);
  if (cache.has(key)) return cache.get(key)!;
  let info: RepoInfo | null = null;
  try {
    const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const roots = out
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length).trim());
    if (roots.length) info = { main: roots[0], linked: roots.slice(1) };
  } catch {
    info = null;
  }
  cache.set(key, info);
  return info;
}

/** Is `p` inside the main checkout (and not inside a linked worktree nested in it)? */
export function inMainCheckout(p: string, repo: RepoInfo): boolean {
  if (!isUnder(p, repo.main)) return false;
  return !repo.linked.some((w) => isUnder(p, w));
}
