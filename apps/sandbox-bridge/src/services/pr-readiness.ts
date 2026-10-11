import {
  commandLabel as classifyRelevantCommandLabel,
  commandLooksFailed,
  isRelevantCheckCommand,
} from "../../../../shared/command-classification.js";
import { redact, redactObject, tailTruncate, truncate } from "../../../../shared/observability/redact.js";
import type { AgentTimelineEntry } from "../../../../shared/types/agent-timeline.js";
import type { PrReadinessCheck, PrReadinessCommand, PrReadinessEvidence } from "../../../../shared/types/sandbox.js";
import type { BridgeLogger } from "../logger.js";
import {
  commandExecutableName,
  type CommandToken,
  executableName,
  extractShellCommandPayloads,
  isShellCommandSeparator,
  PR_READINESS_SHELL_EXECUTABLES,
  tokenizeCommand,
  tokenizeCommandWithSpans,
} from "../utils/bash-parser.js";
import { TEST_FILE_PATTERN } from "../utils/diagnostics.js";
import { stripAnsiEscapeCodes } from "./ansi.js";

const CHECK_COMMAND_PATTERNS: Record<PrReadinessCheck, RegExp[]> = {
  tests: [
    /\b(?:npx\s+)?(?:vitest|jest|playwright)\b/i,
    /\bnode\s+--test\b/i,
    /\bpytest\b/i,
    /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b/i,
    /\bjust\s+test\s+(?:core|dag-data|dag-ops|functions)(?=\s|$)/i,
    /\bjust\s+dag\s+(?:data|ops)\s+test(?=\s|$)/i,
  ],
  lint: [
    /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?lint\b/i,
    /\beslint\b/i,
    /\bbiome\s+check\b/i,
    /\boxlint\b/i,
    /\boxfmt\b.*--check\b/i,
    /\bprettier\s+(?:--check|-c)\b/i,
    /\bactionlint\b/i,
    /\byamllint\b/i,
    /\buv\s+run\s+ruff\s+(?:check|format\s+--check)\b/i,
    /\bjust\s+check\s+(?:core|dag-data|dag-ops|db_user_mgmt|tech_support_tools)(?=\s|$)/i,
  ],
  typecheck: [
    /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?typecheck\b/i,
    /\btsc\b.*--noEmit\b/i,
    /\bnode\s+--check\b/i,
    /(?:^|\s)(?:uv\s+run\s+)?pyright\b/i,
    /\bnpx\s+-y\s+pyright@latest\b/i,
  ],
};

const RECOVERABLE_SERVER_ALREADY_RUNNING_OUTPUT_PATTERN =
  /\b(?:EADDRINUSE|ERR_SERVER_ALREADY_LISTEN|address already in use|server already running|already listening|port\s+\d+[^.\n]*(?:already in use|in use))\b/i;

const CHECK_ORDER = ["tests", "lint", "typecheck"] as const satisfies readonly PrReadinessCheck[];

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn"]);
const MAX_COMMAND_OUTPUT_SUMMARY_LENGTH = 240;
// Positive result lines only: a non-zero pass tally, a 2xx/3xx HTTP status, or an
// "OK (N tests)" summary. We deliberately do NOT prefer "0 passed", failure
// tallies, or 4xx/5xx status lines as the summary of a completed command — those
// fall through to the tail excerpt, which still surfaces them. A combined
// "N passed, M failed" line still matches (and renders whole) via the pass tally.
const RESULT_LINE_PATTERNS: RegExp[] = [
  /\b[1-9]\d*\s+passed\b/i,
  /\bHTTP\/\d(?:\.\d)?\s+[23]\d{2}\b/i,
  /\bOK\b\s*\(\d+\s+tests?\)/i,
];

const MAX_FAILED_COMMAND_OUTPUT_LENGTH = 20_000;
const PACKAGE_MANAGER_VALUE_OPTIONS = new Set([
  "--config",
  "--cwd",
  "--dir",
  "--filter",
  "--global-folder",
  "--modules-dir",
  "--package",
  "--prefix",
  "--registry",
  "--reporter",
  "--scope",
  "--store-dir",
  "--userconfig",
  "--workspace",
  "-C",
  "-w",
]);

export function isUnsupportedTypecheckSkipReason(reason: string | undefined): boolean {
  return Boolean(
    reason?.trim().match(/^No package\.json(?: typecheck script)? found; skipping repository typecheck\.$/i),
  );
}

export function isUnsupportedTypecheckSkip(
  command: Pick<PrReadinessCommand, "check" | "status" | "skipReason" | "summary">,
): boolean {
  return (
    command.check === "typecheck" &&
    command.status === "skipped" &&
    isUnsupportedTypecheckSkipReason(command.skipReason ?? command.summary)
  );
}

export function isRecoveredFailedCommand(commands: ReadonlyArray<PrReadinessCommand>, index: number): boolean {
  const command = commands[index];
  if (!command || !commandLooksFailed(command)) return false;
  return commands.slice(index + 1).some((laterCommand) => commandRecoversFailure(command, laterCommand));
}

export function verificationTargetKeys(command: { command?: string }): string[] {
  const keys = new Set<string>();
  for (const form of commandExecutionForms(command.command ?? "")) {
    for (const { kind, extract } of VERIFICATION_TARGET_EXTRACTORS) {
      for (const target of extract(form)) keys.add(`${kind}:${target}`);
    }
  }
  return [...keys];
}

export function verificationTargetsFullyCovered(
  failedTargetKeys: readonly string[],
  passedTargetKeys: Iterable<string>,
): boolean {
  if (failedTargetKeys.length === 0) return false;
  const passedTargets = Array.from(passedTargetKeys);
  return failedTargetKeys.every((failedTarget) =>
    passedTargets.some((passedTarget) => verificationTargetCovers(passedTarget, failedTarget)),
  );
}

type BuildPrReadinessEvidenceInput = {
  changedFiles: string[];
  diffStat?: string;
  commandsRun: PrReadinessCommand[];
  finalAnswer: string;
  evidenceBundle?: PrReadinessEvidence["evidenceBundle"];
  agentTimeline?: AgentTimelineEntry[];
};

const MAX_COMMAND_EVIDENCE_LENGTH = 500;
const REDACTED_VALUE = "[REDACTED]";
const SENSITIVE_SHORT_CLI_OPTIONS = new Set(["-p", "-pw"]);
const SENSITIVE_SHORT_CLI_OPTION_PREFIXES = [...SENSITIVE_SHORT_CLI_OPTIONS].sort(
  (left, right) => right.length - left.length,
);
const INLINE_PASSWORD_SHORT_OPTION_COMMANDS = new Set([
  "mariadb",
  "mariadb-admin",
  "mariadb-dump",
  "mysql",
  "mysqladmin",
  "mysqldump",
  "sshpass",
]);
type CommandExecutionForm = {
  command: string;
  cwd?: string;
};

export function buildPostExecutionCommandEvidence(input: {
  command?: string[];
  ok: boolean;
  output: string;
  exitCode: number | null;
  skipped?: boolean;
  skipReason?: string;
  check: PrReadinessCheck;
}): PrReadinessCommand {
  const command = input.command ? redactedCommandEvidence(input.command.join(" ")) : commandLabel(input.check);
  const summary = summarizeCommandOutput(input.output);
  const failureOutput = failedCommandOutput(input.skipped ? "skipped" : input.ok ? "completed" : "error", input.output);
  return {
    command,
    status: input.skipped ? "skipped" : input.ok ? "completed" : "error",
    exitCode: input.exitCode,
    source: "post_execution",
    check: input.check,
    hasOutput: input.output.trim().length > 0 || Boolean(input.skipReason),
    ...(summary ? { summary } : {}),
    ...(failureOutput ? { failureOutput } : {}),
    ...(input.skipReason ? { skipReason: input.skipReason } : {}),
  };
}

export function buildPrReadinessEvidence(
  input: BuildPrReadinessEvidenceInput,
  log?: BridgeLogger,
): PrReadinessEvidence {
  const explicitChangedFiles = input.changedFiles.map(normalizeRepoPath).filter(Boolean);
  const changedFiles = uniqueSorted(
    (explicitChangedFiles.length > 0 ? explicitChangedFiles : extractChangedFilesFromDiffStat(input.diffStat)).filter(
      Boolean,
    ),
  );
  const commandsRun = normalizeCommands(input.commandsRun);
  const checksDetected = detectChecks(changedFiles, commandsRun);
  const skippedChecks = detectSkippedChecks(checksDetected, commandsRun);
  const filesMentionedInFinalAnswer = extractFilesMentionedInFinalAnswer(input.finalAnswer);
  const normalizedAgentTimeline = input.agentTimeline ? normalizeAgentTimeline(input.agentTimeline) : [];

  const evidence: PrReadinessEvidence = {
    changedFiles,
    diffStats: parseGitDiffStats(input.diffStat),
    commandsRun,
    checksDetected,
    skippedChecks,
    filesMentionedInFinalAnswer,
    ...(normalizedAgentTimeline.length > 0 ? { agentTimeline: normalizedAgentTimeline } : {}),
    ...(input.evidenceBundle ? { evidenceBundle: normalizeEvidenceBundle(input.evidenceBundle) } : {}),
  };

  log?.debug(
    {
      event: "pr_readiness_evidence_collected",
      changedFileCount: changedFiles.length,
      commandCount: commandsRun.length,
    },
    "PR readiness evidence collected",
  );

  return evidence;
}

function normalizeAgentTimeline(entries: AgentTimelineEntry[]): AgentTimelineEntry[] {
  return entries
    .filter((entry) => entry.source === "observed" && entry.summary.trim().length > 0)
    .map((entry) => ({
      eventType: entry.eventType,
      source: entry.source,
      observer: entry.observer,
      summary: truncate(entry.summary.trim(), 180),
      ...(entry.promptId ? { promptId: entry.promptId } : {}),
      ...(entry.timestampMs !== undefined ? { timestampMs: entry.timestampMs } : {}),
      ...(entry.status ? { status: entry.status } : {}),
      ...(entry.metadata ? { metadata: redactObject(entry.metadata) } : {}),
    }));
}

function normalizeEvidenceBundle(
  bundle: NonNullable<PrReadinessEvidence["evidenceBundle"]>,
): NonNullable<PrReadinessEvidence["evidenceBundle"]> {
  const finalSummary = stripAnsiEscapeCodes(bundle.finalSummary ?? "").trim();
  const agentFinalMessage = stripAnsiEscapeCodes(bundle.agentFinalMessage ?? "").trim();
  return {
    ...(bundle.originalPrompt?.trim() ? { originalPrompt: redact(bundle.originalPrompt.trim()) } : {}),
    ...(finalSummary ? { finalSummary: truncate(redact(finalSummary), 1_000) } : {}),
    ...(agentFinalMessage ? { agentFinalMessage: truncate(redact(agentFinalMessage), 2_000) } : {}),
    ...(bundle.sessionUrl?.trim() ? { sessionUrl: bundle.sessionUrl.trim() } : {}),
    ...(bundle.issueUrl?.trim() ? { issueUrl: bundle.issueUrl.trim() } : {}),
  };
}

function commandLabel(checksOrCheck: PrReadinessCheck | readonly PrReadinessCheck[] | undefined): string {
  const checks = Array.isArray(checksOrCheck) ? checksOrCheck : checksOrCheck ? [checksOrCheck] : [];
  if (checks.length === 1) return `${checks[0]} check`;
  if (checks.length > 1) return `${checks.join("/")} checks`;
  return "command unavailable";
}

function redactedCommandEvidence(command: string): string {
  return truncate(redactCommandLineSecrets(redact(command)).replace(/\s+/g, " ").trim(), MAX_COMMAND_EVIDENCE_LENGTH);
}

function redactCommandLineSecrets(command: string, depth = 0): string {
  const tokens = tokenizeCommandWithSpans(command);
  if (tokens.length === 0) return command;

  const replacements: Array<{ start: number; end: number; value: string }> = quotedShellPayloadReplacements(
    command,
    tokens,
    depth,
  );
  let currentExecutable: string | undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (isShellCommandSeparator(token.value)) {
      currentExecutable = undefined;
      continue;
    }
    currentExecutable ??= commandExecutableName(token.value);

    const equalsIndex = token.value.indexOf("=");
    const option = equalsIndex >= 0 ? token.value.slice(0, equalsIndex) : token.value;

    if (equalsIndex >= 0) {
      if (!isSensitiveCliOption(option)) continue;
      replacements.push({
        start: token.start,
        end: token.end,
        value: `${option}=${REDACTED_VALUE}`,
      });
      continue;
    }

    if (isSensitiveCliOption(option)) {
      const nextToken = tokens[index + 1];
      if (!nextToken || isLikelyCliOption(nextToken.value)) continue;
      replacements.push({ start: nextToken.start, end: nextToken.end, value: REDACTED_VALUE });
      index += 1;
      continue;
    }

    const inlineShortOption = sensitiveInlineShortCliOption(token.value, currentExecutable);
    if (!inlineShortOption) continue;
    replacements.push({
      start: token.start,
      end: token.end,
      value: `${inlineShortOption}${REDACTED_VALUE}`,
    });
  }

  if (replacements.length === 0) return command;

  let redacted = "";
  let cursor = 0;
  for (const replacement of replacements.sort((left, right) => left.start - right.start)) {
    redacted += command.slice(cursor, replacement.start);
    redacted += replacement.value;
    cursor = replacement.end;
  }
  redacted += command.slice(cursor);
  return redacted;
}

function quotedShellPayloadReplacements(
  command: string,
  tokens: CommandToken[],
  depth: number,
): Array<{ start: number; end: number; value: string }> {
  if (depth >= 4) return [];

  const replacements: Array<{ start: number; end: number; value: string }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const executable = commandExecutableName(tokens[index]!.value);
    if (!executable || !PR_READINESS_SHELL_EXECUTABLES.has(executable)) continue;

    let cursor = index + 1;
    while (cursor < tokens.length) {
      const token = tokens[cursor]!;
      if (isShellCommandSeparator(token.value)) break;
      if (token.value === "--") {
        cursor += 1;
        continue;
      }
      if (!token.value.startsWith("-") || token.value === "-") break;

      const runsCommandString = /^-[A-Za-z]*c[A-Za-z]*$/.test(token.value);
      cursor += 1;
      if (!runsCommandString) continue;

      const payloadToken = tokens[cursor];
      const payloadSpan = quotedTokenInnerSpan(payloadToken);
      if (!payloadSpan) break;

      const payload = command.slice(payloadSpan.start, payloadSpan.end);
      const redactedPayload = redactCommandLineSecrets(payload, depth + 1);
      if (redactedPayload !== payload) {
        replacements.push({ start: payloadSpan.start, end: payloadSpan.end, value: redactedPayload });
      }
      break;
    }
  }
  return replacements;
}

function quotedTokenInnerSpan(token: CommandToken | undefined): { start: number; end: number } | undefined {
  if (!token || token.value.length < 2) return undefined;
  const quote = token.value[0];
  if ((quote !== "'" && quote !== '"') || token.value[token.value.length - 1] !== quote) return undefined;
  return { start: token.start + 1, end: token.end - 1 };
}

function isSensitiveCliOption(option: string): boolean {
  if (SENSITIVE_SHORT_CLI_OPTIONS.has(option.toLowerCase())) return true;

  const normalized = option.startsWith("--")
    ? option.slice(2).toLowerCase().replace(/_/g, "-")
    : option.startsWith("-") && option.length > 2
      ? option.slice(1).toLowerCase().replace(/_/g, "-")
      : "";
  if (normalized.length === 0) return false;

  return (
    /(?:^|-)(?:password|passwd|pwd|pass|secret|token|credential|credentials|cookie)$/.test(normalized) ||
    /(?:^|-)(?:api-key|apikey|access-key|private-key|client-secret|auth-token|refresh-token|session-token)$/.test(
      normalized,
    )
  );
}

function sensitiveInlineShortCliOption(value: string, executable: string | undefined): string | undefined {
  if (!executable || !INLINE_PASSWORD_SHORT_OPTION_COMMANDS.has(executable)) return undefined;

  const lowerValue = value.toLowerCase();
  for (const option of SENSITIVE_SHORT_CLI_OPTION_PREFIXES) {
    if (!lowerValue.startsWith(option) || value.length <= option.length) continue;

    const inlineValue = value.slice(option.length);
    if (/^\d+$/.test(inlineValue)) continue;
    return value.slice(0, option.length);
  }
  return undefined;
}

function isLikelyCliOption(value: string): boolean {
  return /^-{1,2}[A-Za-z][\w-]*(?:=.*)?$/.test(value);
}

function normalizeCommands(commandsRun: PrReadinessCommand[]): PrReadinessCommand[] {
  return commandsRun
    .map((inputCommand) => {
      const { checks: inputChecks, ...command } = inputCommand;
      const checks = uniqueChecks([...(inputChecks ?? []), command.check, ...detectCommandChecks(command.command)]);
      const check = command.check ?? checks[0];
      const summary = stripAnsiEscapeCodes(command.summary ?? "").trim();
      const failureOutput = stripAnsiEscapeCodes(command.failureOutput ?? "").trim();
      return {
        ...command,
        command: redactedCommandEvidence(command.command),
        check,
        ...(checks.length > 1 ? { checks } : {}),
        exitCode: typeof command.exitCode === "number" ? command.exitCode : null,
        ...(summary ? { summary: truncate(redact(summary), MAX_COMMAND_OUTPUT_SUMMARY_LENGTH) } : {}),
        ...(failureOutput
          ? { failureOutput: tailTruncate(redact(failureOutput), MAX_FAILED_COMMAND_OUTPUT_LENGTH) }
          : {}),
      };
    })
    .filter((command) => command.command.length > 0);
}

function summarizeCommandOutput(output: string): string | undefined {
  const lines = stripAnsiEscapeCodes(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const resultLine = [...lines].reverse().find((line) => RESULT_LINE_PATTERNS.some((pattern) => pattern.test(line)));
  if (resultLine) return truncate(redact(resultLine), MAX_COMMAND_OUTPUT_SUMMARY_LENGTH);

  const tailLines = lines.slice(-3);
  const recoverableServerLine = lines.find((line) => RECOVERABLE_SERVER_ALREADY_RUNNING_OUTPUT_PATTERN.test(line));
  const excerptLines =
    recoverableServerLine && !tailLines.includes(recoverableServerLine)
      ? [recoverableServerLine, ...tailLines]
      : tailLines;
  const excerpt = excerptLines.join(" | ");
  if (!excerpt) return undefined;
  return truncate(redact(excerpt), MAX_COMMAND_OUTPUT_SUMMARY_LENGTH);
}

function failedCommandOutput(status: PrReadinessCommand["status"], output: string | undefined): string | undefined {
  if (status !== "error") return undefined;
  const trimmed = stripAnsiEscapeCodes(output ?? "").trim();
  if (!trimmed) return undefined;
  return tailTruncate(redact(trimmed), MAX_FAILED_COMMAND_OUTPUT_LENGTH);
}

function normalizeRepoPath(filePath: string): string {
  return filePath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function stripCommandPathToken(token: string): string {
  return token
    .replace(/^[`"']+|[`"',;]+$/g, "")
    .replace(/\\/g, "/")
    .trim();
}

function normalizeRelativeRepoPath(value: string): string | undefined {
  let normalized = stripCommandPathToken(value);
  if (!normalized) return undefined;
  normalized = normalized
    .replace(/^\/workspace\/repo\//, "")
    .replace(/^\/workspaces\/[^/]+\//, "")
    .replace(/^\/repo\//, "");
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(normalized)) return undefined;
  if (normalized.startsWith("/") || normalized.startsWith("~") || normalized.startsWith("$")) return undefined;

  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/") || ".";
}

function joinCommandPath(baseDir: string | undefined, target: string): string | undefined {
  const normalizedTarget = normalizeRelativeRepoPath(target);
  if (!normalizedTarget) return normalizeRelativeRepoPath(baseDir ?? "");
  if (normalizedTarget === ".") return normalizeRelativeRepoPath(baseDir ?? "") ?? ".";

  const normalizedBase = normalizeRelativeRepoPath(baseDir ?? "");
  if (!normalizedBase || normalizedBase === ".") return normalizedTarget;
  return normalizeRelativeRepoPath(`${normalizedBase}/${normalizedTarget}`);
}

function applyCommandBaseDir(target: string, baseDir: string | undefined): string | undefined {
  const normalizedTarget = normalizeRelativeRepoPath(target);
  if (!normalizedTarget) return undefined;

  const normalizedBase = normalizeRelativeRepoPath(baseDir ?? "");
  if (!normalizedBase || normalizedBase === ".") return normalizedTarget;
  if (normalizedTarget === ".") return normalizedBase;
  if (normalizedTarget === normalizedBase || normalizedTarget.startsWith(`${normalizedBase}/`)) return normalizedTarget;
  return normalizeRelativeRepoPath(`${normalizedBase}/${normalizedTarget}`);
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function uniqueChecks(values: Array<PrReadinessCheck | undefined>): PrReadinessCheck[] {
  const checks = new Set(values.filter((value): value is PrReadinessCheck => Boolean(value)));
  return CHECK_ORDER.filter((check) => checks.has(check));
}

function detectCommandChecks(command: string): PrReadinessCheck[] {
  return CHECK_ORDER.filter((check) => commandMatchesCheck(command, check));
}

function commandMatchesCheck(command: string, check: PrReadinessCheck): boolean {
  return commandDetectionForms(command).some((candidate) => {
    if (check === "tests" && matchesPackageManagerScriptCommand(candidate, isTestScriptToken)) return true;
    if (check === "typecheck" && matchesPackageManagerScriptCommand(candidate, isTypecheckScriptToken)) return true;
    if (check === "lint" && matchesPackageManagerScriptCommand(candidate, isLintScriptToken)) return true;
    return CHECK_COMMAND_PATTERNS[check].some((pattern) => pattern.test(candidate));
  });
}

function commandDetectionForms(command: string): string[] {
  const forms: string[] = [];
  const seen = new Set<string>();

  const visit = (candidate: string, depth: number) => {
    const normalized = candidate.trim();
    if (!normalized || seen.has(normalized) || depth > 4) return;
    seen.add(normalized);
    forms.push(normalized);

    for (const payload of extractShellCommandPayloads(normalized)) {
      visit(payload, depth + 1);
    }
  };

  visit(command, 0);
  return forms;
}

function commandExecutionForms(command: string): CommandExecutionForm[] {
  const forms: CommandExecutionForm[] = [];
  const seen = new Set<string>();

  const visit = (candidate: string, cwd: string | undefined, depth: number) => {
    const normalized = candidate.trim();
    const normalizedCwd = normalizeRelativeRepoPath(cwd ?? "");
    const key = `${normalizedCwd ?? ""}\0${normalized}`;
    if (!normalized || seen.has(key) || depth > 4) return;
    seen.add(key);

    for (const payload of extractShellCommandPayloads(normalized)) {
      visit(payload, normalizedCwd, depth + 1);
    }

    const cdPayload = extractLeadingCdPayload(normalized, normalizedCwd);
    if (cdPayload) {
      visit(cdPayload.command, cdPayload.cwd, depth + 1);
      return;
    }

    forms.push({
      command: normalized,
      ...(normalizedCwd ? { cwd: normalizedCwd } : {}),
    });
  };

  visit(command, undefined, 0);
  return forms;
}

function extractLeadingCdPayload(
  command: string,
  inheritedCwd: string | undefined,
): { command: string; cwd: string } | undefined {
  const tokens = tokenizeCommand(command);
  const executable = executableName(tokens[0]);
  if (executable !== "cd") return undefined;

  const targetDir = tokens[1];
  if (!targetDir || targetDir.startsWith("-")) return undefined;

  const separatorIndex = tokens.findIndex((token, index) => index > 1 && isShellCommandSeparator(token));
  if (separatorIndex < 0 || separatorIndex + 1 >= tokens.length) return undefined;

  const cwd = joinCommandPath(inheritedCwd, targetDir);
  if (!cwd) return undefined;

  return {
    cwd,
    command: tokens.slice(separatorIndex + 1).join(" "),
  };
}

function matchesPackageManagerScriptCommand(
  command: string,
  matchesScriptToken: (token: string | undefined) => boolean,
): boolean {
  const tokens = tokenizeCommand(command);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index].split(/[\\/]/).pop()?.toLowerCase();
    if (!token || !PACKAGE_MANAGERS.has(token)) continue;
    if (packageManagerRunsScript(tokens, index + 1, matchesScriptToken)) return true;
  }
  return false;
}

function packageManagerRunsScript(
  tokens: string[],
  startIndex: number,
  matchesScriptToken: (token: string | undefined) => boolean,
): boolean {
  let index = skipPackageManagerOptions(tokens, startIndex);
  if (tokens[index]?.toLowerCase() === "run") {
    index = skipPackageManagerOptions(tokens, index + 1);
  }
  return matchesScriptToken(tokens[index]);
}

function skipPackageManagerOptions(tokens: string[], startIndex: number): number {
  let index = startIndex;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "--") {
      index++;
      continue;
    }
    if (!isPackageManagerOption(token)) break;

    const optionName = token.split("=", 1)[0];
    const hasInlineValue = token.includes("=");
    index++;
    if (!hasInlineValue && PACKAGE_MANAGER_VALUE_OPTIONS.has(optionName) && index < tokens.length) {
      index++;
    }
  }
  return index;
}

function isPackageManagerOption(token: string): boolean {
  return token.startsWith("-") && token !== "-";
}

function isTestScriptToken(token: string | undefined): boolean {
  return token !== undefined && /^test(?::[^\s]+)?$/i.test(token);
}

function isTypecheckScriptToken(token: string | undefined): boolean {
  return token !== undefined && /^(?:typecheck|type-check|check:types?)$/i.test(token);
}

function isLintScriptToken(token: string | undefined): boolean {
  return token !== undefined && /^(?:lint|biome|prettier)(?::[^\s]+)?$/i.test(token);
}

function commandChecks(command: PrReadinessCommand): PrReadinessCheck[] {
  return uniqueChecks([...(command.checks ?? []), command.check, ...detectCommandChecks(command.command)]);
}

function commandOutputText(command: Pick<PrReadinessCommand, "summary" | "failureOutput" | "skipReason">): string {
  return [command.summary, command.failureOutput, command.skipReason].filter(Boolean).join("\n");
}

function commandRecoversFailure(failedCommand: PrReadinessCommand, laterCommand: PrReadinessCommand): boolean {
  if (laterCommand.status !== "completed" || commandLooksFailed(laterCommand)) return false;

  const failedTargets = verificationTargetKeys(failedCommand);
  const laterTargets = verificationTargetKeys(laterCommand);
  if (failedTargets.length > 0) {
    if (verificationTargetsFullyCovered(failedTargets, laterTargets)) return true;
    return false;
  }

  const failedWorkflowConfigTool = commandWorkflowConfigTool(failedCommand);
  const laterWorkflowConfigTool = commandWorkflowConfigTool(laterCommand);
  if (failedWorkflowConfigTool || laterWorkflowConfigTool) {
    return failedWorkflowConfigTool === laterWorkflowConfigTool;
  }

  const failedApiSubject = commandApiSubject(failedCommand);
  const laterApiSubject = commandApiSubject(laterCommand);
  if (failedApiSubject || laterApiSubject) return failedApiSubject === laterApiSubject;

  const failedRelevantLabel = relevantCommandRecoveryLabel(failedCommand);
  const laterRelevantLabel = relevantCommandRecoveryLabel(laterCommand);
  if (failedRelevantLabel && laterRelevantLabel) return failedRelevantLabel === laterRelevantLabel;

  const failedChecks = commandChecks(failedCommand);
  if (failedChecks.length === 0) return false;
  const laterChecks = new Set(commandChecks(laterCommand));
  return failedChecks.some((check) => laterChecks.has(check));
}

function relevantCommandRecoveryLabel(command: PrReadinessCommand): string | undefined {
  return isRelevantCheckCommand(command.command) ? classifyRelevantCommandLabel(command.command) : undefined;
}

function verificationTargetCovers(passedTargetKey: string, failedTargetKey: string): boolean {
  const passedTarget = parseVerificationTargetKey(passedTargetKey);
  const failedTarget = parseVerificationTargetKey(failedTargetKey);
  if (!passedTarget || !failedTarget || passedTarget.kind !== failedTarget.kind) return false;
  return pathCovers(passedTarget.path, failedTarget.path);
}

function parseVerificationTargetKey(key: string): { kind: string; path: string } | undefined {
  const parts = key.split(":");
  if (parts.length < 3) return undefined;
  return {
    kind: `${parts[0]}:${parts[1]}`,
    path: parts.slice(2).join(":"),
  };
}

function pathCovers(passedPath: string, failedPath: string): boolean {
  if (passedPath === "." || passedPath === failedPath) return true;
  const normalizedPassed = passedPath.replace(/\/+$/, "");
  const normalizedFailed = failedPath.replace(/\/+$/, "");
  return Boolean(normalizedPassed && normalizedFailed.startsWith(`${normalizedPassed}/`));
}

function extractPytestTargets(form: CommandExecutionForm): string[] {
  const tokens = tokenizeCommand(form.command);
  const pytestIndex = tokens.findIndex((token, index) => {
    const normalized = executableName(token);
    return normalized === "pytest" || (normalized === "py.test" && tokens[index - 1] !== "-m");
  });
  if (pytestIndex < 0) return [];

  const baseDir = commandBaseDirForTool(tokens, pytestIndex, form.cwd);
  const targets: string[] = [];
  for (const token of tokens.slice(pytestIndex + 1)) {
    if (isShellCommandSeparator(token)) break;
    if (!token || token === "--") continue;
    if (token.startsWith("-")) continue;

    const normalized = normalizePytestTarget(token, baseDir);
    if (normalized) targets.push(normalized);
  }
  return Array.from(new Set(targets));
}

function normalizePytestTarget(token: string, baseDir: string | undefined): string | undefined {
  const target = stripCommandPathToken(token.replace(/::.*$/, ""));
  if (!target || !target.endsWith(".py")) return undefined;
  return applyCommandBaseDir(target, baseDir);
}

function extractRuffTargets(form: CommandExecutionForm): string[] {
  const tokens = tokenizeCommand(form.command);
  const ruffIndex = tokens.findIndex((token) => executableName(token) === "ruff");
  if (ruffIndex < 0) return [];

  const subcommandIndex = tokens.findIndex(
    (token, index) => index > ruffIndex && !token.startsWith("-") && !isShellCommandSeparator(token),
  );
  const subcommand = tokens[subcommandIndex]?.toLowerCase();
  if (subcommand !== "check" && subcommand !== "format") return [];

  return extractPathTargets(tokens.slice(subcommandIndex + 1), commandBaseDirForTool(tokens, ruffIndex, form.cwd));
}

function extractPyrightTargets(form: CommandExecutionForm): string[] {
  const tokens = tokenizeCommand(form.command);
  const pyrightIndex = tokens.findIndex((token) => executableName(token) === "pyright");
  if (pyrightIndex < 0) return [];
  return extractPathTargets(tokens.slice(pyrightIndex + 1), commandBaseDirForTool(tokens, pyrightIndex, form.cwd));
}

const JS_TEST_RUNNERS = new Set(["vitest", "jest"]);
const JS_TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
// Value-taking vitest/jest options whose space-separated argument must NOT be
// mistaken for a positional test-file path (e.g. `-t foo.spec.ts` is a test-name
// filter, not a file). Inline `--opt=value` forms are already skipped as flags.
const JS_TEST_VALUE_OPTIONS = new Set([
  "-t",
  "--testNamePattern",
  "--reporter",
  "--config",
  "-c",
  "--project",
  "--shard",
  "--outputFile",
  "--root",
  "--dir",
  "--testTimeout",
  "--maxWorkers",
]);

function extractJsTestTargets(form: CommandExecutionForm): string[] {
  const tokens = tokenizeCommand(form.command);
  const runnerIndex = tokens.findIndex((token) => JS_TEST_RUNNERS.has(executableName(token) ?? ""));
  if (runnerIndex < 0) return [];

  const baseDir = commandBaseDirForTool(tokens, runnerIndex, form.cwd);
  const targets: string[] = [];
  const tail = tokens.slice(runnerIndex + 1);
  for (let index = 0; index < tail.length; index += 1) {
    const token = tail[index];
    if (isShellCommandSeparator(token)) break;
    if (!token || token === "--") continue;
    if (token.startsWith("-")) {
      // Skip the value of a space-separated value option so it is never read as a file.
      if (!token.includes("=") && JS_TEST_VALUE_OPTIONS.has(token)) index += 1;
      continue;
    }
    const target = stripCommandPathToken(token);
    if (!target || !JS_TEST_FILE_RE.test(target)) continue;
    const resolved = applyCommandBaseDir(target, baseDir);
    if (resolved) targets.push(resolved);
  }
  return Array.from(new Set(targets));
}

// Registry of per-runner verification-target extractors. Each extractor owns the
// CLI grammar for one tool; `kind` is the "<domain>:<tool>" prefix consumed by
// parseVerificationTargetKey. To support a new runner (cargo, go, ...), add ONE
// extractor function and ONE entry here — do not edit verificationTargetKeys.
type VerificationTargetExtractor = {
  kind: string;
  extract: (form: CommandExecutionForm) => string[];
};

const VERIFICATION_TARGET_EXTRACTORS: VerificationTargetExtractor[] = [
  { kind: "tests:pytest", extract: extractPytestTargets },
  { kind: "tests:js", extract: extractJsTestTargets },
  { kind: "lint:ruff", extract: extractRuffTargets },
  { kind: "typecheck:pyright", extract: extractPyrightTargets },
];

function extractPathTargets(tokens: string[], baseDir: string | undefined): string[] {
  const targets: string[] = [];
  for (const token of tokens) {
    if (isShellCommandSeparator(token)) break;
    if (!token || token === "--" || token.startsWith("-")) continue;
    if (!isLikelyPathTarget(token)) continue;

    const normalized = applyCommandBaseDir(token, baseDir);
    if (normalized) targets.push(normalized);
  }
  return Array.from(new Set(targets));
}

function isLikelyPathTarget(token: string): boolean {
  const target = stripCommandPathToken(token);
  return (
    target === "." ||
    target.startsWith("./") ||
    target.includes("/") ||
    /\.(?:py|pyi|js|jsx|ts|tsx|vue|svelte|astro|css|scss|html|sql|ya?ml|json|toml|mdx?)$/i.test(target)
  );
}

function commandBaseDirForTool(
  tokens: string[],
  toolIndex: number,
  inheritedCwd: string | undefined,
): string | undefined {
  const uvProject = extractUvProjectPath(tokens, toolIndex);
  return uvProject ? joinCommandPath(inheritedCwd, uvProject) : normalizeRelativeRepoPath(inheritedCwd ?? "");
}

function extractUvProjectPath(tokens: string[], limit: number): string | undefined {
  for (let index = 0; index < limit; index += 1) {
    if (executableName(tokens[index]) !== "uv") continue;
    for (let cursor = index + 1; cursor < limit; cursor += 1) {
      const token = tokens[cursor]!;
      if (token === "--") break;
      if (token === "--project" || token === "--directory") return tokens[cursor + 1];
      const inlineProject = token.match(/^--(?:project|directory)=(.+)$/)?.[1];
      if (inlineProject) return inlineProject;
    }
  }
  return undefined;
}

function commandWorkflowConfigTool(command: PrReadinessCommand): string | undefined {
  const text = `${command.command}\n${commandOutputText(command)}`;
  if (/\bactionlint\b/i.test(text)) return "actionlint";
  if (/\byamllint\b/i.test(text)) return "yamllint";
  return undefined;
}

function commandApiSubject(command: PrReadinessCommand): string | undefined {
  return extractApiSubject(command.command) ?? extractApiSubject(commandOutputText(command));
}

function extractApiSubject(text: string | undefined): string | undefined {
  if (!text) return undefined;
  for (const form of commandDetectionForms(text)) {
    const cannotMatch = form.match(/\bCannot\s+(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s<>"')]+)/i);
    if (cannotMatch) return `${cannotMatch[1]!.toUpperCase()} ${cannotMatch[2]!}`;

    const method = form.match(/\s-X\s+([A-Z]+)\b/i)?.[1]?.toUpperCase();
    const url =
      form.match(/https?:\/\/[^\s'"\\)]+/i)?.[0] ??
      form.match(/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?\/[^\s'"\\)]+/i)?.[0];
    if (!url) continue;
    const normalizedUrl = url.startsWith("http") ? url : `http://${url}`;
    try {
      const parsed = new URL(normalizedUrl);
      const path = `${parsed.pathname}${parsed.search}` || "/";
      return method && method !== "GET" ? `${method} ${path}` : `GET ${path}`;
    } catch {
      return method && method !== "GET" ? `${method} ${url}` : `GET ${url}`;
    }
  }
  return undefined;
}

function checkAttempted(commandsRun: PrReadinessCommand[], check: PrReadinessCheck): boolean {
  return commandsRun.some((command) => commandChecks(command).includes(check));
}

function detectChecks(changedFiles: string[], commandsRun: PrReadinessCommand[]): Record<PrReadinessCheck, boolean> {
  return {
    tests:
      checkAttempted(commandsRun, "tests") ||
      changedFiles.some((file) => /(?:^|\/)(?:tests?|__tests__)\//i.test(file) || TEST_FILE_PATTERN.test(file)),
    lint:
      checkAttempted(commandsRun, "lint") ||
      changedFiles.some((file) => /(?:^|\/)(?:eslint\.config|\.eslintrc|lint-staged)/i.test(file)),
    typecheck:
      checkAttempted(commandsRun, "typecheck") ||
      changedFiles.some((file) => /\.(?:ts|tsx)$/i.test(file) || /(?:^|\/)tsconfig[^/]*\.json$/i.test(file)),
  };
}

function detectSkippedChecks(
  checksDetected: Record<PrReadinessCheck, boolean>,
  commandsRun: PrReadinessCommand[],
): PrReadinessEvidence["skippedChecks"] {
  const skipped: PrReadinessEvidence["skippedChecks"] = [];
  for (const check of ["tests", "lint", "typecheck"] as const) {
    const explicitSkip = commandsRun.find((command) => command.check === check && command.status === "skipped");
    if (explicitSkip) {
      if (isUnsupportedTypecheckSkip(explicitSkip)) continue;
      skipped.push({ check, reason: explicitSkip.skipReason ?? "Check was skipped." });
      continue;
    }
    if (checksDetected[check] && !checkAttempted(commandsRun, check)) {
      skipped.push({ check, reason: `${check} evidence was detected, but no ${check} command was recorded.` });
    }
  }
  return skipped;
}

function parseGitDiffStats(diffStat: string | undefined): PrReadinessEvidence["diffStats"] {
  if (!diffStat) return { filesChanged: 0, insertions: 0, deletions: 0 };

  const summaryLine = diffStat
    .split("\n")
    .map((line) => line.trim())
    .reverse()
    .find((line) => /\bfiles? changed\b/.test(line));

  return {
    raw: diffStat,
    filesChanged: Number(summaryLine?.match(/(\d+)\s+files?\s+changed/)?.[1] ?? 0),
    insertions: Number(summaryLine?.match(/(\d+)\s+insertions?\(\+\)/)?.[1] ?? 0),
    deletions: Number(summaryLine?.match(/(\d+)\s+deletions?\(-\)/)?.[1] ?? 0),
  };
}

function extractChangedFilesFromDiffStat(diffStat: string | undefined): string[] {
  if (!diffStat) return [];
  const files = new Set<string>();
  for (const line of diffStat.split("\n")) {
    if (/\bfiles? changed\b/.test(line)) continue;
    const [filePart] = line.split("|");
    if (filePart?.includes("=>")) continue;
    if (/^\s*\.\.\.\//.test(filePart ?? "")) continue;
    const filePath = normalizeRepoPath(filePart ?? "");
    if (filePath) files.add(filePath);
  }
  return Array.from(files);
}

function extractFilesMentionedInFinalAnswer(finalAnswer: string): string[] {
  const files = new Set<string>();
  const pathPattern =
    /(?:^|[\s([`])((?:apps|shared|tests|scripts|docs|infra|src)\/[A-Za-z0-9._/-]+)(?::\d+)?(?=$|[\s)\]`,.])/g;
  let match: RegExpExecArray | null;
  while ((match = pathPattern.exec(finalAnswer)) !== null) {
    const candidate = normalizeRepoPath((match[1] ?? "").replace(/[.,;:]+$/, ""));
    if (candidate && !candidate.endsWith("/")) files.add(candidate);
  }
  return uniqueSorted(Array.from(files));
}
