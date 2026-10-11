import path from "node:path";

import { existsSync, readFileSync } from "fs";

import { MAX_CONFIGURED_TEST_COMMANDS, TYPECHECK_TIMEOUT_MS } from "../constants/bridge.js";

export const CYCLOID_CONFIG_PATH = ".cycloid.json";
export const DEFAULT_VERIFY_TIMEOUT_MS = TYPECHECK_TIMEOUT_MS;
export const MIN_VERIFY_TIMEOUT_MS = 1_000;
export const MAX_VERIFY_TIMEOUT_MS = 30 * 60 * 1_000;

export const DOCS_ONLY_FILE_PATTERN =
  /(?:^|\/)(?:README|CHANGELOG|CONTRIBUTING|LICENSE|NOTICE)(?:\.[^/]*)?$|(?:^|\/)docs\/|\.mdx?$|\.txt$/i;

export type VerifyCommand = {
  command: string;
  reason: string;
};

export type VerifyConfigObject = {
  required?: unknown;
  command?: unknown;
  commands?: unknown;
  rules?: unknown;
  timeoutSeconds?: unknown;
  skipPaths?: unknown;
};

type VerifyRule = {
  paths?: unknown;
  command?: unknown;
  commands?: unknown;
  name?: unknown;
};

type CycloidConfig = {
  verify?: Record<string, unknown>;
};

export function readVerifyConfig(
  cwd: string,
  key: "test" | "fix",
): { ok: true; configured: false } | { ok: true; configured: true; value: unknown } | { ok: false; reason: string } {
  const configPath = path.join(cwd, CYCLOID_CONFIG_PATH);
  if (!existsSync(configPath)) return { ok: true, configured: false };

  let config: CycloidConfig;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8")) as CycloidConfig;
  } catch (error) {
    return { ok: false, reason: `Invalid .cycloid.json; cannot resolve pre-publish ${key}. ${String(error)}` };
  }

  const value = config.verify?.[key];
  if (value === undefined) return { ok: true, configured: false };
  return { ok: true, configured: true, value };
}

export function normalizeVerifyConfig(
  rawConfig: unknown,
  configLabel: string,
): { ok: true; config: VerifyConfigObject; timeoutMs: number } | { ok: false; reason: string } {
  if (typeof rawConfig === "string" || Array.isArray(rawConfig)) {
    return {
      ok: true,
      config: Array.isArray(rawConfig) ? { commands: rawConfig } : { command: rawConfig },
      timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
    };
  }
  if (!rawConfig || typeof rawConfig !== "object") {
    return { ok: false, reason: `${configLabel} must be a command string, command array, or object.` };
  }

  const config = rawConfig as VerifyConfigObject;
  const timeoutMs = normalizeTimeoutMs(config.timeoutSeconds);
  if (timeoutMs === null) {
    return { ok: false, reason: `${configLabel}.timeoutSeconds must be a positive number.` };
  }
  return { ok: true, config, timeoutMs };
}

export function resolveConfiguredCommands(
  config: VerifyConfigObject,
  changedFiles: string[],
  configLabel: string,
): { ok: true; commands: VerifyCommand[] } | { ok: false; reason: string } {
  const commands: VerifyCommand[] = [];
  const defaultCommands = normalizeCommands(config.command, config.commands, configLabel);
  if (!defaultCommands.ok) return defaultCommands;

  for (const command of defaultCommands.commands) {
    commands.push({ command, reason: `Default ${configLabel} command.` });
  }

  if (config.rules !== undefined) {
    if (!Array.isArray(config.rules)) {
      return { ok: false, reason: `${configLabel}.rules must be an array.` };
    }
    for (const rawRule of config.rules) {
      if (!rawRule || typeof rawRule !== "object") {
        return { ok: false, reason: `${configLabel}.rules entries must be objects.` };
      }
      const rule = rawRule as VerifyRule;
      const paths = normalizeStringArray(rule.paths);
      if (!paths.ok) return { ok: false, reason: `${configLabel}.rules.paths must be a string or string array.` };
      if (
        paths.values.length > 0 &&
        !changedFiles.some((file) => paths.values.some((glob) => matchesGlob(file, glob)))
      ) {
        continue;
      }

      const ruleCommands = normalizeCommands(rule.command, rule.commands, configLabel);
      if (!ruleCommands.ok) return ruleCommands;
      for (const command of ruleCommands.commands) {
        const ruleName = typeof rule.name === "string" && rule.name.trim() ? rule.name.trim() : undefined;
        commands.push({
          command,
          reason:
            paths.values.length > 0
              ? `${ruleName ? `${ruleName}: ` : ""}${configLabel} rule matched ${paths.values.join(", ")}.`
              : `${ruleName ? `${ruleName}: ` : ""}${configLabel} rule matched all changed files.`,
        });
      }
    }
  }

  const unique = uniqueCommands(commands);
  if (unique.length > MAX_CONFIGURED_TEST_COMMANDS) {
    return {
      ok: false,
      reason: `${configLabel} matched ${unique.length} commands; refusing to run more than ${MAX_CONFIGURED_TEST_COMMANDS} pre-publish commands.`,
    };
  }
  return { ok: true, commands: unique };
}

export function allChangedFilesMatchSkipPaths(changedFiles: string[], skipPaths: unknown): boolean {
  const normalized = normalizeStringArray(skipPaths);
  if (!normalized.ok || normalized.values.length === 0 || changedFiles.length === 0) return false;
  return changedFiles.every((file) => normalized.values.some((glob) => matchesGlob(file, glob)));
}

export function normalizeChangedFiles(cwd: string, changedFiles?: Iterable<string>): string[] {
  if (!changedFiles) return [];
  const files = new Set<string>();
  for (const file of changedFiles) {
    if (typeof file !== "string" || !file.trim()) continue;
    const absoluteFile = path.isAbsolute(file) ? file : path.resolve(cwd, file);
    const relativeFile = path.relative(cwd, absoluteFile);
    if (relativeFile.startsWith("..")) continue;
    files.add(relativeFile.split(path.sep).join("/"));
  }
  return Array.from(files);
}

function normalizeCommands(
  command: unknown,
  commands: unknown,
  configLabel: string,
): { ok: true; commands: string[] } | { ok: false; reason: string } {
  const values: string[] = [];
  if (command !== undefined) {
    if (typeof command !== "string" || command.trim().length === 0) {
      return { ok: false, reason: `${configLabel}.command must be a non-empty string.` };
    }
    values.push(command.trim());
  }
  if (commands !== undefined) {
    const normalized = normalizeStringArray(commands);
    if (!normalized.ok || normalized.values.some((value) => value.trim().length === 0)) {
      return { ok: false, reason: `${configLabel}.commands must be a string array.` };
    }
    values.push(...normalized.values.map((value) => value.trim()));
  }
  return { ok: true, commands: values };
}

function normalizeStringArray(value: unknown): { ok: true; values: string[] } | { ok: false } {
  if (value === undefined) return { ok: true, values: [] };
  if (typeof value === "string") return { ok: true, values: [value] };
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return { ok: true, values: value };
  }
  return { ok: false };
}

function normalizeTimeoutMs(timeoutSeconds: unknown): number | null {
  if (timeoutSeconds === undefined) return DEFAULT_VERIFY_TIMEOUT_MS;
  if (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) return null;
  return Math.max(MIN_VERIFY_TIMEOUT_MS, Math.min(Math.round(timeoutSeconds * 1_000), MAX_VERIFY_TIMEOUT_MS));
}

function matchesGlob(file: string, glob: string): boolean {
  const normalizedFile = file.replace(/\\/g, "/").replace(/^\.\//, "");
  const normalizedGlob = glob.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalizedGlob) return false;
  if (normalizedGlob === "**" || normalizedGlob === "*") return true;
  return matchGlobSegments(normalizedFile.split("/"), normalizedGlob.split("/"));
}

function matchGlobSegments(fileSegments: string[], globSegments: string[]): boolean {
  if (globSegments.length === 0) return fileSegments.length === 0;
  const [globSegment, ...remainingGlobSegments] = globSegments;
  if (globSegment === "**") {
    if (matchGlobSegments(fileSegments, remainingGlobSegments)) return true;
    return fileSegments.length > 0 && matchGlobSegments(fileSegments.slice(1), globSegments);
  }
  if (fileSegments.length === 0) return false;
  if (!matchGlobSegment(fileSegments[0]!, globSegment!)) return false;
  return matchGlobSegments(fileSegments.slice(1), remainingGlobSegments);
}

function matchGlobSegment(fileSegment: string, globSegment: string): boolean {
  const regex = new RegExp(`^${globSegmentToRegexSource(globSegment)}$`);
  return regex.test(fileSegment);
}

function globSegmentToRegexSource(globSegment: string): string {
  let source = "";
  for (let index = 0; index < globSegment.length; index++) {
    const char = globSegment[index]!;
    if (char === "*") {
      source += ".*";
      continue;
    }
    if (char === "?") {
      source += ".";
      continue;
    }
    source += escapeRegex(char);
  }
  return source;
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function uniqueCommands(commands: VerifyCommand[]): VerifyCommand[] {
  const seen = new Set<string>();
  const unique: VerifyCommand[] = [];
  for (const command of commands) {
    const normalized = normalizeCommandForComparison(command.command);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(command);
  }
  return unique;
}

export function normalizeCommandForComparison(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}
