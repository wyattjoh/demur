/**
 * What a path points at, decided by code rather than by the model.
 *
 * Classification is a *fact* ("this resolves inside the OS temp directory"),
 * not a policy ("therefore allow it"). The model still decides what the fact
 * means; code just stops making it guess at string manipulation it cannot do.
 */
export type PathClass =
  | "temp"
  | "system"
  | "filesystem-root"
  | "home-root"
  | "home"
  | "inside-working-directory"
  | "relative"
  | "remote"
  | "unresolved-variable"
  | "glob"
  | "unknown";

/**
 * A path found in a command, with what code could determine about it.
 */
export type AnalyzedPath = {
  /**
   * The path exactly as it appeared, after quote removal.
   */
  value: string;
  /**
   * The path with `~`, known variables, and `..` resolved, when possible.
   */
  resolved: string | undefined;
  /**
   * What the resolved path points at.
   */
  class: PathClass;
  /**
   * Whether the path as written contained a variable expansion, whatever it
   * resolved to here.
   *
   * `$TMPDIR/build` can resolve to a temp directory on one machine and anywhere
   * else on another. Resolution at judgment time therefore proves nothing about
   * resolution at execution time.
   */
  variableRooted: boolean;
};

/**
 * One command in a compound command line.
 */
export type Segment = {
  /**
   * The segment text as written.
   */
  raw: string;
  /**
   * The program actually being invoked, after stripping wrappers, environment
   * assignments, and any leading directory.
   *
   * This is the field that stops `transform data` from reading as `rm`.
   */
  argv0: string | undefined;
  /**
   * Wrapper programs stripped to find `argv0`, such as `env`, `sudo`, `time`.
   */
  wrappers: string[];
  /**
   * Arguments after `argv0`, with quotes removed.
   */
  args: string[];
  /**
   * Paths found among the arguments.
   */
  paths: AnalyzedPath[];
};

/**
 * A heredoc found in the command.
 */
export type Heredoc = {
  /**
   * The delimiter word.
   */
  tag: string;
  /**
   * Whether the delimiter was quoted, which suppresses shell expansion in the
   * body and is strong evidence the body is inert data.
   */
  quoted: boolean;
  /**
   * The program the body is fed to, when one could be determined.
   */
  consumer: string | undefined;
  /**
   * The body text.
   */
  body: string;
};

/**
 * Everything code can determine about a command without running it.
 */
export type CommandAnalysis = {
  /**
   * Commands in the line, split on shell operators and unwrapped from
   * groupings and control flow.
   */
  segments: Segment[];
  /**
   * Commands found inside `$(...)` or backticks. These execute, and are easy to
   * miss when reading the outer command as text.
   */
  substitutions: string[];
  /**
   * Heredocs, whose bodies are usually data rather than commands.
   */
  heredocs: Heredoc[];
  /**
   * Whether anything in the command failed to parse cleanly.
   */
  parsedCleanly: boolean;
  /**
   * Whether what this command will actually do cannot be determined from its
   * text alone.
   *
   * True when a target path is variable-rooted or glob-expanded, when the
   * command runs something from a substitution, or when it did not parse. These
   * are the cases where a judgment reads the command's *apparent* meaning while
   * its real meaning depends on the environment at execution time.
   */
  staticallyUnresolvable: boolean;
};

/**
 * Programs that pass execution through to another program, hiding the real
 * `argv0` behind themselves.
 */
const WRAPPERS = new Set([
  "env",
  "sudo",
  "doas",
  "time",
  "nohup",
  "nice",
  "ionice",
  "command",
  "builtin",
  "exec",
  "setsid",
  "stdbuf",
  "timeout",
  "xargs",
  "watch",
]);

/**
 * Shell reserved words that can precede a simple command inside control flow.
 */
const KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "do",
  "done",
  "while",
  "until",
  "for",
  "case",
  "esac",
  "select",
  "function",
  "{",
  "}",
  "!",
]);

/**
 * Extract heredocs and replace their bodies with a placeholder.
 *
 * Bodies are pulled out before tokenizing so that a `rm -rf /` sitting inside a
 * quoted heredoc body is never mistaken for a token of the command itself.
 *
 * @param command - The raw command line
 * @returns The heredocs found and the command with bodies removed
 */
function extractHeredocs(command: string): {
  heredocs: Heredoc[];
  stripped: string;
} {
  const heredocs: Heredoc[] = [];
  const lines = command.split("\n");
  const kept: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;

    const match = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (match === null) {
      kept.push(line);
      continue;
    }

    const tag = match[2] ?? "";
    const quoted = match[1] !== "";
    const consumer = /^\s*([A-Za-z0-9_./-]+)/.exec(line)?.[1];

    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const candidate = lines[j];
      if (candidate === undefined) break;
      if (candidate.trim() === tag) break;
      body.push(candidate);
    }

    heredocs.push({ tag, quoted, consumer, body: body.join("\n") });
    kept.push(line.replace(match[0], "<<HEREDOC_BODY"));
    i = j;
  }

  return { heredocs, stripped: kept.join("\n") };
}

/**
 * Collect the commands inside `$(...)` and backtick substitutions.
 *
 * @param text - Command text to scan
 * @returns The inner command strings
 */
function extractSubstitutions(text: string): string[] {
  const found: string[] = [];

  for (const m of text.matchAll(/\$\(([^()]*)\)/g)) {
    const inner = m[1]?.trim();
    if (inner) found.push(inner);
  }
  for (const m of text.matchAll(/`([^`]*)`/g)) {
    const inner = m[1]?.trim();
    if (inner) found.push(inner);
  }

  return found;
}

/**
 * Split a command line into segments on shell operators.
 *
 * Also unwraps groupings and drops control-flow keywords, so that
 * `(chmod -R 755 /etc)` and `if true; then chmod -R 755 /etc; fi` both yield a
 * segment whose `argv0` is `chmod` rather than `(chmod` or `then`.
 *
 * @param text - Command text with heredoc bodies already removed
 * @returns Segment strings, trimmed and non-empty
 */
function splitSegments(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | undefined;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === undefined) continue;

    if (quote !== undefined) {
      current += ch;
      if (ch === quote) quote = undefined;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }

    const next = text[i + 1];
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      parts.push(current);
      current = "";
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n" || ch === "&") {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);

  return parts
    .map((p) => p.trim().replace(/^[({]\s*/, "").replace(/\s*[)}]$/, "").trim())
    .filter((p) => p !== "");
}

/**
 * Split a segment into tokens, removing quotes.
 *
 * Quote removal is what collapses `rm -rf''` and `rm -r'f` back to `rm -rf`.
 * A backslash is treated as a literal character rather than an escape when it
 * is followed by a non-space, so Windows paths such as `C:\Users\u` survive
 * tokenizing intact.
 *
 * An unterminated quote is reported rather than silently swallowed: `rm -r'f /`
 * is not a valid command, and saying so is more useful to the model than
 * inventing a plausible tokenization for it.
 *
 * @param segment - A single command segment
 * @returns Tokens with quotes stripped, and whether a quote was left open
 */
function tokenize(segment: string): { tokens: string[]; unterminated: boolean } {
  const tokens: string[] = [];
  let current = "";
  let quote: string | undefined;
  let started = false;

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (ch === undefined) continue;

    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else current += ch;
      started = true;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }

    if (ch === "\\" && segment[i + 1] === " ") {
      current += " ";
      i += 1;
      started = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }

    current += ch;
    started = true;
  }

  if (started) tokens.push(current);
  return { tokens, unterminated: quote !== undefined };
}

/**
 * Find the program a segment actually invokes.
 *
 * Drops leading `VAR=value` assignments and shell keywords, unwraps wrapper
 * programs, and reduces a path-qualified program to its base name so that
 * `/usr/bin/git` and `git` read identically.
 *
 * @param tokens - Tokens of one segment
 * @returns The resolved program name, the wrappers stripped, and the remaining arguments
 */
function resolveArgv0(tokens: string[]): {
  argv0: string | undefined;
  wrappers: string[];
  args: string[];
} {
  const wrappers: string[] = [];
  let rest = [...tokens];

  while (rest.length > 0) {
    const head = rest[0];
    if (head === undefined) break;

    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
      rest = rest.slice(1);
      continue;
    }
    if (KEYWORDS.has(head)) {
      rest = rest.slice(1);
      continue;
    }

    const base = head.split(/[/\\]/).pop() ?? head;
    if (WRAPPERS.has(base)) {
      wrappers.push(base);
      rest = rest.slice(1);
      // `env -C dir cmd` and `timeout 5s cmd`: skip the wrapper's own options
      // and their values so the next word really is the wrapped program.
      while (rest.length > 0) {
        const opt = rest[0];
        if (opt === undefined) break;
        if (opt.startsWith("-")) {
          rest = rest.slice(1);
          const value = rest[0];
          if (value !== undefined && !value.startsWith("-") && opt.length === 2) {
            rest = rest.slice(1);
          }
          continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(opt)) {
          rest = rest.slice(1);
          continue;
        }
        if (/^\d+[smh]?$/.test(opt) && wrappers.includes("timeout")) {
          rest = rest.slice(1);
          continue;
        }
        break;
      }
      continue;
    }

    return { argv0: base, wrappers, args: rest.slice(1) };
  }

  return { argv0: undefined, wrappers, args: [] };
}

/**
 * Normalize `.` and `..` segments in a path without touching the filesystem.
 *
 * This matters for classification: `.../AppData/Local/Temp/../../Documents`
 * must not be read as a temp path.
 *
 * @param path - A path that may contain relative segments
 * @returns The path with `.` and `..` resolved textually
 */
function normalizeDots(path: string): string {
  const windows = /^[A-Za-z]:/.test(path) || path.includes("\\");
  const sep = windows ? "\\" : "/";
  const unified = path.replace(/\\/g, "/");
  const absolute = unified.startsWith("/") || /^[A-Za-z]:/.test(unified);

  const out: string[] = [];
  for (const part of unified.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && out.length > 0 && out.at(-1) !== "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }

  const joined = out.join(windows ? sep : "/");
  if (!absolute) return joined;
  return /^[A-Za-z]:/.test(unified) ? joined : `/${joined}`;
}

/**
 * Decide what a path points at.
 *
 * @param raw - The path as written, after quote removal
 * @param cwd - The working directory the command will run in
 * @param home - The user's home directory
 * @param tmpdir - The value of `TMPDIR`, when set
 * @returns The path with its resolution and classification
 */
export function classifyPath(
  raw: string,
  cwd: string,
  home: string,
  tmpdir: string | undefined,
): AnalyzedPath {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^[\w.-]+@[\w.-]+:/.test(raw)) {
    return { value: raw, resolved: raw, class: "remote", variableRooted: false };
  }

  let expanded = raw;
  let hadVariable = false;

  expanded = expanded.replace(/\$\{?TMPDIR(:-[^}]*)?\}?/g, () => {
    return tmpdir ?? "/tmp";
  });
  expanded = expanded.replace(/%TEMP%|%TMP%/gi, () => tmpdir ?? "/tmp");
  expanded = expanded.replace(/\$\{?HOME\}?/g, home);
  if (expanded.startsWith("~")) expanded = home + expanded.slice(1);

  if (/\$\{?[A-Za-z_]/.test(expanded)) hadVariable = true;

  const hasGlob = /[*?]|\[[^\]]+\]/.test(expanded);
  const variableRooted = /\$|%[A-Za-z_]+%/.test(raw);

  const resolved = normalizeDots(expanded);
  const lower = resolved.toLowerCase().replace(/\\/g, "/");

  const isTemp =
    /^\/tmp(\/|$)/.test(lower) ||
    /^\/var\/tmp(\/|$)/.test(lower) ||
    /^\/private\/var\/folders\//.test(lower) ||
    /\/appdata\/local\/temp(\/|$)/.test(lower) ||
    /^[a-z]:\/windows\/temp(\/|$)/.test(lower) ||
    (tmpdir !== undefined && lower.startsWith(tmpdir.toLowerCase().replace(/\\/g, "/")));

  if (isTemp) return { value: raw, resolved, class: "temp", variableRooted };

  if (hadVariable) {
    return { value: raw, resolved: undefined, class: "unresolved-variable", variableRooted };
  }

  if (resolved === "/" || resolved === "") {
    return { value: raw, resolved, class: "filesystem-root", variableRooted };
  }

  if (/^\/(etc|usr|bin|sbin|boot|sys|proc|lib|opt|var|root)(\/|$)/.test(lower)) {
    return { value: raw, resolved, class: "system", variableRooted };
  }
  if (/^[a-z]:\/(windows|program files)/.test(lower)) {
    return { value: raw, resolved, class: "system", variableRooted };
  }

  const cwdNorm = normalizeDots(cwd).replace(/\\/g, "/").toLowerCase();
  if (lower === cwdNorm || lower.startsWith(`${cwdNorm}/`)) {
    return { value: raw, resolved, class: "inside-working-directory", variableRooted };
  }

  const homeNorm = normalizeDots(home).replace(/\\/g, "/").toLowerCase();
  if (lower === homeNorm) return { value: raw, resolved, class: "home-root", variableRooted };
  if (lower.startsWith(`${homeNorm}/`)) {
    return { value: raw, resolved, class: "home", variableRooted };
  }

  if (hasGlob) return { value: raw, resolved, class: "glob", variableRooted };
  if (!resolved.startsWith("/") && !/^[A-Za-z]:/.test(resolved)) {
    return { value: raw, resolved, class: "relative", variableRooted };
  }

  return { value: raw, resolved, class: "unknown", variableRooted };
}

/**
 * Whether a token looks like a path rather than a flag or a bare word.
 *
 * Deliberately inclusive: a token that is not a path costs one noisy state
 * entry, while a missed path costs a misclassified command.
 *
 * @param token - An argument token
 * @returns `true` when the token is worth classifying as a path
 */
function looksLikePath(token: string): boolean {
  if (token.startsWith("-")) return false;
  if (token === "") return false;
  return (
    token.includes("/") ||
    token.includes("\\") ||
    token.startsWith("~") ||
    token.startsWith("$") ||
    /^[A-Za-z]:/.test(token) ||
    /\.[A-Za-z0-9]{1,5}$/.test(token)
  );
}

/**
 * Analyze a command without executing it.
 *
 * Everything here is deterministic string work that the model would otherwise
 * have to do by eye: splitting compound commands, removing quotes, finding the
 * real program name, and resolving paths.
 *
 * @param command - The raw command line
 * @param cwd - The working directory it will run in
 * @param home - The user's home directory
 * @param tmpdir - The value of `TMPDIR`, when set
 * @returns The analysis handed to the model as state
 */
export function analyze(
  command: string,
  cwd: string,
  home: string,
  tmpdir: string | undefined,
): CommandAnalysis {
  let parsedCleanly = true;

  const { heredocs, stripped } = extractHeredocs(command);
  const substitutions = extractSubstitutions(stripped);

  // Substitutions are pulled out before segmenting so their inner operators
  // don't split the outer command.
  const withoutSubs = stripped
    .replace(/\$\([^()]*\)/g, "SUBST")
    .replace(/`[^`]*`/g, "SUBST");

  const segments: Segment[] = [];
  for (const raw of splitSegments(withoutSubs)) {
    const { tokens, unterminated } = tokenize(raw);
    if (unterminated) parsedCleanly = false;
    if (tokens.length === 0) {
      parsedCleanly = false;
      continue;
    }
    const { argv0, wrappers, args } = resolveArgv0(tokens);
    if (argv0 === undefined) parsedCleanly = false;

    const paths = args
      .filter(looksLikePath)
      .map((t) => classifyPath(t, cwd, home, tmpdir));

    segments.push({ raw, argv0, wrappers, args, paths });
  }

  if (segments.length === 0) parsedCleanly = false;

  const staticallyUnresolvable =
    !parsedCleanly ||
    substitutions.length > 0 ||
    segments.some((seg) =>
      seg.paths.some(
        (p) => p.variableRooted || p.class === "glob" || p.class === "unresolved-variable",
      ),
    ) ||
    segments.some((seg) => seg.argv0 !== undefined && /[*?$]/.test(seg.argv0));

  return { segments, substitutions, heredocs, parsedCleanly, staticallyUnresolvable };
}
