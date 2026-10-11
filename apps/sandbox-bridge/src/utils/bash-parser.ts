import { BLOCKED_CLI_PATTERNS, BLOCKED_GIT_BRANCH_CREATION, BLOCKED_GIT_PATTERNS } from "../constants/bridge.js";

type ParsedBashSegment = {
  raw: string;
  executable: string;
  args: string[];
  paths: string[];
  separatorBefore: BashSegmentSeparator | null;
  /** Leading `VAR=val` assignments before the executable (e.g. `GIT_CONFIG_KEY_0=...`). */
  envAssignments: string[];
};

export type BlockedBashCommand = {
  raw: string;
  executable: string;
  message: string;
  actionKey: string;
  reasonKey: string;
};

type ParsedBashCommand = {
  segments: ParsedBashSegment[];
  allPaths: string[];
  searchCommandCounts: SearchCommandCounts;
  blockedCommands: string[];
  blockedCommandDetails: BlockedBashCommand[];
  isDangerous: boolean;
};

export type SearchCommandCounts = {
  grep: number;
  ripgrep: number;
};

type HeredocDelimiter = {
  value: string;
  stripLeadingTabs: boolean;
};

type BashSegmentSeparator = "&&" | "||" | ";" | "|" | "&" | "\n";

export type CommandToken = {
  value: string;
  start: number;
  end: number;
};

export const PR_READINESS_SHELL_EXECUTABLES = new Set(["bash", "sh", "zsh"]);

export function isShellCommandSeparator(token: string): boolean {
  return token === "&&" || token === "||" || token === "|" || token === "|&" || token === ";";
}

export function executableName(token: string | undefined): string | undefined {
  const basename = token?.split(/[\\/]/).pop()?.toLowerCase();
  if (!basename) return undefined;
  return basename.replace(/@(?:latest|\d[\w.-]*)$/, "");
}

export function commandExecutableName(token: string): string | undefined {
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) return undefined;
  return executableName(token);
}

export function tokenizeCommandWithSpans(command: string): CommandToken[] {
  const tokens: CommandToken[] = [];
  let index = 0;

  while (index < command.length) {
    while (index < command.length && /\s/.test(command[index]!)) index += 1;
    if (index >= command.length) break;

    const start = index;
    let quote: '"' | "'" | null = null;
    while (index < command.length) {
      const char = command[index]!;
      if (quote) {
        if (char === quote) quote = null;
        index += 1;
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
        index += 1;
        continue;
      }
      if (/\s/.test(char)) break;
      index += 1;
    }

    tokens.push({ value: command.slice(start, index), start, end: index });
  }

  return tokens;
}

export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const char of command) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current.length > 0) tokens.push(current);
  return tokens;
}

export function extractShellCommandPayloads(command: string): string[] {
  const tokens = tokenizeCommand(command);
  const executable = executableName(tokens[0]);
  if (!executable || !PR_READINESS_SHELL_EXECUTABLES.has(executable)) return [];

  let cursor = 1;
  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (token === "--") {
      // `--` ends option parsing; any following positional is a script path or arg, not a -c
      // command string, so skip it and let the next iteration break out below.
      cursor++;
      continue;
    }
    if (!token.startsWith("-") || token === "-") break;

    const runsCommandString = /^-[A-Za-z]*c[A-Za-z]*$/.test(token);
    cursor++;
    if (!runsCommandString) continue;

    const payload = tokens.slice(cursor).join(" ").trim();
    return payload ? [payload] : [];
  }

  return [];
}

function recordBlockedCommand(
  blockedCommandDetails: BlockedBashCommand[],
  segment: ParsedBashSegment,
  message: string,
  actionKey: string,
  reasonKey: string,
): void {
  blockedCommandDetails.push({
    raw: segment.raw,
    executable: segment.executable,
    message,
    actionKey,
    reasonKey,
  });
}

function isHeredocWordTerminator(ch: string): boolean {
  return /\s/.test(ch) || ch === ";" || ch === "|" || ch === "&";
}

function isDoubleQuoteEscape(ch: string): boolean {
  return ch === "$" || ch === "`" || ch === '"' || ch === "\\" || ch === "\n";
}

function hasLineContinuation(line: string): boolean {
  let trailingBackslashes = 0;
  for (let i = line.length - 1; i >= 0 && line[i] === "\\"; i--) {
    trailingBackslashes++;
  }
  return trailingBackslashes % 2 === 1;
}

function readHeredocDelimiterWord(
  line: string,
  startIndex: number,
): {
  value: string;
  nextIndex: number;
  hasWord: boolean;
} {
  let value = "";
  let i = startIndex;
  let hasWord = false;
  let inSingle = false;
  let inDouble = false;

  while (i < line.length) {
    const ch = line[i];

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        value += ch;
      }
      i++;
      continue;
    }

    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
        i++;
        continue;
      }

      if (ch === "\\" && i + 1 < line.length) {
        const next = line[i + 1];
        if (isDoubleQuoteEscape(next)) {
          value += next;
          i += 2;
          continue;
        }
      }

      value += ch;
      i++;
      continue;
    }

    if (isHeredocWordTerminator(ch)) break;

    hasWord = true;
    if (ch === "'") {
      inSingle = true;
      i++;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      i++;
      continue;
    }

    if (ch === "\\" && i + 1 < line.length) {
      value += line[i + 1];
      i += 2;
      continue;
    }

    value += ch;
    i++;
  }

  return { value, nextIndex: i, hasWord };
}

function extractHeredocDelimiters(line: string): HeredocDelimiter[] {
  const delimiters: HeredocDelimiter[] = [];
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];

    if (inDouble && ch === "\\" && i + 1 < line.length) {
      const next = line[i + 1];
      if (isDoubleQuoteEscape(next)) {
        i += 2;
        continue;
      }
    }

    if (!inSingle && !inDouble && ch === "\\" && i + 1 < line.length) {
      i += 2;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      i++;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      i++;
      continue;
    }

    if (inSingle || inDouble || ch !== "<" || line[i + 1] !== "<") {
      i++;
      continue;
    }

    if (line[i + 2] === "<") {
      i += 3;
      continue;
    }

    i += 2;
    const stripLeadingTabs = line[i] === "-";
    if (stripLeadingTabs) i++;
    while (i < line.length && /\s/.test(line[i])) i++;

    const delimiter = readHeredocDelimiterWord(line, i);
    i = delimiter.nextIndex;

    if (delimiter.hasWord) delimiters.push({ value: delimiter.value, stripLeadingTabs });
  }

  return delimiters;
}

function stripHeredocBodies(command: string): string {
  const lines = command.split(/\r?\n/);
  const keptLines: string[] = [];
  const pendingDelimiters: HeredocDelimiter[] = [];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    let line = lines[lineIdx];
    if (pendingDelimiters.length > 0) {
      const pendingDelimiter = pendingDelimiters[0];
      const normalized = pendingDelimiter.stripLeadingTabs ? line.replace(/^\t+/, "") : line;
      if (normalized === pendingDelimiter.value) {
        pendingDelimiters.shift();
      }
      continue;
    }

    while (hasLineContinuation(line) && lineIdx + 1 < lines.length) {
      line = line.slice(0, -1) + lines[lineIdx + 1];
      lineIdx++;
    }

    keptLines.push(line);
    pendingDelimiters.push(...extractHeredocDelimiters(line));
  }

  return keptLines.join("\n");
}

/** Split a bash command string on &&, ||, ;, |, or newline while respecting quotes. */
function splitBashCommandSegments(
  command: string,
): Array<{ raw: string; separatorBefore: BashSegmentSeparator | null }> {
  const segments: Array<{ raw: string; separatorBefore: BashSegmentSeparator | null }> = [];
  let current = "";
  let nextSeparatorBefore: BashSegmentSeparator | null = null;
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  const commandWithoutHeredocBodies = stripHeredocBodies(command);

  function pushCurrent(): void {
    if (!current.trim()) return;
    segments.push({ raw: current.trim(), separatorBefore: nextSeparatorBefore });
    current = "";
  }

  while (i < commandWithoutHeredocBodies.length) {
    const ch = commandWithoutHeredocBodies[i];

    if (inDouble && ch === "\\" && i + 1 < commandWithoutHeredocBodies.length) {
      const next = commandWithoutHeredocBodies[i + 1];
      if (isDoubleQuoteEscape(next)) {
        current += ch + next;
        i += 2;
        continue;
      }
    }

    if (!inSingle && !inDouble && ch === "\\" && i + 1 < commandWithoutHeredocBodies.length) {
      current += ch + commandWithoutHeredocBodies[i + 1];
      i += 2;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      i++;
      continue;
    }

    if (!inSingle && !inDouble) {
      // Check for &&, ||
      if (i + 1 < commandWithoutHeredocBodies.length) {
        const two = commandWithoutHeredocBodies.slice(i, i + 2);
        if (two === "&&" || two === "||") {
          pushCurrent();
          nextSeparatorBefore = two;
          i += 2;
          continue;
        }
      }
      // Check for ;, |, &, or command-separating newline. `>|`, `>&`,
      // `<&`, `&>` and `&>>` are redirections, not command separators.
      const previous = i > 0 ? commandWithoutHeredocBodies[i - 1] : "";
      const next = commandWithoutHeredocBodies[i + 1] ?? "";
      if (
        ch === ";" ||
        (ch === "|" && previous !== ">") ||
        (ch === "&" && next !== ">" && previous !== ">" && previous !== "<") ||
        ch === "\n"
      ) {
        pushCurrent();
        nextSeparatorBefore = ch;
        i++;
        continue;
      }
    }

    current += ch;
    i++;
  }

  pushCurrent();
  return segments;
}

/** Tokenize a single command segment respecting quotes. */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (inDouble && ch === "\\" && i + 1 < segment.length) {
      const next = segment[i + 1];
      if (isDoubleQuoteEscape(next)) {
        if (next === "\n") {
          i++;
          continue;
        }
        current += next;
        i++;
        continue;
      }
    }
    if (!inSingle && !inDouble && ch === "\\" && i + 1 < segment.length) {
      const next = segment[i + 1];
      if (next !== "\n") current += next;
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && (ch === " " || ch === "\t")) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Extract the executable name from a token (strip path prefix). */
function extractExecutable(token: string): string {
  // Handle env VAR=val cmd, sudo cmd, etc.
  if (token === "sudo" || token === "env" || token === "nohup" || token === "time") return token;
  const base = token.includes("/") ? token.slice(token.lastIndexOf("/") + 1) : token;
  return base;
}

/**
 * Per-command argument conventions. We classify each arg of a known executable
 * so that regex bodies (grep -E PATTERN), inline scripts (node -e SCRIPT), and
 * non-file flag values (awk -v K=V) are never treated as file paths. This is
 * the durable replacement for ad-hoc "does this token look path-like" heuristics.
 */
type CommandSpec = {
  /** Flags whose next arg is a script body (not a file). */
  scriptFlags?: ReadonlySet<string>;
  /** Flags whose next arg is a regex pattern (not a file). */
  regexFlags?: ReadonlySet<string>;
  /** Flags whose next arg is a generic non-file value (env var, field separator, etc). */
  valueFlags?: ReadonlySet<string>;
  /** Flags whose next arg IS a file path (e.g. grep -f PATTERNFILE). */
  fileFlags?: ReadonlySet<string>;
  /**
   * Flags that, when present, fulfill the command's regex/program slot — so a
   * positional "regex" slot becomes positionalDefault instead. Covers cases
   * like `grep -e PAT FILE` and `grep -f FILE FILE` where the positional is
   * a search file rather than the regex.
   */
  regexProvidedByFlags?: ReadonlySet<string>;
  /** Classification of positional args by index after flags are consumed. */
  positional?: ReadonlyArray<"file" | "regex" | "script" | "value">;
  /** Default kind for positional args beyond `positional.length`. */
  positionalDefault?: "file" | "regex" | "script" | "value" | "unknown";
};

const grepLikeSpec: CommandSpec = {
  regexFlags: new Set(["-e", "--regexp"]),
  valueFlags: new Set([
    "-j",
    "--threads",
    "-A",
    "--after-context",
    "-B",
    "--before-context",
    "-C",
    "--context",
    "-m",
    "--max-count",
    "-g",
    "--glob",
    "-t",
    "--type",
    "--type-not",
    "--color",
    "--colour",
  ]),
  fileFlags: new Set(["-f", "--file"]),
  regexProvidedByFlags: new Set(["-e", "--regexp", "-f", "--file"]),
  positional: ["regex"],
  positionalDefault: "file",
};

const GIT_GLOBAL_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix"]);
const GIT_BRANCH_NON_CREATION_FLAGS = new Set([
  "-a",
  "--all",
  "-l",
  "--list",
  "--show-current",
  "-v",
  "-vv",
  "--verbose",
  "-d",
  "-D",
  "--delete",
  "-m",
  "-M",
  "--move",
  "--unset-upstream",
  "--edit-description",
]);
const GIT_BRANCH_NON_CREATION_VALUE_FLAGS = new Set([
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--points-at",
  "--format",
  "--sort",
  "--set-upstream-to",
  "-u",
]);
const GIT_BRANCH_NON_CREATION_FLAG_PREFIXES = [...GIT_BRANCH_NON_CREATION_FLAGS].map((flag) => `${flag}=`);
const GIT_BRANCH_NON_CREATION_VALUE_FLAG_PREFIXES = [...GIT_BRANCH_NON_CREATION_VALUE_FLAGS].map((flag) => `${flag}=`);

const COMMAND_SPECS: ReadonlyMap<string, CommandSpec> = new Map([
  ["grep", grepLikeSpec],
  ["egrep", grepLikeSpec],
  ["fgrep", grepLikeSpec],
  ["rg", grepLikeSpec],
  ["ripgrep", grepLikeSpec],
  [
    "awk",
    {
      valueFlags: new Set(["-v", "-F"]),
      fileFlags: new Set(["-f"]),
      regexProvidedByFlags: new Set(["-f"]),
      positional: ["regex"],
      positionalDefault: "file",
    },
  ],
  [
    "gawk",
    {
      valueFlags: new Set(["-v", "-F"]),
      fileFlags: new Set(["-f"]),
      regexProvidedByFlags: new Set(["-f"]),
      positional: ["regex"],
      positionalDefault: "file",
    },
  ],
  [
    "sed",
    {
      scriptFlags: new Set(["-e", "--expression"]),
      fileFlags: new Set(["-f", "--file"]),
      regexProvidedByFlags: new Set(["-e", "--expression", "-f", "--file"]),
      positional: ["regex"],
      positionalDefault: "file",
    },
  ],
  ["node", { scriptFlags: new Set(["-e", "--eval", "-p", "--print"]), positionalDefault: "file" }],
  ["python", { scriptFlags: new Set(["-c"]), valueFlags: new Set(["-m"]), positionalDefault: "file" }],
  ["python3", { scriptFlags: new Set(["-c"]), valueFlags: new Set(["-m"]), positionalDefault: "file" }],
  ["bash", { scriptFlags: new Set(["-c"]), positionalDefault: "file" }],
  ["sh", { scriptFlags: new Set(["-c"]), positionalDefault: "file" }],
  ["zsh", { scriptFlags: new Set(["-c"]), positionalDefault: "file" }],
  ["dash", { scriptFlags: new Set(["-c"]), positionalDefault: "file" }],
  ["perl", { scriptFlags: new Set(["-e", "-E"]), positionalDefault: "file" }],
  ["ruby", { scriptFlags: new Set(["-e"]), positionalDefault: "file" }],
  [
    "find",
    {
      valueFlags: new Set(["-name", "-iname", "-regex", "-iregex", "-path", "-ipath", "-wholename", "-iwholename"]),
      positionalDefault: "file",
    },
  ],
]);

/**
 * Classifies a token as a probable file path candidate. Used as a fallback
 * for commands without a CommandSpec. Looks for path-like shape: an absolute
 * or relative path, a hidden file, or a short alphanumeric extension at the
 * end. Avoids false positives by rejecting tokens with shell/regex syntax.
 */
function isPotentialPath(token: string): boolean {
  if (!token) return false;
  if (token.includes("/") || token.includes("\\")) return true;
  if (token.startsWith(".")) return true;
  // Bare token with a short extension and only filename-safe chars.
  const dotIdx = token.lastIndexOf(".");
  if (dotIdx <= 0) return false;
  const extLen = token.length - dotIdx - 1;
  if (extLen < 1 || extLen > 5) return false;
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    const isWord =
      (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 46 || c === 45;
    if (!isWord) return false;
  }
  return true;
}

function hasAttachedFlagValue(arg: string, flags: ReadonlySet<string>): boolean {
  for (const flag of flags) {
    if (flag.startsWith("--")) {
      if (arg.startsWith(`${flag}=`) && arg.length > flag.length + 1) return true;
    } else if (arg.startsWith(flag) && arg.length > flag.length) {
      return true;
    }
  }
  return false;
}

function shellRedirectionPath(arg: string): string | null {
  const match = /^(?:(?:\d+)?(>>|<>|>\||<&|>&|>|<)|(&>>|&>))(.+)$/.exec(arg);
  if (!match) return null;

  const operator = match[1] ?? match[2];
  const target = match[3];
  if (!target) return null;
  if ((operator === "<&" || operator === ">&") && (target === "-" || /^\d+$/.test(target))) return null;
  return target;
}

/** Collect file-path args from a parsed segment using the command spec when available. */
function collectFileArgs(executable: string, args: string[]): string[] {
  const spec = COMMAND_SPECS.get(executable);
  if (!spec) {
    return args.flatMap((arg) => {
      const redirectionPath = shellRedirectionPath(arg);
      if (redirectionPath) return [redirectionPath];
      return !arg.startsWith("-") && isPotentialPath(arg) ? [arg] : [];
    });
  }

  const regexProvidedByFlag = spec.regexProvidedByFlags
    ? args.some((arg) => spec.regexProvidedByFlags!.has(arg) || hasAttachedFlagValue(arg, spec.regexProvidedByFlags!))
    : false;

  const paths: string[] = [];
  let positionalIdx = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const redirectionPath = shellRedirectionPath(arg);
    if (redirectionPath) {
      paths.push(redirectionPath);
      continue;
    }

    if (spec.scriptFlags?.has(arg) && i + 1 < args.length) {
      i++;
      continue;
    }
    if (spec.regexFlags?.has(arg) && i + 1 < args.length) {
      i++;
      continue;
    }
    if (spec.regexFlags && hasAttachedFlagValue(arg, spec.regexFlags)) continue;
    if (spec.valueFlags?.has(arg) && i + 1 < args.length) {
      i++;
      continue;
    }
    if (spec.fileFlags?.has(arg) && i + 1 < args.length) {
      paths.push(args[i + 1]);
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;

    let kind = spec.positional?.[positionalIdx] ?? spec.positionalDefault ?? "unknown";
    if (kind === "regex" && regexProvidedByFlag) {
      kind = spec.positionalDefault ?? "unknown";
    }
    positionalIdx++;
    if (kind === "file") {
      paths.push(arg);
    } else if (kind === "unknown" && isPotentialPath(arg)) {
      paths.push(arg);
    }
  }
  return paths;
}

function collectGitFileArgs(args: string[]): string[] | null {
  let subcommandIdx = -1;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      if (GIT_GLOBAL_VALUE_FLAGS.has(arg)) i++;
      continue;
    }
    subcommandIdx = i;
    break;
  }

  if (subcommandIdx === -1 || args[subcommandIdx] !== "grep") return null;
  return collectFileArgs("grep", args.slice(subcommandIdx + 1));
}

function isGitBranchCreationCommand(args: string[]): boolean {
  let hasBranchNamePositional = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") {
      hasBranchNamePositional = args.slice(index + 1).some((value) => value.length > 0);
      break;
    }
    if (
      GIT_BRANCH_NON_CREATION_FLAGS.has(arg) ||
      GIT_BRANCH_NON_CREATION_FLAG_PREFIXES.some((prefix) => arg.startsWith(prefix)) ||
      GIT_BRANCH_NON_CREATION_VALUE_FLAG_PREFIXES.some((prefix) => arg.startsWith(prefix))
    ) {
      return false;
    }
    if (GIT_BRANCH_NON_CREATION_VALUE_FLAGS.has(arg)) {
      return false;
    }
    if (arg.startsWith("-")) continue;
    hasBranchNamePositional = true;
  }

  return hasBranchNamePositional;
}

/**
 * Remove subshell `(...)` and brace-group `{ ...; }` delimiters from a segment's
 * tokens so a permanently-blocked command cannot hide inside a grouping wrapper
 * (e.g. `(git commit --no-verify)`, `{ git rebase -i; }`, `(git push) 2>&1`).
 *
 * We normalize the flat token stream rather than track source spans: grouping
 * chars are stripped only to expose the real executable/subcommand, and blocked
 * matches require an exact `git` executable plus an exact subcommand and an
 * anchored flag, so mangling paren chars inside an argument value can only make
 * matching stricter, never fabricate a match. The residual imprecision (post-
 * `tokenize` quote provenance is gone, so a quoted literal `'(git'` is treated
 * like a delimiter) can therefore only over-block, never miss.
 *
 * Only UNBALANCED boundary parens are stripped: a leading `(` run and a trailing
 * `)` run are removed only to the extent they are not balanced by parens inside
 * the same token. This collapses arbitrary nesting (`( ( git ) )`, `((git`,
 * `main))`) and keeps a trailing redirection's close attached to the real token
 * (`(git push origin main) 2>&1` -> `main)` -> `main`), while preserving a
 * balanced inner command substitution such as `FOO=$(git push origin main)`
 * (equal `(`/`)`, so nothing is stripped) that a naive run-strip would corrupt.
 * Brace-group delimiters only act as grouping when they are their own token
 * (bash requires `{` followed by whitespace and `}` preceded by `;`/newline), so
 * `{a,b}` brace-expansion and literal `{fix}` args are left untouched.
 */
function stripCommandGroupingWrappers(tokens: string[]): string[] {
  const out: string[] = [];
  for (const token of tokens) {
    let opens = 0;
    let closes = 0;
    for (const ch of token) {
      if (ch === "(") opens++;
      else if (ch === ")") closes++;
    }
    let start = 0;
    let end = token.length;
    // Strip only the unbalanced leading `(` (excess opens) and unbalanced
    // trailing `)` (excess closes); balanced pairs like `$( ... )` stay intact.
    let excessOpens = opens > closes ? opens - closes : 0;
    let excessCloses = closes > opens ? closes - opens : 0;
    while (excessOpens > 0 && start < end && token[start] === "(") {
      start++;
      excessOpens--;
    }
    while (excessCloses > 0 && end > start && token[end - 1] === ")") {
      end--;
      excessCloses--;
    }
    const stripped = token.slice(start, end);
    // Drop tokens that were only grouping delimiters. The brace check runs after
    // paren stripping so a combined `({` open collapses to a dropped `{`.
    if (stripped === "" || stripped === "{" || stripped === "}") continue;
    out.push(stripped);
  }
  return out;
}

/**
 * `command -v NAME` / `command -V NAME` introspect a name without executing it,
 * so `command` must not be unwrapped in that mode (otherwise `command -v git`
 * would be analyzed as a git invocation). Returns true when an introspection
 * flag appears among `command`'s leading options.
 */
function commandBuiltinIsIntrospection(tokens: string[], startIdx: number): boolean {
  for (let i = startIdx; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith("-") || t === "--") return false;
    if (t === "-v" || t === "-V") return true;
  }
  return false;
}

/** Parse a single segment into structured data. */
function parseSegment(input: { raw: string; separatorBefore: BashSegmentSeparator | null }): ParsedBashSegment {
  const { raw, separatorBefore } = input;
  const tokens = stripCommandGroupingWrappers(tokenize(raw));
  let execIdx = 0;
  // `exec`/`command` are wrapper builtins that run the following command in place;
  // unwrap them like sudo/env so a blocked command cannot hide behind them.
  const prefixes = new Set(["sudo", "env", "nohup", "time", "exec", "command"]);
  // Prefix option flags that consume the next token as a value (e.g. `env -u VAR`,
  // `env -C dir`, `sudo -u user`, `exec -a argv0`). Used so the real
  // command/assignments after a prefix's options are still parsed.
  const prefixValueFlags = new Set(["-u", "--unset", "-C", "--chdir", "-D", "--prog-name", "-a", "--argv0"]);
  const envAssignments: string[] = [];
  // Interleave skipping of prefix commands and env assignments (e.g. "env FOO=bar node app.js")
  let advanced = true;
  while (advanced && execIdx < tokens.length) {
    advanced = false;
    // Skip env assignments (FOO=bar), retaining them so callers can inspect
    // hook-bypass vectors supplied via Git's GIT_CONFIG_* environment config.
    while (execIdx < tokens.length && tokens[execIdx].includes("=") && !tokens[execIdx].startsWith("-")) {
      envAssignments.push(tokens[execIdx]);
      execIdx++;
      advanced = true;
    }
    // Skip prefix commands and any option flags they carry. Without skipping the
    // options, `env -i FOO=bar git ...` would resolve the executable to `-i` and
    // miss the git checks (and the GIT_CONFIG_* env-bypass check) entirely.
    while (execIdx < tokens.length && prefixes.has(tokens[execIdx])) {
      // Leave `command -v`/`command -V` (introspection, not execution) as-is.
      if (tokens[execIdx] === "command" && commandBuiltinIsIntrospection(tokens, execIdx + 1)) break;
      execIdx++;
      advanced = true;
      while (execIdx < tokens.length && tokens[execIdx].startsWith("-") && tokens[execIdx] !== "--") {
        execIdx += prefixValueFlags.has(tokens[execIdx]) ? 2 : 1;
      }
      if (execIdx < tokens.length && tokens[execIdx] === "--") execIdx++;
    }
  }

  const executable = execIdx < tokens.length ? extractExecutable(tokens[execIdx]) : "";
  const args = tokens.slice(execIdx + 1);
  const paths =
    executable === "git"
      ? (collectGitFileArgs(args) ?? collectFileArgs(executable, args))
      : collectFileArgs(executable, args);

  return { raw, executable, args, paths, separatorBefore, envAssignments };
}

const SHELL_EXECUTABLES = new Set(["bash", "sh", "zsh", "dash", "ash"]);
const SEARCH_EXECUTABLES = new Set(["grep", "egrep", "fgrep", "rg", "ripgrep"]);
const SHELL_SCRIPT_BODY_MAX_DEPTH = 5;

// Short option chars that consume the following arg as their value during bash
// invocation: `-o option`, `-O shopt` (and the `+o`/`+O` unset forms).
const VALUE_TAKING_SHORT_OPT_CHARS = new Set(["o", "O"]);
// Long options that consume the following arg as their value.
const VALUE_TAKING_LONG_OPTS = new Set(["--rcfile", "--init-file"]);
// A genuine short option flag bundle: `-i`, `-il`, `+O`, etc. (all ASCII
// letters after a single `-`/`+`). Real script bodies never match because they
// contain spaces, `;`, `&`, or other shell metacharacters.
const SHORT_OPT_FLAG_RE = /^[-+][a-zA-Z]+$/;
// A genuine long option flag: `--login`, `--no-profile`, etc.
const LONG_OPT_FLAG_RE = /^--[a-zA-Z][\w-]*$/;

/**
 * If `args` is a shell-style `-c <body>` invocation (including combined
 * single-letter flags like `-lc`, options after `-c` such as `-c -i <body>`,
 * value-taking options like `-c -O extglob <body>`, and the `--`
 * end-of-options marker such as `-c -- <body>`), return the index of the
 * script-body arg. Returns -1 otherwise.
 */
function findShellScriptBodyIdx(args: string[]): number {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const isCommandFlag =
      a === "-c" ||
      a === "--command" ||
      // Combined short flags like `-lc`, `-cl`, etc. Must start with a single
      // `-`, contain only ASCII letters, and include the `c` letter.
      (a.length >= 2 && a[0] === "-" && a[1] !== "-" && /^-[a-zA-Z]+$/.test(a) && a.includes("c"));
    if (!isCommandFlag) continue;
    // The script body is the first operand after `-c`, but it is not always the
    // immediately following arg. Bash keeps parsing options after `-c`
    // (e.g. `bash -c -i 'git push'`), some options consume the next arg as a
    // value (`bash -c -O extglob 'git push'`), and `--` terminates option
    // parsing (`bash -c -- 'git push'`). Walk past option flags and their
    // values; the first real operand is the body.
    for (let j = i + 1; j < args.length; j++) {
      const next = args[j];
      // `--` ends option parsing: the next arg is the body, taken literally
      // even if it looks like a flag.
      if (next === "--") {
        return j + 1 < args.length ? j + 1 : -1;
      }
      if (LONG_OPT_FLAG_RE.test(next)) {
        if (VALUE_TAKING_LONG_OPTS.has(next)) j++; // skip the option's value
        continue;
      }
      if (SHORT_OPT_FLAG_RE.test(next)) {
        // A short-flag bundle ending in `o`/`O` consumes the next arg as a
        // value (e.g. `-io emacs`).
        if (VALUE_TAKING_SHORT_OPT_CHARS.has(next[next.length - 1])) j++;
        continue;
      }
      // Not shaped like an option flag => this is the script body. Bodies that
      // begin with `-` but contain spaces/metacharacters (e.g. `-x; git push`)
      // land here instead of being mistaken for a flag.
      return j;
    }
    return -1;
  }
  return -1;
}

function maskLiteralSingleQuoteIdioms(command: string): string {
  return command.replace(/'\\''/g, "q");
}

function findUnclosedQuote(command: string): "'" | '"' | "$'" | null {
  const quoteInput = maskLiteralSingleQuoteIdioms(command);
  let inSingle = false;
  let inDouble = false;
  let inAnsiSingle = false;

  for (let i = 0; i < quoteInput.length; i++) {
    const ch = quoteInput[i];

    if (inAnsiSingle) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === "'") {
        inAnsiSingle = false;
      }
      continue;
    }

    if (ch === "\\" && !inSingle) {
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && ch === "#" && (i === 0 || /\s/.test(quoteInput[i - 1]))) {
      while (i + 1 < quoteInput.length && quoteInput[i + 1] !== "\n") i++;
      continue;
    }
    if (!inSingle && !inDouble && ch === "$" && quoteInput[i + 1] === "'") {
      inAnsiSingle = true;
      i++;
    }
  }

  if (inAnsiSingle) return "$'";
  if (inSingle) return "'";
  if (inDouble) return '"';
  return null;
}

function recordMalformedSearchCommandIfNeeded(
  segments: ParsedBashSegment[],
  blockedCommandDetails: BlockedBashCommand[],
): void {
  for (const segment of segments) {
    const unclosedQuote = findUnclosedQuote(segment.raw);
    if (!SEARCH_EXECUTABLES.has(segment.executable)) continue;

    if (unclosedQuote) {
      recordBlockedCommand(
        blockedCommandDetails,
        segment,
        `Malformed ${segment.executable} search command is blocked before execution: unclosed ${unclosedQuote} quote. Quote the complete search pattern or split the pipeline into simpler rg/grep commands.`,
        "search.malformed",
        "malformed_search_command",
      );
    }
  }

  let activePipeSearchSegment: ParsedBashSegment | null = null;
  for (const segment of segments) {
    if (segment.separatorBefore !== "|") {
      activePipeSearchSegment = null;
    }

    if (SEARCH_EXECUTABLES.has(segment.executable)) {
      activePipeSearchSegment = segment;
      continue;
    }

    const unclosedQuote = findUnclosedQuote(segment.raw);
    if (!unclosedQuote || !activePipeSearchSegment) continue;

    recordBlockedCommand(
      blockedCommandDetails,
      {
        ...activePipeSearchSegment,
        raw: `${activePipeSearchSegment.raw} | ${segment.raw}`,
      },
      `Malformed ${activePipeSearchSegment.executable} search pipeline is blocked before execution: unclosed ${unclosedQuote} quote in the piped search expression. Quote the complete search pattern or split the pipeline into simpler rg/grep commands.`,
      "search.malformed",
      "malformed_search_command",
    );
  }
}

function countSearchCommands(segments: ParsedBashSegment[]): SearchCommandCounts {
  const counts: SearchCommandCounts = { grep: 0, ripgrep: 0 };

  for (const segment of segments) {
    if (segment.separatorBefore === "|") continue;
    if (segment.executable === "rg" || segment.executable === "ripgrep") {
      counts.ripgrep++;
    } else if (segment.executable === "grep" || segment.executable === "egrep" || segment.executable === "fgrep") {
      counts.grep++;
    }
  }

  return counts;
}

function addSearchCommandCounts(target: SearchCommandCounts, source: SearchCommandCounts): void {
  target.grep += source.grep;
  target.ripgrep += source.ripgrep;
}

function mergeParsedBashCommands(primary: ParsedBashCommand, secondary: ParsedBashCommand): ParsedBashCommand {
  const blockedCommandDetails = [...primary.blockedCommandDetails, ...secondary.blockedCommandDetails];
  const blockedCommands = blockedCommandDetails.map((detail) => detail.message);
  const searchCommandCounts = { ...primary.searchCommandCounts };
  addSearchCommandCounts(searchCommandCounts, secondary.searchCommandCounts);
  return {
    segments: primary.segments,
    allPaths: [...primary.allPaths, ...secondary.allPaths],
    searchCommandCounts,
    blockedCommands,
    blockedCommandDetails,
    isDangerous: blockedCommands.length > 0,
  };
}

function isEnvAssignmentBefore(command: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && /\s/.test(command[i]!)) i -= 1;
  if (i < 0 || command[i] !== "=") return false;
  i -= 1;
  while (i >= 0 && /\s/.test(command[i]!)) i -= 1;
  if (i < 0) return false;
  const ch = command[i]!;
  return /[A-Za-z0-9_\])]/.test(ch);
}

/**
 * Prismor-style canonicalization for policy matching:
 * - unwrap command substitutions (`$(...)`) and backticks into their inner
 *   command text (recursively, with a depth budget)
 *
 * We intentionally do *not* collapse newlines globally here because newline
 * splitting is used for correct command segmentation (e.g. heredoc handling).
 * Instead, newline evasion is handled in-layer for blocked git/CLI matching
 * by reconstructing argv across `\n`-separated segments.
 */
function canonicalizeBashCommandForGuardMatching(command: string): string {
  return unwrapCommandSubstitutionsAndBackticks(command, 16);
}

function unwrapCommandSubstitutionsAndBackticks(command: string, maxDepth: number): string {
  let out = command;
  for (let depth = 0; depth < maxDepth; depth++) {
    const next = unwrapCommandSubstitutionsAndBackticksOnce(out);
    if (next === out) return out;
    out = next;
  }
  return out;
}

function unwrapCommandSubstitutionsAndBackticksOnce(command: string): string {
  let result = "";
  let i = 0;
  let inSingle = false;

  while (i < command.length) {
    const ch = command[i]!;

    // Single quotes suppress $() / backticks evaluation in bash; preserve as-is.
    if (inSingle) {
      result += ch;
      if (ch === "'") inSingle = false;
      i += 1;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      result += ch;
      i += 1;
      continue;
    }

    // Handle backslash escapes outside single quotes so `\`` doesn't unwrap.
    if (ch === "\\" && i + 1 < command.length) {
      result += ch + command[i + 1]!;
      i += 2;
      continue;
    }

    // Backticks: `...` → ... (skip when part of VAR=`...` assignment)
    if (ch === "`") {
      if (isEnvAssignmentBefore(command, i)) {
        result += ch;
        i += 1;
        continue;
      }
      const end = findUnescapedBacktickEnd(command, i + 1);
      if (end === -1) {
        result += ch;
        i += 1;
        continue;
      }
      result += command.slice(i + 1, end);
      i = end + 1;
      continue;
    }

    // Command substitution: $(...) → ... (skip when part of VAR=$(...) assignment)
    if (ch === "$" && command[i + 1] === "(") {
      if (isEnvAssignmentBefore(command, i)) {
        result += ch;
        i += 1;
        continue;
      }
      const parsed = extractDollarParenInner(command, i + 2);
      if (!parsed) {
        result += ch;
        i += 1;
        continue;
      }
      result += parsed.inner;
      i = parsed.nextIndex;
      continue;
    }

    result += ch;
    i += 1;
  }

  return result;
}

function findUnescapedBacktickEnd(command: string, startIndex: number): number {
  let i = startIndex;
  let quote: "'" | '"' | null = null;

  while (i < command.length) {
    const ch = command[i]!;

    if (quote === "'") {
      if (ch === "'") quote = null;
      i += 1;
      continue;
    }

    if (quote === '"') {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === '"') quote = null;
      i += 1;
      continue;
    }

    // quote === null
    if (ch === "'") {
      quote = "'";
      i += 1;
      continue;
    }
    if (ch === '"') {
      quote = '"';
      i += 1;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      i += 2;
      continue;
    }
    if (ch === "`") return i;
    i += 1;
  }

  return -1;
}

function extractDollarParenInner(
  command: string,
  startIndexAfterOpenParen: number,
): { inner: string; nextIndex: number } | null {
  let i = startIndexAfterOpenParen;
  let nesting = 1;
  let quote: "'" | '"' | null = null;

  while (i < command.length) {
    const ch = command[i]!;

    if (quote === "'") {
      if (ch === "'") quote = null;
      i += 1;
      continue;
    }

    if (quote === '"') {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === '"') quote = null;
      i += 1;
      continue;
    }

    // quote === null
    if (ch === "'") {
      quote = "'";
      i += 1;
      continue;
    }
    if (ch === '"') {
      quote = '"';
      i += 1;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      i += 2;
      continue;
    }

    if (ch === "$" && command[i + 1] === "(") {
      nesting += 1;
      i += 2;
      continue;
    }

    if (ch === ")") {
      nesting -= 1;
      i += 1;
      if (nesting === 0) {
        const inner = command.slice(startIndexAfterOpenParen, i - 1);
        return { inner, nextIndex: i };
      }
      continue;
    }

    i += 1;
  }

  return null;
}

function extractAssignmentContextCommandSubstitutionInners(command: string): string[] {
  const inners: string[] = [];
  let i = 0;
  let inSingle = false;

  while (i < command.length) {
    const ch = command[i]!;

    if (inSingle) {
      if (ch === "'") inSingle = false;
      i += 1;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      i += 1;
      continue;
    }

    if (ch === "\\" && i + 1 < command.length) {
      i += 2;
      continue;
    }

    if (ch === "`" && isEnvAssignmentBefore(command, i)) {
      const end = findUnescapedBacktickEnd(command, i + 1);
      if (end === -1) {
        i += 1;
        continue;
      }
      inners.push(command.slice(i + 1, end));
      i = end + 1;
      continue;
    }

    if (ch === "$" && command[i + 1] === "(" && isEnvAssignmentBefore(command, i)) {
      const parsed = extractDollarParenInner(command, i + 2);
      if (!parsed) {
        i += 1;
        continue;
      }
      inners.push(parsed.inner);
      i = parsed.nextIndex;
      continue;
    }

    i += 1;
  }

  return inners;
}

function mergeNewlineSeparatedArgsForMatching(segments: ParsedBashSegment[], index: number): string[] {
  const base = segments[index]!;
  const merged: string[] = [...base.args];
  // Limit lookahead to avoid pathological blowups on very long newline sequences.
  const maxLookaheadSegments = 16;
  let mergedSegments = 0;

  for (let j = index + 1; j < segments.length; j++) {
    if (segments[j]!.separatorBefore !== "\n") break;
    if (mergedSegments >= maxLookaheadSegments) break;
    merged.push(segments[j]!.executable, ...segments[j]!.args);
    mergedSegments += 1;
  }

  return merged;
}

function testRegExpDotAll(re: RegExp, value: string): boolean {
  if (re.flags.includes("s")) return re.test(value);
  const dotAll = new RegExp(re.source, re.flags + "s");
  return dotAll.test(value);
}

/** Parse a full bash command string. Returns structured data including blocked commands and paths. */
export function parseBashCommand(command: string): ParsedBashCommand {
  return parseBashCommandWithDepth(command, 0);
}

function parseBashCommandWithDepth(command: string, depth: number): ParsedBashCommand {
  const canonical = canonicalizeBashCommandForGuardMatching(command);
  let result = parseBashCommandInternal(canonical, depth);
  for (const inner of extractAssignmentContextCommandSubstitutionInners(command)) {
    result = mergeParsedBashCommands(result, parseBashCommandWithDepth(inner, depth));
  }
  return result;
}

function parseBashCommandInternal(command: string, depth: number): ParsedBashCommand {
  const segments = splitBashCommandSegments(command).map(parseSegment);
  const allPaths = segments.flatMap((s) => s.paths);
  const searchCommandCounts = countSearchCommands(segments);
  const blockedCommandDetails: BlockedBashCommand[] = [];

  recordMalformedSearchCommandIfNeeded(segments, blockedCommandDetails);

  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx]!;
    const matchingArgs = mergeNewlineSeparatedArgsForMatching(segments, segIdx);

    // Layer 3: detect blocked git argument patterns
    // Handles both the dispatcher binary (`git <sub> ...`) and standalone
    // subcommand binaries (`/usr/lib/git-core/git-<sub> ...`). The standalone
    // form is exposed by `git --exec-path` and can otherwise bypass these
    // checks.
    const isGitDispatcher = seg.executable === "git";
    const isGitSubBinary = !isGitDispatcher && seg.executable.startsWith("git-");
    if (isGitDispatcher || isGitSubBinary) {
      let subcommand: string | undefined;
      let remainingArgs: string[] = [];

      if (isGitDispatcher) {
        // Find the subcommand by skipping git global options (flags and their
        // values that appear before the first non-flag, non-option-value arg).
        let subcommandIdx = -1;
        for (let i = 0; i < matchingArgs.length; i++) {
          const arg = matchingArgs[i]!;
          if (arg.startsWith("-")) {
            if (GIT_GLOBAL_VALUE_FLAGS.has(arg)) i++;
            continue;
          }
          subcommand = arg;
          subcommandIdx = i;
          break;
        }
        if (subcommand) remainingArgs = matchingArgs.slice(subcommandIdx + 1);
      } else {
        subcommand = seg.executable.slice("git-".length);
        remainingArgs = matchingArgs;
      }

      if (subcommand) {
        if (subcommand === "branch" && isGitBranchCreationCommand(remainingArgs)) {
          recordBlockedCommand(
            blockedCommandDetails,
            seg,
            BLOCKED_GIT_BRANCH_CREATION.message,
            BLOCKED_GIT_BRANCH_CREATION.actionKey,
            BLOCKED_GIT_BRANCH_CREATION.reasonKey,
          );
        }

        // Check for blocked flag/sub-verb patterns. A pattern matches when the
        // subcommand matches and (no modifier required) OR (flag regex matches
        // any remaining arg) OR (subVerb regex matches the first positional
        // arg). Each branch breaks out of the inner pattern loop after
        // recording a violation so a single segment cannot record the same
        // pattern more than once.
        for (const pattern of BLOCKED_GIT_PATTERNS) {
          if (subcommand !== pattern.subcommand) continue;
          if (!pattern.flag && !pattern.subVerb) {
            recordBlockedCommand(blockedCommandDetails, seg, pattern.message, pattern.actionKey, pattern.reasonKey);
            break;
          }
          let matched = false;
          if (pattern.flag) {
            for (const arg of remainingArgs) {
              if (testRegExpDotAll(pattern.flag, arg)) {
                recordBlockedCommand(blockedCommandDetails, seg, pattern.message, pattern.actionKey, pattern.reasonKey);
                matched = true;
                break;
              }
            }
          }
          if (!matched && pattern.subVerb) {
            const firstPositional = remainingArgs.find((arg) => !arg.startsWith("-"));
            if (firstPositional && testRegExpDotAll(pattern.subVerb, firstPositional)) {
              recordBlockedCommand(blockedCommandDetails, seg, pattern.message, pattern.actionKey, pattern.reasonKey);
              matched = true;
            }
          }
          if (matched) break;
        }

        // Detect core.hooksPath manipulation via git -c. Only the dispatcher
        // accepts global flags before the subcommand; standalone subcommand
        // binaries cannot carry `-c core.hooksPath=...`.
        if (isGitDispatcher) {
          for (let i = 0; i < matchingArgs.length; i++) {
            if (
              matchingArgs[i] === "-c" &&
              i + 1 < matchingArgs.length &&
              /^core\.hooksPath/i.test(matchingArgs[i + 1]!)
            ) {
              recordBlockedCommand(
                blockedCommandDetails,
                seg,
                "git -c core.hooksPath is blocked.",
                "git.core_hooks_path",
                "hook_bypass_blocked",
              );
            }
          }
        }

        // Detect persistent core.hooksPath manipulation via `git config`
        // (`git config core.hooksPath ...`, `--global`, `set`, `--unset`, etc.).
        // This disables installed hooks for the whole repo, so it is the same
        // bypass class as `-c core.hooksPath`. The bridge installs Husky's
        // hooksPath through the package-manager prepare lifecycle, not through
        // agent bash, so blocking it here does not affect legitimate setup.
        const configReadOnlyFlags = new Set([
          "--get",
          "--get-all",
          "--get-regexp",
          "--get-urlmatch",
          "--show-origin",
          "--show-scope",
          "-l",
          "--list",
        ]);
        if (
          subcommand === "config" &&
          remainingArgs.some((arg) => /^core\.hooksPath$/i.test(arg)) &&
          !remainingArgs.some((arg) => configReadOnlyFlags.has(arg))
        ) {
          recordBlockedCommand(
            blockedCommandDetails,
            seg,
            "git config core.hooksPath is blocked.",
            "git.config_core_hooks_path",
            "hook_bypass_blocked",
          );
        }

        // Detect core.hooksPath supplied through Git's environment config
        // (`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=... git ...`).
        // The leading env assignments are otherwise skipped during executable
        // resolution, so without this they pass through unchecked.
        if (
          seg.envAssignments.some((assignment) => {
            const eq = assignment.indexOf("=");
            if (eq === -1) return false;
            const key = assignment.slice(0, eq);
            const value = assignment.slice(eq + 1);
            return /^GIT_CONFIG_KEY_\d+$/i.test(key) && /^core\.hooksPath$/i.test(value);
          })
        ) {
          recordBlockedCommand(
            blockedCommandDetails,
            seg,
            "Setting core.hooksPath via GIT_CONFIG_* environment variables is blocked.",
            "git.env_config_core_hooks_path",
            "hook_bypass_blocked",
          );
        }
      }
    }

    // Layer 4: detect blocked CLI patterns (e.g. gh pr create)
    const execName = seg.executable.includes("/")
      ? seg.executable.slice(seg.executable.lastIndexOf("/") + 1)
      : seg.executable;
    for (const pattern of BLOCKED_CLI_PATTERNS) {
      if (execName !== pattern.command) continue;

      // Known global flags that take a value argument (skip flag + value)
      const ghValueFlags = new Set(["-R", "--repo"]);

      // Walk args, skipping global flags, and match positional args against pattern.args
      let matchIdx = 0;
      for (let i = 0; i < matchingArgs.length && matchIdx < pattern.args.length; i++) {
        const arg = matchingArgs[i]!;
        if (arg.startsWith("-")) {
          if (ghValueFlags.has(arg)) i++; // skip the value too
          continue;
        }
        if (arg === pattern.args[matchIdx]) {
          matchIdx++;
        } else {
          break;
        }
      }

      if (matchIdx === pattern.args.length) {
        // If pattern has flags, require at least one to be present in the full args
        if (pattern.flags) {
          const flagSet = new Set(pattern.flags);
          const hasFlag = matchingArgs.some((a) => flagSet.has(a));
          if (!hasFlag) continue;
        }
        recordBlockedCommand(blockedCommandDetails, seg, pattern.message, pattern.actionKey, pattern.reasonKey);
        break;
      }
    }

    // Layer 5: recurse into shell script bodies so wrapped invocations like
    // `bash -lc 'git push origin main'` get the same blocked-pattern enforcement
    // as direct `git push`. Codex emits every tool call wrapped this way, so
    // skipping this layer makes Layers 3-4 ineffective at runtime.
    if (SHELL_EXECUTABLES.has(seg.executable)) {
      const scriptIdx = findShellScriptBodyIdx(matchingArgs);
      if (scriptIdx !== -1) {
        const scriptBody = matchingArgs[scriptIdx]!;
        if (scriptBody) {
          if (depth >= SHELL_SCRIPT_BODY_MAX_DEPTH) {
            // Fail closed: deeply nested wrappers would otherwise bypass
            // blocked-pattern detection by exhausting the recursion budget.
            recordBlockedCommand(
              blockedCommandDetails,
              seg,
              `Nested shell -c wrappers exceeded parser depth (${SHELL_SCRIPT_BODY_MAX_DEPTH}); the command is blocked.`,
              "shell.wrapper.depth",
              "always_blocked",
            );
          } else {
            const inner = parseBashCommandWithDepth(scriptBody, depth + 1);
            for (const detail of inner.blockedCommandDetails) {
              blockedCommandDetails.push(detail);
            }
            for (const p of inner.allPaths) {
              allPaths.push(p);
            }
            addSearchCommandCounts(searchCommandCounts, inner.searchCommandCounts);
          }
        }
      }
    }

    // Layer 5b: `eval` re-evaluates its arguments as a command string, so a
    // blocked command can hide behind `eval "git commit --no-verify"` or
    // `eval git rebase -i`. Reconstruct the payload and recurse for the same
    // enforcement. Unlike shell `-c`, eval joins ALL its args, and bash strips a
    // single leading `--` before evaluating.
    if (seg.executable === "eval") {
      const evalArgs = matchingArgs[0] === "--" ? matchingArgs.slice(1) : matchingArgs;
      const payload = evalArgs.join(" ");
      if (payload) {
        if (/[$`]/.test(payload)) {
          // Unresolved dynamic expansion (e.g. `x=git; eval "$x commit --no-verify"`):
          // command substitution/backticks are already unwrapped by
          // canonicalizeBashCommandForGuardMatching, so a residual `$`/backtick is
          // a variable/param expansion the guard cannot statically resolve. Fail
          // closed rather than let an unanalyzable command through.
          recordBlockedCommand(
            blockedCommandDetails,
            seg,
            "eval with unresolved shell expansion is blocked; the command cannot be safely analyzed.",
            "shell.eval.dynamic",
            "always_blocked",
          );
        } else if (depth >= SHELL_SCRIPT_BODY_MAX_DEPTH) {
          // Fail closed: deeply nested eval/shell wrappers would otherwise bypass
          // detection by exhausting the recursion budget.
          recordBlockedCommand(
            blockedCommandDetails,
            seg,
            `Nested eval/shell wrappers exceeded parser depth (${SHELL_SCRIPT_BODY_MAX_DEPTH}); the command is blocked.`,
            "shell.wrapper.depth",
            "always_blocked",
          );
        } else {
          const inner = parseBashCommandWithDepth(payload, depth + 1);
          for (const detail of inner.blockedCommandDetails) {
            blockedCommandDetails.push(detail);
          }
          for (const p of inner.allPaths) {
            allPaths.push(p);
          }
          addSearchCommandCounts(searchCommandCounts, inner.searchCommandCounts);
        }
      }
    }
  }

  const blockedCommands = blockedCommandDetails.map((detail) => detail.message);

  return {
    segments,
    allPaths,
    searchCommandCounts,
    blockedCommands,
    blockedCommandDetails,
    isDangerous: blockedCommands.length > 0,
  };
}
