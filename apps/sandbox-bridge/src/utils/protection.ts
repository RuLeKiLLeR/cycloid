import { realpathSync } from "node:fs";
import path from "node:path";

import { PLAN_AGENT_NAME } from "../../../../shared/agent/constants.js";
import { REVIEW_LOOP_WORKTREE_BLOCK_PHRASE } from "../../../../shared/transcript/review-loop-worktree-block.js";
import type { ErrorCode, ReviewLoopPromptSourceKind } from "../../../../shared/types/sandbox.js";
import {
  ENV_FILE_CARVE_OUT_SUFFIXES,
  PROTECTED_BASENAME_STEMS,
  PROTECTED_BASENAMES,
  PROTECTED_DIRECTORIES,
  PROTECTED_EXTENSIONS,
} from "../constants/bridge.js";
import { extractApplyPatchPaths } from "../trackers/modified-file-tracker.js";
import type { BlockedBashCommand } from "./bash-parser.js";
import {
  executableName,
  extractShellCommandPayloads,
  parseBashCommand,
  PR_READINESS_SHELL_EXECUTABLES,
} from "./bash-parser.js";
import { normalizePathInput } from "./path-list.js";
import { checkWorkflowRouting, type CycloidCliAuthState } from "./workflow-routing.js";

export type ToolSafetyViolation =
  | { kind: "protected_path"; path: string; message: string; errorCode: ErrorCode }
  | { kind: "blocked_command"; message: string; blockedCommands: BlockedBashCommand[] }
  | { kind: "blocked_tool"; tool: string; reasonKey: string; message: string; errorCode: ErrorCode };

export type ToolSafetyOptions = {
  reviewLoopMode?: boolean;
  worktreeRoot?: string;
  reviewLoopSourceKind?: ReviewLoopPromptSourceKind;
  agentProfile?: string;
  cycloidCliAuthState?: CycloidCliAuthState;
  hasReadOnlyOsSandbox?: boolean;
  getPlanModeToolDisposition?: (toolKey: string) => "readOnly" | "sideEffecting" | null;
};

const ENV_PREFIX = ".env.";
const PLAN_MODE_STATIC_BLOCKED_TOOLS = new Set([
  "apply_patch",
  "edit",
  "write",
  "multiedit",
  "notebookedit",
  "notebook_edit",
  "str_replace_editor",
  "create_file",
  "replace",
  "askuserquestion",
  "ask_user_question",
]);
export const FIRST_PARTY_DYNAMIC_TOOL_NAMESPACES = new Set([
  "cycloid",
  "braintrust",
  "cloudflare",
  "datadog",
  "desktop",
  "jira",
  "launchdarkly",
  "linear",
  "notion",
  "sentry",
  "slack",
  "terraform",
  "vercel",
]);
const DESKTOP_DYNAMIC_TOOL_PREFIX = "desktop.";

// Read-only inspection executables permitted in plan mode. Matched on the
// basename (`/usr/bin/cat` -> `cat`), so absolute paths cannot smuggle a
// non-allowlisted binary past the check.
const PLAN_MODE_READ_ONLY_COMMANDS = new Set([
  "pwd",
  "ls",
  "find",
  "rg",
  "grep",
  "sed",
  "cat",
  "wc",
  "head",
  "tail",
  "nl",
  "date",
  "stat",
  "file",
  "sort",
  "uniq",
  "cut",
  "jq",
]);

// git subcommands that are always read-only regardless of arguments.
const PLAN_MODE_READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "ls-files",
  "for-each-ref",
  "cat-file",
  "describe",
  "blame",
  "shortlog",
]);
// `git remote` subcommands that only read.
const GIT_REMOTE_READ_ONLY_SUBCOMMANDS = new Set(["show", "get-url"]);
// `git branch` flags that mutate refs (delete/move/copy/upstream/force).
const GIT_BRANCH_MUTATING_FLAG =
  /^(?:-d|-D|--delete|-m|-M|--move|-c|-C|--copy|-u|--set-upstream-to(?:=.*)?|--unset-upstream|--edit-description|-f|--force)$/;

// `git branch` / `git remote` have both read-only and mutating forms; allow
// only the read-only ones. Any create target or mutating subcommand fails
// closed — the plan->implement worktree reset (`git reset --hard` + `git clean
// -fd`) cannot undo local ref / remote-config mutations.
function isReadOnlyGitSegment(args: string[]): boolean {
  const positionals = args.filter((arg) => !arg.startsWith("-"));
  const subcommand = positionals[0];
  if (!subcommand) return false;
  if (PLAN_MODE_READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return true;
  if (subcommand === "branch") {
    // A positional after `branch` is a branch name to create; any mutating flag
    // deletes/moves. Bare `git branch [-a|-r|-v|--list|...]` only lists.
    if (positionals.length > 1) return false;
    return !args.some((arg) => GIT_BRANCH_MUTATING_FLAG.test(arg));
  }
  if (subcommand === "remote") {
    const remoteSub = positionals[1];
    // `git remote` / `git remote -v` list; `show`/`get-url` read; everything
    // else (add/remove/rename/set-url/set-head/prune/update/...) mutates.
    return remoteSub === undefined || GIT_REMOTE_READ_ONLY_SUBCOMMANDS.has(remoteSub);
  }
  return false;
}

// Argument forms that mutate or execute even though the base command is on the
// read-only allowlist (`sed -i`, `find -delete/-exec`, ...).
function hasMutatingArgForm(executable: string, args: string[]): boolean {
  if (executable === "sed") {
    return args.some((arg) => /^-[a-z]*i/.test(arg) || arg === "--in-place" || arg.startsWith("--in-place="));
  }
  if (executable === "find") {
    return args.some((arg) => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(arg));
  }
  return false;
}

// Shell-level side effects that run or write regardless of the leading command,
// so the allowlist cannot gate them: command substitution (`$(...)`, backticks),
// process substitution (`<(...)`, `>(...)`), and I/O redirection. Scanned
// quote-aware on the raw command — single quotes suppress everything, double
// quotes still evaluate `$(...)`/backticks — so quoted regex metacharacters
// (`rg 'a|b'`, `rg 'foo$'`) are correctly treated as data, not operators.
function hasPlanModeShellSideEffect(command: string): boolean {
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === '"') quote = undefined;
      else if (ch === "`") return true;
      else if (ch === "$" && next === "(") return true;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "`") return true;
    if (ch === "$" && next === "(") return true;
    if ((ch === "<" || ch === ">") && next === "(") return true;
    if (ch === ">" || ch === "<") return true;
  }
  return false;
}

function isOutsideWorktree(worktreeRoot: string, filePath: string): boolean {
  const root = path.resolve(worktreeRoot);
  const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
  return resolved !== root && !resolved.startsWith(`${root}${path.sep}`);
}

function enforcesReviewLoopWorktreeBoundary(_tool: string): boolean {
  return true;
}

function isPlanMode(options: ToolSafetyOptions): boolean {
  return options.agentProfile === PLAN_AGENT_NAME;
}

function isFirstPartyDynamicToolKey(toolKey: string): boolean {
  const namespace = toolKey.split(".", 1)[0];
  return Boolean(namespace && FIRST_PARTY_DYNAMIC_TOOL_NAMESPACES.has(namespace));
}

function isPlanModeReadOnlyBash(command: string): boolean {
  if (!command.trim()) return true;
  // Agents run shell commands wrapped as `bash -lc "<inner>"` (Codex always
  // does). Unwrap to the inner command(s) before applying the allowlist —
  // otherwise every command is judged by its `/bin/bash` wrapper, which is not
  // allowlisted, and the plan agent can read nothing.
  const payloads = extractShellCommandPayloads(command);
  const inners = payloads.length > 0 ? payloads : [command];
  return inners.every(isPlanModeReadOnlyInnerCommand);
}

function planModeBashPayloads(command: string): string[] {
  const payloads = extractShellCommandPayloads(command);
  return payloads.length > 0 ? payloads : [command];
}

const PLAN_MODE_PROTECTED_READ_INTERPRETERS = new Set(["node", "python", "python3", "perl", "ruby", "awk"]);
const PLAN_MODE_PROTECTED_READ_SHELL_MAX_DEPTH = 4;
const PROTECTED_READ_GLOB_SELECTOR_EXECUTABLES = new Set(["grep", "egrep", "fgrep", "rg", "ripgrep"]);

type GlobClassToken = { type: "literal"; value: string } | { type: "range"; start: string; end: string };

function escapeRegexLiteral(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function escapeRegexCharClassLiteral(value: string): string {
  return value.replace(/[\\\]^[-]/g, "\\$&");
}

function parseGlobBracketExpression(glob: string, startIndex: number): { source: string; endIndex: number } | null {
  let index = startIndex + 1;
  let negated = false;
  if (index >= glob.length) return null;

  const negator = glob[index];
  if (negator === "!" || negator === "^") {
    negated = true;
    index++;
  }

  const tokens: GlobClassToken[] = [];
  if (glob[index] === "]") {
    tokens.push({ type: "literal", value: "]" });
    index++;
  }

  let closed = false;
  while (index < glob.length) {
    const ch = glob[index]!;
    if (ch === "]") {
      closed = true;
      break;
    }
    if (ch === "[" && (glob[index + 1] === ":" || glob[index + 1] === "." || glob[index + 1] === "=")) {
      // Unsupported POSIX classes/collating symbols/equivalence classes must
      // fail closed rather than silently under-match protected paths.
      return null;
    }

    const previous = tokens[tokens.length - 1];
    const next = glob[index + 1];
    const canBeRange =
      ch === "-" &&
      previous?.type === "literal" &&
      next !== undefined &&
      next !== "]" &&
      previous.value.codePointAt(0)! <= next.codePointAt(0)!;
    if (canBeRange) {
      tokens[tokens.length - 1] = {
        type: "range",
        start: previous.value,
        end: next,
      };
      index += 2;
      continue;
    }

    tokens.push({ type: "literal", value: ch });
    index++;
  }

  if (!closed || tokens.length === 0) return null;
  const body = tokens
    .map((token) =>
      token.type === "literal"
        ? escapeRegexCharClassLiteral(token.value)
        : `${escapeRegexCharClassLiteral(token.start)}-${escapeRegexCharClassLiteral(token.end)}`,
    )
    .join("");
  return {
    source: `[${negated ? "^" : ""}${body}]`,
    endIndex: index,
  };
}

function globToRegex(glob: string): RegExp | null {
  let escaped = "";
  for (let index = 0; index < glob.length; index++) {
    const ch = glob[index]!;
    if (ch === "*") {
      escaped += ".*";
      continue;
    }
    if (ch === "?") {
      escaped += ".";
      continue;
    }
    if (ch === "[") {
      const parsed = parseGlobBracketExpression(glob, index);
      if (!parsed) return null;
      escaped += parsed.source;
      index = parsed.endIndex;
      continue;
    }
    escaped += escapeRegexLiteral(ch);
  }
  try {
    return new RegExp(`^${escaped}$`);
  } catch {
    // The bracket-expansion char classes bash accepts are a superset of what a
    // JS RegExp accepts: an out-of-order range (`[nz-a]`) or an unbalanced `[`
    // makes `new RegExp` throw, yet bash still expands the glob — `.e[nz-a]v`
    // globs to `.env`. So the caller must NOT treat a null here as "no match";
    // it means "cannot prove safe" and must fail closed. See
    // couldMatchProtectedPathGlob.
    return null;
  }
}

function couldMatchProtectedPathGlob(value: string): boolean {
  if (!/[*?[]/.test(value)) return false;
  const candidates = [
    ...PROTECTED_BASENAMES,
    ...PROTECTED_DIRECTORIES,
    ...PROTECTED_BASENAME_STEMS,
    ".env",
    ".env.local",
    "private.key",
    "server.pem",
  ];

  for (const component of value.split(/[/\\]/).filter(Boolean)) {
    const regex = globToRegex(component);
    // Fail closed: a component we cannot represent as a JS RegExp may still be
    // a bash glob that expands to a protected file (`cat .e[nz-a]v` -> `.env`),
    // so treat it as a potential match and block rather than skip. This can
    // over-block a legitimate research regex (e.g. `rg '([^/]+)'`, whose `([^`
    // component is unbalanced after the `/` split); plan mode is read-only
    // research, so a blocked call the agent can rephrase is the safe trade
    // against leaking a secret.
    if (!regex) return true;
    if (candidates.some((candidate) => regex.test(candidate))) return true;
  }
  return false;
}

function couldResolveToProtectedBashPath(value: string): boolean {
  return value.includes("[") && couldMatchProtectedPathGlob(value);
}

function hasProtectedPathLiteral(input: string): boolean {
  for (const match of input.matchAll(/["'`]([^"'`\s]+)["'`]/g)) {
    const literal = match[1];
    if (literal && isProtectedPath(literal)) return true;
  }
  const collapsed = input.replace(/["'`\s+]/g, "");
  for (const token of collapsed.split(/[^A-Za-z0-9._/\\-]+/)) {
    if (token && isProtectedPath(token)) return true;
  }
  for (const token of input.split(/\s+/)) {
    const normalized = token.replace(/^[("']+|[)"',;]+$/g, "");
    if (normalized && isProtectedPath(normalized)) return true;
  }
  return false;
}

function argsForProtectedReadLiteralScan(executable: string, args: string[]): string[] {
  if (executable !== "awk") return args;
  const programIndex = args.findIndex((arg) => !arg.startsWith("-"));
  if (programIndex < 0) return args;
  return args.filter((_, index) => index !== programIndex);
}

function hasAwkProtectedReadProgram(args: string[]): boolean {
  const program = args.find((arg) => !arg.startsWith("-"));
  return Boolean(program?.includes("getline") && hasProtectedPathLiteral(program));
}

function extractProtectedReadGlobSelectorArgs(executable: string, args: string[]): string[] {
  if (!PROTECTED_READ_GLOB_SELECTOR_EXECUTABLES.has(executable)) return [];
  const selectors: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if ((arg === "-g" || arg === "--glob" || arg === "--iglob") && index + 1 < args.length) {
      selectors.push(args[index + 1]!);
      index++;
      continue;
    }
    if (arg.startsWith("--glob=")) {
      selectors.push(arg.slice("--glob=".length));
      continue;
    }
    if (arg.startsWith("--iglob=")) {
      selectors.push(arg.slice("--iglob=".length));
      continue;
    }
    if (arg.startsWith("-g") && arg.length > 2) {
      selectors.push(arg.slice(2));
    }
  }
  return selectors;
}

function hasPlanModeProtectedReadBypass(command: string, depth = 0): boolean {
  if (!command.trim()) return false;
  if (hasPlanModeShellSideEffect(command) && hasProtectedPathLiteral(command)) return true;

  const parsed = parseBashCommand(command);
  return parsed.segments.some((segment) => {
    const executable = executableName(segment.executable);
    if (!executable) return false;
    if (segment.paths.some((arg) => couldMatchProtectedPathGlob(arg))) return true;
    if (
      extractProtectedReadGlobSelectorArgs(executable, segment.args).some((arg) => couldMatchProtectedPathGlob(arg))
    ) {
      return true;
    }
    if (depth < PLAN_MODE_PROTECTED_READ_SHELL_MAX_DEPTH && PR_READINESS_SHELL_EXECUTABLES.has(executable)) {
      return extractShellCommandPayloads(segment.raw).some((payload) =>
        hasPlanModeProtectedReadBypass(payload, depth + 1),
      );
    }
    if (!PLAN_MODE_PROTECTED_READ_INTERPRETERS.has(executable)) return false;
    if (executable === "awk" && hasAwkProtectedReadProgram(segment.args)) return true;
    return argsForProtectedReadLiteralScan(executable, segment.args).some((arg) => hasProtectedPathLiteral(arg));
  });
}

function isPlanModeProtectedReadSafeBash(command: string): boolean {
  return planModeBashPayloads(command).every((inner) => !hasPlanModeProtectedReadBypass(inner));
}

function isPlanModeReadOnlyInnerCommand(command: string): boolean {
  if (!command.trim()) return false;
  // Shell-level side effects bypass the per-command allowlist entirely.
  if (hasPlanModeShellSideEffect(command)) return false;
  // Quote-aware parse: `rg 'a|b'` / `rg 'foo$'` stay single segments with the
  // metacharacters as data, instead of being mis-split into non-allowlisted
  // pseudo-commands.
  const parsed = parseBashCommand(command);
  if (parsed.segments.length === 0) return false;
  return parsed.segments.every((segment) => {
    // A leading `VAR=val` (e.g. `PATH=/x cat`) can redirect which binary runs;
    // it is never needed for read-only research, so fail closed.
    if (segment.envAssignments.length > 0) return false;
    const executable = executableName(segment.executable);
    if (!executable) return false;
    if (executable === "git") return isReadOnlyGitSegment(segment.args);
    if (!PLAN_MODE_READ_ONLY_COMMANDS.has(executable)) return false;
    return !hasMutatingArgForm(executable, segment.args);
  });
}

function checkPlanModeSafety(
  tool: string,
  input: Record<string, unknown>,
  options: ToolSafetyOptions,
): ToolSafetyViolation | null {
  if (!isPlanMode(options)) return null;
  const toolKey = tool.toLowerCase();
  if (toolKey === "bash") {
    const command = typeof input.command === "string" ? input.command : "";
    if (options.hasReadOnlyOsSandbox === true) {
      if (isPlanModeProtectedReadSafeBash(command)) return null;
    } else if (isPlanModeReadOnlyBash(command)) return null;
    return {
      kind: "blocked_tool",
      tool,
      reasonKey: "plan_mode_read_only",
      errorCode: "policy_block",
      message:
        "Policy block: plan mode is read-only. Use read-only inspection commands only; do not edit files, run tests/builds, install dependencies, or perform side effects.",
    };
  }
  if (PLAN_MODE_STATIC_BLOCKED_TOOLS.has(toolKey)) {
    return {
      kind: "blocked_tool",
      tool,
      reasonKey: "plan_mode_read_only",
      errorCode: "policy_block",
      message: `Policy block: plan mode is read-only; tool "${tool}" is not permitted.`,
    };
  }
  const planModeDisposition = options.getPlanModeToolDisposition?.(toolKey) ?? null;
  if (planModeDisposition === "readOnly") return null;
  if (planModeDisposition === "sideEffecting" && toolKey.startsWith(DESKTOP_DYNAMIC_TOOL_PREFIX)) return null;
  if (planModeDisposition === "sideEffecting" || isFirstPartyDynamicToolKey(toolKey)) {
    return {
      kind: "blocked_tool",
      tool,
      reasonKey: "plan_mode_read_only",
      errorCode: "policy_block",
      message: `Policy block: plan mode is read-only; tool "${tool}" is not permitted.`,
    };
  }
  return null;
}

/**
 * Returns true if the path refers to a protected file. Performs structural
 * matching on path components rather than substring regex on the raw path,
 * so command-arg tokens that happen to contain a protected substring (e.g.
 * `process.env.X`) are not falsely matched.
 */
export function isProtectedPath(filePath: string): boolean {
  const segments = filePath.split(/[/\\]/).filter(Boolean);
  if (segments.length === 0) return false;

  for (let i = 0; i < segments.length - 1; i++) {
    if (PROTECTED_DIRECTORIES.has(segments[i])) return true;
  }

  const basename = segments[segments.length - 1];
  if (PROTECTED_BASENAMES.has(basename)) return true;

  for (const stem of PROTECTED_BASENAME_STEMS) {
    if (basename === stem || basename.startsWith(`${stem}.`)) return true;
  }

  if (basename.startsWith(ENV_PREFIX)) {
    const suffix = basename.slice(ENV_PREFIX.length);
    if (suffix.length > 0 && !ENV_FILE_CARVE_OUT_SUFFIXES.has(suffix)) return true;
  }

  const dotIdx = basename.lastIndexOf(".");
  if (dotIdx > 0) {
    const ext = basename.slice(dotIdx + 1).toLowerCase();
    if (PROTECTED_EXTENSIONS.has(ext)) return true;
  }

  return false;
}

/** Extract file paths from a tool call's input based on the tool type. */
export function extractPaths(tool: string, input: Record<string, unknown>): string[] {
  const paths: string[] = normalizePathInput(input.file_path ?? input.filePath ?? input.path);
  const toolLower = tool.toLowerCase();

  if (toolLower === "apply_patch") {
    if (typeof input.patch === "string") {
      paths.push(...extractApplyPatchPaths(input.patch));
    }
  }

  if (toolLower === "bash" && typeof input.command === "string") {
    paths.push(...parseBashCommand(input.command).allPaths);
  }

  return paths;
}

function resolveSymlinkPathBestEffort(filePath: string, baseRoot?: string): string | null {
  try {
    // `realpathSync` resolves both symlinks and path segments like `..`.
    // We keep this as a best-effort probe so nonexistent paths still
    // fall back to structural protection.
    const root = path.resolve(baseRoot ?? process.cwd());
    const abs = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
    return realpathSync(abs);
  } catch {
    return null;
  }
}

/** Check all paths in a tool call for protection violations. Returns the first protected path or null. */
export function checkToolProtection(
  tool: string,
  input: Record<string, unknown>,
  options: ToolSafetyOptions = {},
): string | null {
  const paths = extractPaths(tool, input);
  const toolLower = tool.toLowerCase();
  if (options.reviewLoopMode && options.worktreeRoot && enforcesReviewLoopWorktreeBoundary(tool)) {
    for (const p of paths) {
      if (isOutsideWorktree(options.worktreeRoot, p)) return p;
    }
  }
  for (const p of paths) {
    if (isProtectedPath(p)) return p;
    if (toolLower === "bash" && couldResolveToProtectedBashPath(p)) return p;
    const resolved = resolveSymlinkPathBestEffort(p, options.worktreeRoot);
    if (resolved && isProtectedPath(resolved)) return resolved;
  }
  return null;
}

/**
 * Return the first safety violation for a tool call, or null if it is safe.
 *
 * Guard ordering is explicit: protected-path enforcement (this module) runs
 * first; workflow-routing enforcement (`workflow-routing.ts`) runs second.
 * Path-side hits short-circuit before any command parsing.
 */
export function checkToolSafety(
  tool: string,
  input: Record<string, unknown>,
  options: ToolSafetyOptions = {},
): ToolSafetyViolation | null {
  try {
    return checkToolSafetyUnguarded(tool, input, options);
  } catch (error) {
    // A safety-layer bug must never escape and fail the whole prompt run
    // (every runtime adapter calls this synchronously per tool call). Fail
    // closed on the single call so the agent can rephrase and continue.
    return {
      kind: "blocked_tool",
      tool,
      reasonKey: "tool_safety_internal_error",
      errorCode: "policy_block",
      message: `Policy block: tool safety check failed internally; simplify or rephrase the tool arguments and retry. (${
        error instanceof Error ? error.message : String(error)
      })`,
    };
  }
}

function checkToolSafetyUnguarded(
  tool: string,
  input: Record<string, unknown>,
  options: ToolSafetyOptions,
): ToolSafetyViolation | null {
  const protectedPath = checkToolProtection(tool, input, options);
  if (protectedPath) {
    const reviewLoopOutsideWorktree =
      options.reviewLoopMode &&
      options.worktreeRoot &&
      enforcesReviewLoopWorktreeBoundary(tool) &&
      isOutsideWorktree(options.worktreeRoot, protectedPath);
    return {
      kind: "protected_path",
      path: protectedPath,
      errorCode: "policy_block",
      message: reviewLoopOutsideWorktree
        ? `Policy block: ${REVIEW_LOOP_WORKTREE_BLOCK_PHRASE} "${protectedPath}"`
        : `Policy block: protected path "${protectedPath}"`,
    };
  }

  const planModeViolation = checkPlanModeSafety(tool, input, options);
  if (planModeViolation) return planModeViolation;

  const routing = checkWorkflowRouting(tool, input, {
    reviewLoopMode: options.reviewLoopMode,
    cycloidCliAuthState: options.cycloidCliAuthState,
  });
  if (routing) {
    return { kind: "blocked_command", message: routing.message, blockedCommands: routing.blockedCommands };
  }

  if (options.reviewLoopMode && !isToolAllowedInReviewLoopSession(tool, { sourceKind: options.reviewLoopSourceKind })) {
    return {
      kind: "blocked_tool",
      tool,
      reasonKey: "review_loop_source_kind_blocked",
      errorCode: "policy_block",
      message: `Policy block: tool "${tool}" is not permitted for this review-loop source kind.`,
    };
  }

  return null;
}

/**
 * Returns true if a named tool is permitted to execute inside a review-loop session.
 *
 * Defense-in-depth layer (T24): evaluated independently of the dynamic-tool registration
 * gate (T23 / buildReviewSummaryCommentDynamicToolSpec).
 *
 * Rules:
 * - cycloid.review_summary_comment → only permitted when sourceKind is "human" or "mixed"
 * - cycloid.review_loop_reply → permitted for every sourceKind (including missing)
 * - all other tools → permitted unconditionally (path and command safety is handled
 *   by checkToolSafety / checkToolProtection)
 */
export function isToolAllowedInReviewLoopSession(
  toolKey: string,
  options: { sourceKind?: ReviewLoopPromptSourceKind },
): boolean {
  if (toolKey === "cycloid.review_summary_comment") {
    const { sourceKind } = options;
    return sourceKind === "human" || sourceKind === "mixed";
  }
  return true;
}

/** Stable non-cryptographic hash for tool-call accounting (artifact filenames, ack ids). */
export function simpleHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16);
}
