// Per-project result cache (~/.rulenudge/status.json).
// Written by the hook and the statusline command; read by statuslines
// (including other tools such as koji-lens) without running a check.
//
// Format (stable, other tools read it):
// { "version": 1, "projects": { "<encoded project dir>": { "at": ms, "broken": n, "rules": n } } }

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { check } from "./check.js";
import { encodeProjectDir, readSessions } from "./sessions.js";

export const LOOKBACK_MS = 7 * 86_400_000;

export interface ProjectStatus {
  at: number;
  broken: number;
  rules: number;
}

interface StatusFile {
  version: 1;
  projects: Record<string, ProjectStatus>;
}

export function stateDir(): string {
  return path.join(process.env.RULENUDGE_HOME ?? homedir(), ".rulenudge");
}

function statusPath(): string {
  return path.join(stateDir(), "status.json");
}

function load(): StatusFile {
  try {
    const f = JSON.parse(readFileSync(statusPath(), "utf8")) as StatusFile;
    if (f && typeof f.projects === "object") return f;
  } catch {
    /* missing or broken: start fresh */
  }
  return { version: 1, projects: {} };
}

export function readStatus(projectDir: string): ProjectStatus | null {
  return load().projects[encodeProjectDir(projectDir)] ?? null;
}

export function writeStatus(projectDir: string, status: ProjectStatus): void {
  const file = load();
  file.projects[encodeProjectDir(projectDir)] = status;
  mkdirSync(stateDir(), { recursive: true });
  const tmp = `${statusPath()}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(file));
    renameSync(tmp, statusPath());
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

/** Check one project's recent sessions and record the result. */
export function refreshStatus(projectDir: string, excludeSessionId?: string) {
  const since = Date.now() - LOOKBACK_MS;
  const { events, sessions } = readSessions({
    since,
    projectFolders: [encodeProjectDir(projectDir)],
    excludeSessionId,
  });
  const result = check(events, sessions, since);
  const status: ProjectStatus = {
    at: Date.now(),
    broken: result.results.filter((r) => r.verdict === "violated").length,
    rules: result.results.length,
  };
  writeStatus(projectDir, status);
  return { result, status };
}
