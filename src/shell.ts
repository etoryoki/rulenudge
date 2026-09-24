// Minimal shell lexer: split a command line into simple commands.
// Quoted strings are kept but wrapped in QOPEN...QCLOSE markers so separators
// inside them do not split, and heredoc bodies are dropped, so that
// `grep "a && git pull"` is not mistaken for running `git pull`.

import path from "node:path";

export const QOPEN = "\u0001";
export const QCLOSE = "\u0002";

/** Remove heredoc bodies (<<EOF ... EOF, <<'EOF' ... EOF, <<-EOF ... EOF). */
function stripHeredocs(cmd: string): string {
  const lines = cmd.split("\n");
  const out: string[] = [];
  let terminator: string | null = null;
  for (const line of lines) {
    if (terminator !== null) {
      if (line.trim() === terminator) terminator = null;
      continue;
    }
    const m = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (m) {
      terminator = m[2];
      out.push(line.slice(0, m.index) + line.slice((m.index ?? 0) + m[0].length));
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Split into simple commands. Quoted content is replaced by a placeholder
 * token so it can never match a command prefix, but word boundaries are kept.
 */
export function splitCommands(input: string): string[] {
  const src = stripHeredocs(input);
  const commands: string[] = [];
  let cur = "";
  let i = 0;
  const flush = () => {
    const t = cur.trim();
    if (t) commands.push(t);
    cur = "";
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"') {
      const end = src.indexOf(ch, i + 1);
      cur += QOPEN + src.slice(i + 1, end === -1 ? src.length : end) + QCLOSE;
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (ch === "\\" && i + 1 < src.length) {
      cur += src[i + 1] === "\n" ? " " : src[i + 1];
      i += 2;
      continue;
    }
    if (ch === "&" && src[i + 1] === "&") { flush(); i += 2; continue; }
    if (ch === "|" && src[i + 1] === "|") { flush(); i += 2; continue; }
    if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") { flush(); i += 1; continue; }
    if (ch === "(" || ch === ")" || ch === "{" || ch === "}") { flush(); i += 1; continue; }
    if (ch === "$" && src[i + 1] === "(") { flush(); i += 2; continue; }
    if (ch === "`") { flush(); i += 1; continue; }
    cur += ch;
    i += 1;
  }
  flush();
  // strip leading env assignments and common wrappers
  return commands.map((c) =>
    c
      .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "")
      .replace(/^(?:sudo|time|command|exec|nohup)\s+/, "")
      .trim(),
  ).filter(Boolean);
}

/** True if `command` is `prefix` or starts with `prefix` followed by whitespace. */
export function startsWithCommand(command: string, prefix: string): boolean {
  const c = command.replace(/\s+/g, " ");
  const p = prefix.replace(/\s+/g, " ").trim();
  return c === p || c.startsWith(p + " ");
}

/** Remove quote markers (for reading paths and file names). */
export function unquote(s: string): string {
  return s.split(QOPEN).join("").split(QCLOSE).join("");
}

export interface SimpleCommand {
  /** Command text; quoted parts stay wrapped in markers. `git -C dir x` becomes `git x`. */
  text: string;
  /** Directory the command runs in, following `cd` / `Set-Location` / `git -C`. */
  cwd: string;
}

export function commandsWithCwd(input: string, baseCwd: string): SimpleCommand[] {
  let cwd = baseCwd;
  const out: SimpleCommand[] = [];
  for (const c of splitCommands(input)) {
    const plain = unquote(c);
    const cd = plain.match(/^(?:cd|pushd|set-location|sl|chdir)\s+(?:-path\s+|-literalpath\s+)?(.+)$/i);
    if (cd) {
      const target = normalizeMsysPath(cd[1].trim());
      if (target !== "-" && !target.startsWith("~") && !target.includes("$")) cwd = path.resolve(cwd, target);
      continue;
    }
    const gitC = c.match(/^git\s+-C\s+(\S+)\s+(.*)$/);
    if (gitC) {
      out.push({ text: `git ${gitC[2]}`, cwd: path.resolve(cwd, normalizeMsysPath(unquote(gitC[1]))) });
      continue;
    }
    out.push({ text: c, cwd });
  }
  return out;
}

/** Extract the target directory of leading `cd <dir>` commands, if any. */
export function leadingCd(input: string): string | null {
  const m = input.match(/^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
  if (!m) return null;
  return normalizeMsysPath(m[1] ?? m[2] ?? m[3]);
}

/** Git Bash style /c/Users/... -> C:/Users/... */
export function normalizeMsysPath(p: string): string {
  const m = p.match(/^\/([a-zA-Z])\/(.*)$/);
  return m ? `${m[1].toUpperCase()}:/${m[2]}` : p;
}
