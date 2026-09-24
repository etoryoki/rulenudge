// Read Claude Code session logs (~/.claude/projects/<project>/<session>.jsonl).
// Subagent transcripts live in <session>/subagents/ and are skipped: they do not
// run with the parent's CLAUDE.md in the same way.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface ToolEvent {
  ts: number;
  sessionId: string;
  cwd: string;
  tool: string;
  input: Record<string, unknown>;
  /** The latest few human-typed messages in this session before the tool call. */
  lastUserText: string;
}

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  firstTs: number;
}

export function projectsDir(): string {
  return process.env.RULENUDGE_PROJECTS_DIR ?? path.join(homedir(), ".claude", "projects");
}

/** Claude Code names project folders by replacing every non-alphanumeric char with "-". */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

function humanText(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.startsWith("<") ? null : content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "text")
      .map((c) => String((c as { text?: string }).text ?? ""))
      .filter((t) => !t.startsWith("<"));
    return texts.length ? texts.join("\n") : null;
  }
  return null;
}

export interface ReadOptions {
  since: number;
  /** Only read these project folder names (encoded). Undefined = all. */
  projectFolders?: string[];
  excludeSessionId?: string;
}

export function readSessions(opts: ReadOptions): { events: ToolEvent[]; sessions: SessionInfo[] } {
  const root = projectsDir();
  const events: ToolEvent[] = [];
  const sessions: SessionInfo[] = [];
  let folders: string[];
  try {
    folders = opts.projectFolders ?? readdirSync(root);
  } catch {
    return { events, sessions };
  }
  for (const folder of folders) {
    const dir = path.join(root, folder);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const fp = path.join(dir, f);
      try {
        if (statSync(fp).mtimeMs < opts.since) continue;
      } catch {
        continue;
      }
      readFile(fp, opts, events, sessions);
    }
  }
  events.sort((a, b) => a.ts - b.ts);
  return { events, sessions };
}

function readFile(fp: string, opts: ReadOptions, events: ToolEvent[], sessions: SessionInfo[]): void {
  let raw: string;
  try {
    raw = readFileSync(fp, "utf8");
  } catch {
    return;
  }
  const recentUser: string[] = [];
  let info: SessionInfo | null = null;
  for (const line of raw.split("\n")) {
    if (!line || line[0] !== "{") continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // tolerate partial / unknown lines
    }
    if (e.isSidechain === true) continue;
    const sessionId = typeof e.sessionId === "string" ? e.sessionId : "";
    if (opts.excludeSessionId && sessionId === opts.excludeSessionId) return;
    const ts = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
    const cwd = typeof e.cwd === "string" ? e.cwd : "";
    if (!info && cwd && sessionId && Number.isFinite(ts)) {
      info = { sessionId, cwd, firstTs: ts };
    }
    if (e.type === "user") {
      const t = humanText(e.message);
      if (t !== null) {
        recentUser.push(t);
        if (recentUser.length > 3) recentUser.shift();
      }
      continue;
    }
    if (e.type !== "assistant" || !Number.isFinite(ts) || ts < opts.since || !cwd) continue;
    const content = (e.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (!c || typeof c !== "object" || (c as { type?: string }).type !== "tool_use") continue;
      const tu = c as { name?: string; input?: Record<string, unknown> };
      events.push({
        ts,
        sessionId,
        cwd,
        tool: String(tu.name ?? ""),
        input: tu.input ?? {},
        lastUserText: recentUser.join("\n"),
      });
    }
  }
  if (info && info.firstTs >= opts.since) sessions.push(info);
}
