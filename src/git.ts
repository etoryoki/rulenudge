// Git helpers with per-path caching (git calls are the slow part).

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";

export interface RepoInfo {
  /** Main worktree root (normalized, forward slashes). */
  main: string;
  /** Linked worktree roots. */
  linked: string[];
}

const cache = new Map<string, RepoInfo | null>();

const realCache = new Map<string, string>();

/**
 * Canonical form of a path: symlinks and Windows short names resolved
 * (/var -> /private/var on macOS, RUNNER~1 -> runneradmin on Windows),
 * via the nearest existing ancestor when the path itself does not exist.
 */
function real(p: string): string {
  const abs = path.resolve(p);
  const hit = realCache.get(abs);
  if (hit) return hit;
  let result = abs;
  let dir = abs;
  const rest: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      result = path.join(realpathSync.native(dir), ...rest);
      break;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      rest.unshift(path.basename(dir));
      dir = parent;
    }
  }
  realCache.set(abs, result);
  return result;
}

export function norm(p: string): string {
  return real(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
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
