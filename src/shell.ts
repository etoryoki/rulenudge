// Minimal shell lexer: split a command line into simple commands,
// dropping quoted strings and heredoc bodies so that `grep "git pull"`
// is not mistaken for running `git pull`.

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
      cur += "_Q_";
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
