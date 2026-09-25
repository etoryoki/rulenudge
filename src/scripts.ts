// Package scripts: does `pnpm --filter api type-check` run `tsc --noEmit`?
// Scripts are resolved per package — in a monorepo, `build` in one package may run tsc
// while `build` in another only runs webpack.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { isUnder, norm } from "./git.js";
import { unquote } from "./shell.js";

export interface Pkg {
  dir: string;
  name: string;
  scripts: Record<string, string>;
  /** names of everything it depends on (dependencies, devDependencies, peerDependencies) */
  deps: string[];
  /** where its tsconfig files point (`references`, `paths`): checked by its tsc too */
  tsRefs: TsRef[];
}

// A folder a tsconfig points at. A wildcard path keeps its alias:
// "@x/*": ["../../libs/*/src"] can reach every package in libs.
interface TsRef {
  dir: string;
  wildcard?: { alias: string; target: string };
}

/** tsconfig allows comments and trailing commas. */
function readJsonc(file: string): unknown {
  const text = readFileSync(file, "utf8")
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith('"') ? m : ""))
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(text);
}

interface TsConfig {
  extends?: string | string[];
  references?: { path?: string }[];
  compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
}

/**
 * `paths` of a tsconfig, following `extends` (relative ones, a few levels): the nearest config
 * that sets `paths` wins, and its entries resolve against its own folder / baseUrl.
 */
function pathsOf(file: string, depth = 0): { base: string; paths: Record<string, string[]> } | null {
  let cfg: TsConfig;
  try {
    cfg = readJsonc(file) as TsConfig;
  } catch {
    return null;
  }
  const dir = path.dirname(file);
  if (cfg.compilerOptions?.paths) {
    return { base: path.resolve(dir, cfg.compilerOptions.baseUrl ?? "."), paths: cfg.compilerOptions.paths };
  }
  if (depth >= 4) return null;
  const parents = Array.isArray(cfg.extends) ? [...cfg.extends].reverse() : cfg.extends ? [cfg.extends] : [];
  for (const e of parents) {
    if (!e.startsWith(".")) continue; // package configs (@tsconfig/node20) have no workspace paths
    const f = path.resolve(dir, e.endsWith(".json") ? e : `${e}.json`);
    const hit = pathsOf(f, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** Where the package's tsconfig*.json files point: references and paths (through extends). */
function tsconfigRefs(dir: string): TsRef[] {
  const out: TsRef[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /^tsconfig.*\.json$/i.test(f));
  } catch {
    return out;
  }
  for (const f of files) {
    const file = path.join(dir, f);
    try {
      const cfg = readJsonc(file) as TsConfig;
      for (const r of cfg.references ?? []) if (r.path) out.push({ dir: path.resolve(dir, r.path) });
    } catch {
      continue;
    }
    const p = pathsOf(file);
    if (!p) continue;
    for (const [alias, targets] of Object.entries(p.paths)) {
      for (const t of targets) {
        if (t.includes("*") && alias.includes("*")) {
          out.push({ dir: path.resolve(p.base, t.replace(/\*.*$/, "")), wildcard: { alias, target: path.resolve(p.base, t) } });
        } else if (t) {
          out.push({ dir: path.resolve(p.base, t) });
        }
      }
    }
  }
  return out;
}

const importsCache = new Map<string, string[]>();

/** Import specifiers in the package's source files (skips node_modules, build output). */
function importsOf(dir: string): string[] {
  const k = norm(dir);
  const hit = importsCache.get(k);
  if (hit !== undefined) return hit;
  const found: string[] = [];
  let files = 0;
  const walk = (d: string) => {
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files > 5000) return;
      if (e.isDirectory()) {
        if (!/^(?:node_modules|dist|build|out|coverage|\..*)$/.test(e.name)) walk(path.join(d, e.name));
      } else if (/\.(?:[cm]?[jt]sx?|vue|svelte)$/.test(e.name)) {
        files++;
        try {
          for (const m of readFileSync(path.join(d, e.name), "utf8").matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)) {
            found.push(m[1]);
          }
        } catch {
          /* unreadable */
        }
      }
    }
  };
  walk(dir);
  importsCache.set(k, found);
  return found;
}

// Packages a wildcard path can reach that this package actually imports:
// "@x/*": ["../../libs/*/src"] covers libs/b only when the source imports "@x/b".
function importedThroughWildcard(pkgs: Pkg[], from: Pkg, ref: TsRef): Pkg[] {
  const w = ref.wildcard!;
  const [before] = w.target.split("*");
  const imports = importsOf(from.dir);
  return pkgs.filter((x) => {
    const rel = path.relative(before, x.dir).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
    const name = rel.split("/")[0];
    const spec = w.alias.replace("*", name);
    return imports.some((i) => i === spec || i.startsWith(`${spec}/`));
  });
}

const cache = new Map<string, Pkg[]>();

function readPkg(dir: string): Pkg | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
      name?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies });
    return { dir, name: pkg.name ?? path.basename(dir), scripts: pkg.scripts ?? {}, deps, tsRefs: tsconfigRefs(dir) };
  } catch {
    return null;
  }
}

/** Workspace globs from package.json `workspaces` or pnpm-workspace.yaml. */
function workspaceGlobs(root: string): string[] {
  const globs: string[] = [];
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      workspaces?: string[] | { packages?: string[] };
    };
    const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? []);
    globs.push(...ws);
  } catch {
    /* none */
  }
  try {
    const yaml = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
    let inPackages = false;
    for (const line of yaml.split(/\r?\n/)) {
      if (/^packages\s*:/.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages && /^\S/.test(line)) inPackages = false;
      const m = inPackages && line.match(/^\s*-\s*["']?([^"'#]+?)["']?\s*(?:#.*)?$/);
      if (m) globs.push(m[1].trim());
    }
  } catch {
    /* none */
  }
  return globs.filter((g) => !g.startsWith("!"));
}

/** Folders matching a workspace glob: `apps/*`, `packages/**`, `tools/cli`. */
function expand(root: string, glob: string): string[] {
  const parts = glob.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").split("/");
  let dirs = [root];
  for (const part of parts) {
    const next: string[] = [];
    for (const d of dirs) {
      if (part === "**") {
        // one or two levels are enough for workspace layouts
        next.push(d);
        for (const a of subdirs(d)) {
          next.push(a);
          next.push(...subdirs(a));
        }
      } else if (part.includes("*")) {
        const re = new RegExp(`^${part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
        next.push(...subdirs(d).filter((s) => re.test(path.basename(s))));
      } else {
        next.push(path.join(d, part));
      }
    }
    dirs = next;
  }
  return dirs;
}

function subdirs(d: string): string[] {
  try {
    return readdirSync(d, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith("."))
      .map((e) => path.join(d, e.name));
  } catch {
    return [];
  }
}

/** The checkout's root package and its workspace packages. */
export function packagesOf(root: string): Pkg[] {
  const k = norm(root);
  const hit = cache.get(k);
  if (hit) return hit;
  const pkgs: Pkg[] = [];
  const seen = new Set<string>();
  const add = (dir: string) => {
    if (seen.has(norm(dir)) || !existsSync(path.join(dir, "package.json"))) return;
    seen.add(norm(dir));
    const p = readPkg(dir);
    if (p) pkgs.push(p);
  };
  add(root);
  let globs = workspaceGlobs(root);
  // no declared workspaces: the usual folders
  if (!globs.length) globs = ["apps/*", "packages/*", "services/*", "libs/*", "modules/*", "infra/*"];
  for (const g of globs) for (const d of expand(root, g)) add(d);
  cache.set(k, pkgs);
  return pkgs;
}

const RUNNER = /^(?:npx|pnpx|bunx|(?:pnpm|npm|yarn)\s+(?:(?:-r|--recursive|--filter(?:=\S+|\s+\S+)|-F\s+\S+|-w|--workspace(?:=\S+|\s+\S+)?)\s+)*(?:exec|dlx)|yarn|node\s+\S*node_modules\S*[\\/](?=\S))\s*/i;

/** Does `text` run `cmd` itself: `tsc --noEmit -p x`, `npx tsc --noEmit`, `pnpm exec tsc --noEmit`? */
export function runsDirectly(text: string, cmd: string): boolean {
  const words = unquote(text).trim().replace(RUNNER, "").split(/\s+/);
  const want = cmd.split(/\s+/);
  const prog = (w: string) => w.replace(/^.*[\\/]/, "").replace(/\.(?:c?js|mjs|cmd|exe)$/i, "");
  return prog(words[0] ?? "") === prog(want[0]) && want.slice(1).every((w) => words.includes(w));
}

interface Call {
  script: string;
  /** which packages: "here" (the package of the cwd), "root", "all", or package filters */
  target: "here" | "root" | "all" | string[];
}

const BUILTIN = new Set(["install", "i", "add", "remove", "rm", "ci", "exec", "dlx", "publish", "pack", "link", "update", "up", "init", "create", "why", "ls", "list", "outdated", "audit", "config", "store", "import", "prune", "rebuild", "version", "info", "view", "login", "logout", "whoami", "cache"]);

/** Parse a package-manager / task-runner call to a script. */
export function parseCall(text: string): Call | null {
  const w = unquote(text).trim().split(/\s+/);
  const pm = w[0];
  const filters: string[] = [];
  let target: Call["target"] = "here";
  let i = 1;
  const takeFilter = (v: string | undefined) => {
    if (v) filters.push(v.replace(/^["']|["']$/g, ""));
  };
  if (pm === "turbo" || pm === "nx") {
    const rest = w.slice(1);
    for (let j = 0; j < rest.length; j++) {
      const f = rest[j].match(/^--filter(?:=(.+))?$/);
      if (f) takeFilter(f[1] ?? rest[++j]);
    }
    if (pm === "turbo") {
      const s = rest.filter((x) => !x.startsWith("-"))[rest[0] === "run" ? 1 : 0];
      return s ? { script: s, target: filters.length ? filters : "all" } : null;
    }
    // nx run-many -t build / nx run api:build / nx build api
    const t = rest.findIndex((x) => x === "-t" || x === "--target" || x.startsWith("--target="));
    if (rest[0] === "run-many" && t >= 0) {
      const s = rest[t].includes("=") ? rest[t].split("=")[1] : rest[t + 1];
      return s ? { script: s, target: "all" } : null;
    }
    if (rest[0] === "run" && rest[1]?.includes(":")) {
      const [proj, s] = rest[1].split(":");
      return { script: s, target: [proj] };
    }
    return null;
  }
  if (!/^(?:npm|pnpm|yarn|bun)$/.test(pm)) return null;
  // yarn workspace <pkg> <script> / yarn workspaces foreach [-A] run <script>
  if (pm === "yarn" && w[1] === "workspace" && w[2] && w[3]) {
    return { script: w[3] === "run" ? w[4] : w[3], target: [w[2]] };
  }
  if (pm === "yarn" && w[1] === "workspaces" && w[2] === "foreach") {
    const r = w.indexOf("run");
    return r > 0 && w[r + 1] ? { script: w[r + 1], target: "all" } : null;
  }
  let script: string | null = null;
  for (; i < w.length; i++) {
    const a = w[i];
    if (script === null && (a === "run" || a === "run-script")) continue;
    if (a === "-r" || a === "--recursive" || a === "--workspaces" || a === "-ws") target = "all";
    else if (a === "-w" && pm === "pnpm") target = "root";
    else if (a === "--workspace-root") target = "root";
    else if (a === "--filter" || a === "-F" || a === "--workspace" || (a === "-w" && pm === "npm")) takeFilter(w[++i]);
    else if (/^--(?:filter|workspace)=/.test(a)) takeFilter(a.split("=").slice(1).join("="));
    else if (a === "-C" || a === "--dir" || a === "--prefix") i++;
    else if (a.startsWith("-")) continue;
    else if (script === null) script = a;
    else if (a === "--") break;
  }
  if (!script || BUILTIN.has(script)) return null;
  if (filters.length) target = filters.some((f) => f === "*" || f === "**") ? "all" : filters;
  return { script, target };
}

function matchesFilter(p: Pkg, root: string, filter: string): boolean {
  const f = filter.replace(/^\.{3}|\.{3}$/g, "").replace(/^\.\//, "").replace(/\{|\}/g, "");
  const rel = path.relative(root, p.dir).replace(/\\/g, "/");
  const re = new RegExp(`^${f.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return re.test(p.name) || re.test(rel) || re.test(path.basename(p.dir));
}

function targets(pkgs: Pkg[], root: string, call: Call, cwd: string, from: Pkg | null): Pkg[] {
  if (call.target === "all") return pkgs.filter((p) => p.scripts[call.script] !== undefined);
  if (call.target === "root") return pkgs.filter((p) => norm(p.dir) === norm(root));
  if (Array.isArray(call.target)) {
    const list = call.target;
    return pkgs.filter((p) => list.some((f) => matchesFilter(p, root, f)));
  }
  // "here": the package the command runs in (a script calling another script: its own package)
  if (from) return [from];
  const inside = pkgs.filter((p) => isUnder(cwd, p.dir)).sort((a, b) => b.dir.length - a.dir.length);
  return inside.slice(0, 1);
}

/** The package that holds `p` (the deepest one), or null. */
export function packageOf(pkgs: Pkg[], p: string): Pkg | null {
  return pkgs.filter((x) => isUnder(p, x.dir)).sort((a, b) => b.dir.length - a.dir.length)[0] ?? null;
}

/**
 * Packages a check run in `dir` covers: the package there, every package below it, and the
 * workspace packages they depend on — in package.json or through tsconfig `references` /
 * `paths` (tsc in apps/api also checks the @x/types it imports).
 */
function coveredBy(pkgs: Pkg[], dir: string): string[] {
  const here = packageOf(pkgs, dir);
  const todo = pkgs.filter((x) => isUnder(x.dir, dir));
  if (here) todo.push(here);
  const byName = new Map(pkgs.map((x) => [x.name, x]));
  const out = new Set<string>();
  while (todo.length) {
    const p = todo.pop()!;
    if (out.has(norm(p.dir))) continue;
    out.add(norm(p.dir));
    for (const d of p.deps) {
      const dep = byName.get(d);
      if (dep) todo.push(dep);
    }
    // connected only through tsconfig (`references`, `paths`), without a package.json dependency
    // (a wildcard path reaches many packages: only the ones this package imports count)
    for (const ref of p.tsRefs) {
      const deps = ref.wildcard ? importedThroughWildcard(pkgs, p, ref) : [packageOf(pkgs, ref.dir)].filter((x): x is Pkg => !!x);
      for (const dep of deps) if (norm(dep.dir) !== norm(p.dir)) todo.push(dep);
    }
  }
  return [...out];
}

/** Does this package's script (through the scripts it calls) run `cmd`? Adds the covered packages. */
function scriptRuns(pkgs: Pkg[], root: string, pkg: Pkg, script: string, cmd: string, seen: Set<string>, out: Set<string>): boolean {
  const k = `${norm(pkg.dir)}|${script}`;
  if (seen.has(k)) return false;
  seen.add(k);
  const body = pkg.scripts[script];
  if (body === undefined) return false;
  let ran = false;
  for (const part of body.split(/&&|\|\||;/)) {
    const p = part.trim();
    if (runsDirectly(p, cmd)) {
      for (const d of coveredBy(pkgs, pkg.dir)) out.add(d);
      ran = true;
      continue;
    }
    const call = parseCall(p);
    if (!call) continue;
    for (const t of targets(pkgs, root, call, pkg.dir, pkg)) if (scriptRuns(pkgs, root, t, call.script, cmd, seen, out)) ran = true;
  }
  return ran;
}

/**
 * Does the command run the check, directly or through a package script? Returns the packages
 * it covered (normalized folders), or null when it is not a run of the check.
 */
export function checkCoverage(text: string, cmd: string, root: string, cwd: string): string[] | null {
  const pkgs = packagesOf(root);
  if (runsDirectly(text, cmd)) return coveredBy(pkgs, cwd);
  const call = parseCall(text);
  if (!call) return null;
  const out = new Set<string>();
  let ran = false;
  for (const t of targets(pkgs, root, call, cwd, null)) if (scriptRuns(pkgs, root, t, call.script, cmd, new Set(), out)) ran = true;
  return ran ? [...out] : null;
}

export function runsCheck(text: string, cmd: string, root: string, cwd: string): boolean {
  return checkCoverage(text, cmd, root, cwd) !== null;
}
