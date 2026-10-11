import { existsSync, readFileSync } from "fs";
import { join } from "path";

import type { PreviewContract } from "../../../../shared/types/sandbox.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown, options: { requireNonEmpty?: boolean } = {}): value is string[] {
  return Array.isArray(value) && (!options.requireNonEmpty || value.length > 0) && value.every(isNonBlankString);
}

function isOptionalStringRecord(value: unknown): boolean {
  if (value === undefined) return true;
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isOptionalGeneratedComposeEnv(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, entry]) => {
    if (!key.trim()) return false;
    if (!isRecord(entry)) return false;
    return (
      entry.type === "hex" &&
      typeof entry.bytes === "number" &&
      Number.isInteger(entry.bytes) &&
      entry.bytes > 0 &&
      entry.bytes <= 128
    );
  });
}

function isOptionalPathConfig(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return value.path === undefined || isNonBlankString(value.path);
}

function isOptionalReadyConfig(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || !isOptionalPathConfig(value)) return false;
  const timeoutSeconds = value.timeoutSeconds;
  return (
    timeoutSeconds === undefined ||
    (typeof timeoutSeconds === "number" && Number.isInteger(timeoutSeconds) && timeoutSeconds > 0)
  );
}

function isValidEntry(value: unknown): boolean {
  if (!isRecord(value)) return false;

  if (value.type === "compose") {
    return (
      isStringArray(value.files, { requireNonEmpty: true }) &&
      isNonBlankString(value.service) &&
      (value.profiles === undefined || isStringArray(value.profiles))
    );
  }

  if (value.type === "dockerfile") {
    return isNonBlankString(value.context) && isNonBlankString(value.dockerfile) && isNonBlankString(value.service);
  }

  return false;
}

function isValidPort(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65_535;
}

function isValidE2EBlock(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if (!isNonBlankString(value.testCommand)) return false;
  if (value.seedCommand !== undefined && !isNonBlankString(value.seedCommand)) return false;
  if (value.resetCommand !== undefined && !isNonBlankString(value.resetCommand)) return false;
  if (!isValidCredentialDeclarations(value.credentials)) return false;
  return true;
}

function isValidCredentialDeclarations(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  for (const entry of value) {
    if (!isRecord(entry)) return false;
    if (!isNonBlankString(entry.name) || !isNonBlankString(entry.envVar)) return false;
  }
  return true;
}

function isValidAuthBlock(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if (!isNonBlankString(value.command)) return false;
  if (value.validatePath !== undefined && !isNonBlankString(value.validatePath)) return false;
  if (!isValidCredentialDeclarations(value.credentials)) return false;
  return true;
}

function isValidAdditionalPorts(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (!isRecord(entry)) return false;
    return (
      isValidPort(entry.hostPort) &&
      (entry.containerPort === undefined || isValidPort(entry.containerPort)) &&
      (entry.service === undefined || isNonBlankString(entry.service))
    );
  });
}

function isValidPreviewContract(value: unknown): value is PreviewContract {
  if (!isRecord(value)) return false;
  const parsed = value as Partial<PreviewContract> & { previewMode?: unknown };
  const url = parsed.url as unknown;
  const portMapping = parsed.portMapping as unknown;
  return (
    parsed.previewMode === undefined &&
    isNonBlankString(parsed.cwd) &&
    parsed.kind === "web" &&
    parsed.runner === "docker" &&
    isValidEntry(parsed.entry) &&
    isRecord(url) &&
    isValidPort(url.hostPort) &&
    (url.path === undefined || isNonBlankString(url.path)) &&
    (portMapping === undefined ||
      (isRecord(portMapping) && (portMapping.containerPort === undefined || isValidPort(portMapping.containerPort)))) &&
    isValidAdditionalPorts(parsed.additionalPorts) &&
    isOptionalStringRecord(parsed.composeEnv) &&
    isOptionalGeneratedComposeEnv(parsed.generatedComposeEnv) &&
    isOptionalStringRecord(parsed.env) &&
    isOptionalReadyConfig(parsed.ready) &&
    isOptionalPathConfig(parsed.open) &&
    isValidAuthBlock(parsed.auth) &&
    isValidE2EBlock(parsed.e2e)
  );
}

export function parsePreviewContractJson(raw: string | undefined): PreviewContract | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isValidPreviewContract(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function readConfiguredPreviewContract(env: NodeJS.ProcessEnv = process.env): PreviewContract | undefined {
  return parsePreviewContractJson(env.ARCANIST_PREVIEW_CONTRACT_JSON);
}

/**
 * Read a preview contract from the known producer locations, in priority order:
 *   1. `contractPath` (the PREVIEW_CONTRACT_PATH constant)
 *   2. `<evidenceDir>/preview-contract.json`
 *   3. `<evidenceDir>/contract.json`
 *
 * The first file that parses to a valid contract wins. This intentionally checks only the
 * explicit producer set; it does NOT glob every `*.json` in the evidence dir (that fallback was
 * speculative, untested, and could promote an unrelated JSON file to a preview contract).
 */
export function readPreviewContractFromFiles(input: {
  contractPath: string;
  evidenceDir: string;
  log?: { warn: (obj: Record<string, unknown>, msg?: string) => void };
}): PreviewContract | undefined {
  const candidatePaths = [
    input.contractPath,
    join(input.evidenceDir, "preview-contract.json"),
    join(input.evidenceDir, "contract.json"),
  ];
  for (const contractPath of [...new Set(candidatePaths)]) {
    if (!existsSync(contractPath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(contractPath, "utf-8")) as unknown;
      if (!isValidPreviewContract(parsed)) {
        // Valid JSON but failed the schema check (e.g. wrong runner, missing cwd). Surface a
        // diagnostic instead of silently skipping a known-path file the developer expected to load.
        input.log?.warn({ path: contractPath }, "Preview contract file failed schema validation");
        continue;
      }
      return parsed;
    } catch (err) {
      input.log?.warn({ error: String(err), path: contractPath }, "Failed to parse preview contract");
    }
  }
  return undefined;
}

export function hasConfiguredE2ERuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(readConfiguredPreviewContract(env)?.e2e?.testCommand);
}

/** A bootable App Runtime Profile is configured (regardless of an e2e.testCommand). */
export function hasConfiguredAppRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(readConfiguredPreviewContract(env)?.entry);
}
