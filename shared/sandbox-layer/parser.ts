import type { Node } from "yaml";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";

import { bytesToHex } from "../utils/hex.js";

const textEncoder = new TextEncoder();

async function computeSha256Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(message));
  return bytesToHex(new Uint8Array(digest));
}

export const SANDBOX_LAYER_MANIFEST_PATH = ".cycloid/sandbox.yaml";
export const SANDBOX_LAYER_COMPILER_VERSION = "sandbox-layer-v1";

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_LAYER_BYTES = 128 * 1024;
const MAX_RUN_COMMAND_BYTES = 8 * 1024;
const MAX_SMOKE_COMMANDS = 20;
const MAX_SMOKE_ARGS = 32;
const MAX_SMOKE_ARG_BYTES = 512;
const MAX_DISPLAY_NAME_CHARS = 80;
const MIN_DISPLAY_NAME_CHARS = 2;
const MAX_ENV_KEY_CHARS = 80;
const MAX_ENV_VALUE_BYTES = 2 * 1024;
const MAX_ENV_VARS = 50;
const SECRET_PATTERN =
  /\b(secret|token|password|passwd|private_key|private-key|access_key|access-key|client_secret|client-secret)\b|BEGIN PRIVATE KEY/i;
const FORBIDDEN_PATHS = [
  "/app",
  "/app/start-bridge.sh",
  "/app/bridge",
  "/app/scripts",
  "/workspace",
  "/usr/local/sbin/cycloid-enforce-egress",
];
const FORBIDDEN_TARGETING_OPS = /\b(rm|mv|cp|ln|chmod|chown|truncate|tee)\b|\bsed\s+-i\b|\bcat\s*>/;
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]{0,79}$/;

export type SandboxLayerInstruction =
  | { kind: "run"; command: string; startLine: number; endLine: number }
  | { kind: "env"; values: Record<string, string>; startLine: number; endLine: number };

export interface SandboxLayerManifest {
  version: 1;
  name: string | null;
  layer: { dockerfile: string };
  smoke: { commands: string[][] };
}

export type SandboxLayerValidationIssue = {
  path: string;
  line?: number;
  field?: string;
  code: string;
  message: string;
};

export class SandboxLayerValidationError extends Error {
  readonly issues: SandboxLayerValidationIssue[];
  readonly path: string;
  readonly detail: string;
  readonly line?: number;

  constructor(
    pathOrIssues: string | SandboxLayerValidationIssue[],
    detail?: string,
    line?: number,
    field?: string,
    code = "invalid",
  ) {
    const issues = Array.isArray(pathOrIssues)
      ? pathOrIssues
      : [{ path: pathOrIssues, line, field, code, message: detail ?? "invalid sandbox layer source" }];
    const first = issues[0] ?? { path: "sandbox-layer", message: "invalid sandbox layer source" };
    super(formatIssue(first));
    this.name = "SandboxLayerValidationError";
    this.issues = issues;
    this.path = first.path;
    this.detail = first.message;
    this.line = first.line;
  }
}

export type ParseSandboxLayerSourceInput = {
  manifestPath: string;
  manifestText: string;
  layerPath: string;
  layerText: string;
  buildIdentity?: {
    baseTemplateRef: string;
    baseVersion: string;
    compilerVersion: string;
  };
};

export type ParsedSandboxLayerSource = {
  manifest: {
    version: 1;
    name: string | null;
    layerDockerfile: string;
    smokeCommands: string[][];
  };
  layer: {
    instructions: SandboxLayerInstruction[];
  };
  hashes: {
    manifestHash: string;
    layerHash: string;
    normalizedSourceHash: string;
  };
};

function formatIssue(issue: SandboxLayerValidationIssue): string {
  return `${issue.path}${issue.line ? `:${issue.line}` : ""}: ${issue.message}`;
}

function issue(
  path: string,
  message: string,
  options: { line?: number; field?: string; code?: string } = {},
): SandboxLayerValidationIssue {
  return {
    path,
    line: options.line,
    field: options.field,
    code: options.code ?? "invalid",
    message,
  };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function rejectSecrets(path: string, text: string): void {
  const match = text.match(SECRET_PATTERN);
  if (match) {
    throw new SandboxLayerValidationError(
      path,
      `sandbox layer source appears to contain a secret-like token: ${match[0]}`,
    );
  }
}

function assertSize(path: string, text: string, maxBytes: number): void {
  if (text.includes("\0")) {
    throw new SandboxLayerValidationError(path, "file must not contain NUL bytes");
  }
  if (byteLength(text) > maxBytes) {
    throw new SandboxLayerValidationError(path, `file exceeds ${maxBytes} byte limit`);
  }
}

export function validateRepoRelativeCycloidPath(path: string, field = "path"): string {
  const normalized = path.trim();
  if (!normalized) throw new Error(`${field} is required`);
  if (/^[A-Za-z]:/.test(normalized)) throw new Error(`${field} must be a POSIX repo-relative path`);
  if (normalized.includes("\\")) throw new Error(`${field} must use POSIX '/' separators`);
  if (normalized.startsWith("/") || normalized.includes("\0")) throw new Error(`${field} must be repo-relative`);
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${field} cannot contain empty, '.', or '..' segments`);
  }
  if (!normalized.startsWith(".cycloid/")) throw new Error(`${field} must be under .cycloid/`);
  return normalized;
}

function yamlLineForPath(doc: ReturnType<typeof parseDocument>, keyPath: string[]): number | undefined {
  let node: Node | null = doc.contents as Node | null;
  for (const segment of keyPath) {
    if (!isMap(node)) return undefined;
    const pair = node.items.find((item) => isScalar(item.key) && item.key.value === segment);
    if (!pair) return undefined;
    node = pair.value as Node | null;
  }
  const range = (node as { range?: [number, number, number?] } | null)?.range;
  if (!range) return undefined;
  const before = doc.toString().slice(0, range[0]);
  return before.split(/\r?\n/).length;
}

function assertKnownKeys(
  path: string,
  doc: ReturnType<typeof parseDocument>,
  value: unknown,
): SandboxLayerValidationIssue[] {
  const issues: SandboxLayerValidationIssue[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [issue(path, "manifest must be a YAML object", { code: "manifest_type" })];
  }
  const root = value as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (!["version", "name", "layer", "smoke"].includes(key)) {
      issues.push(
        issue(
          path,
          key === "resources"
            ? "resources is not supported; resource sizing is Cycloid policy"
            : `unknown field '${key}'`,
          {
            line: yamlLineForPath(doc, [key]),
            field: key,
            code: key === "resources" ? "resources_not_allowed" : "unknown_field",
          },
        ),
      );
    }
  }
  if (root.layer && typeof root.layer === "object" && !Array.isArray(root.layer)) {
    for (const key of Object.keys(root.layer as Record<string, unknown>)) {
      if (key !== "dockerfile") {
        issues.push(
          issue(path, `unknown field 'layer.${key}'`, {
            line: yamlLineForPath(doc, ["layer", key]),
            field: `layer.${key}`,
            code: "unknown_field",
          }),
        );
      }
    }
  }
  if (root.smoke && typeof root.smoke === "object" && !Array.isArray(root.smoke)) {
    for (const key of Object.keys(root.smoke as Record<string, unknown>)) {
      if (key !== "commands") {
        issues.push(
          issue(path, `unknown field 'smoke.${key}'`, {
            line: yamlLineForPath(doc, ["smoke", key]),
            field: `smoke.${key}`,
            code: "unknown_field",
          }),
        );
      }
    }
  }
  return issues;
}

export function parseSandboxLayerManifest(path: string, text: string): SandboxLayerManifest {
  assertSize(path, text, MAX_MANIFEST_BYTES);
  rejectSecrets(path, text);
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(text, { strict: true });
  } catch (err) {
    throw new SandboxLayerValidationError(path, `invalid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (doc.errors.length > 0) {
    const error = doc.errors[0];
    throw new SandboxLayerValidationError(path, `invalid YAML: ${error.message}`, error.linePos?.[0]?.line);
  }
  const parsed = doc.toJSON();
  const issues = assertKnownKeys(path, doc, parsed);
  const raw = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  if (!Object.prototype.hasOwnProperty.call(raw, "version")) {
    issues.push(issue(path, "version is required", { field: "version", code: "required" }));
  } else if (raw.version !== 1) {
    issues.push(
      issue(path, "version must be exactly 1", {
        line: yamlLineForPath(doc, ["version"]),
        field: "version",
        code: "invalid_version",
      }),
    );
  }
  const name: string | null = raw.name == null ? null : typeof raw.name === "string" ? raw.name.trim() : "";
  if (
    raw.name != null &&
    (typeof raw.name !== "string" ||
      name === null ||
      name.length < MIN_DISPLAY_NAME_CHARS ||
      name.length > MAX_DISPLAY_NAME_CHARS)
  ) {
    issues.push(
      issue(path, "name must be a 2-80 character display name", {
        line: yamlLineForPath(doc, ["name"]),
        field: "name",
        code: "invalid_name",
      }),
    );
  }
  const layer = raw.layer;
  if (!layer || typeof layer !== "object" || Array.isArray(layer)) {
    issues.push(
      issue(path, "layer.dockerfile is required", {
        line: yamlLineForPath(doc, ["layer"]),
        field: "layer.dockerfile",
        code: "required",
      }),
    );
  }
  let normalizedDockerfile: string;
  const dockerfile =
    layer && typeof layer === "object" && !Array.isArray(layer)
      ? (layer as Record<string, unknown>).dockerfile
      : undefined;
  if (typeof dockerfile !== "string") {
    issues.push(
      issue(path, "layer.dockerfile must be a string", {
        line: yamlLineForPath(doc, ["layer", "dockerfile"]),
        field: "layer.dockerfile",
        code: "invalid_type",
      }),
    );
    normalizedDockerfile = "";
  } else {
    try {
      normalizedDockerfile = validateRepoRelativeCycloidPath(dockerfile, "layer.dockerfile");
    } catch (err) {
      issues.push(
        issue(path, err instanceof Error ? err.message : String(err), {
          line: yamlLineForPath(doc, ["layer", "dockerfile"]),
          field: "layer.dockerfile",
          code: "invalid_path",
        }),
      );
      normalizedDockerfile = "";
    }
  }

  const commandsNode = isMap(doc.contents) ? (doc.getIn(["smoke", "commands"], true) as Node | undefined) : undefined;
  const rawCommands = ((raw.smoke as Record<string, unknown> | undefined)?.commands ?? []) as unknown;
  const smokeCommands: string[][] = [];
  if (!Array.isArray(rawCommands)) {
    issues.push(
      issue(path, "smoke.commands must be an array", {
        line: yamlLineForPath(doc, ["smoke", "commands"]),
        field: "smoke.commands",
        code: "invalid_type",
      }),
    );
  } else {
    if (rawCommands.length > MAX_SMOKE_COMMANDS) {
      issues.push(
        issue(path, `smoke.commands may contain at most ${MAX_SMOKE_COMMANDS} commands`, {
          line: yamlLineForPath(doc, ["smoke", "commands"]),
          field: "smoke.commands",
          code: "too_many_items",
        }),
      );
    }
    rawCommands.forEach((command, index) => {
      const commandNode = isSeq(commandsNode)
        ? (commandsNode.items[index] as { range?: [number, number, number?] } | undefined)
        : undefined;
      const line = commandNode?.range
        ? text.slice(0, commandNode.range[0]).split(/\r?\n/).length
        : yamlLineForPath(doc, ["smoke", "commands"]);
      const field = `smoke.commands.${index}`;
      if (!Array.isArray(command)) {
        issues.push(
          issue(path, "smoke commands must be argument arrays, not shell strings", {
            line,
            field,
            code: "invalid_type",
          }),
        );
        return;
      }
      if (command.length === 0 || command.length > MAX_SMOKE_ARGS) {
        issues.push(
          issue(path, `smoke commands must contain 1-${MAX_SMOKE_ARGS} args`, { line, field, code: "invalid_length" }),
        );
        return;
      }
      const parsedCommand: string[] = [];
      command.forEach((arg, argIndex) => {
        const argField = `${field}.${argIndex}`;
        if (
          typeof arg !== "string" ||
          arg.length === 0 ||
          arg.includes("\0") ||
          /[\r\n]/.test(arg) ||
          byteLength(arg) > MAX_SMOKE_ARG_BYTES
        ) {
          issues.push(
            issue(
              path,
              `smoke args must be non-empty strings up to ${MAX_SMOKE_ARG_BYTES} bytes with no NUL or newline`,
              { line, field: argField, code: "invalid_smoke_arg" },
            ),
          );
          return;
        }
        if (SECRET_PATTERN.test(arg)) {
          issues.push(
            issue(path, "smoke args must not contain obvious secret material", {
              line,
              field: argField,
              code: "secret_like",
            }),
          );
          return;
        }
        parsedCommand.push(arg);
      });
      if (parsedCommand.length === command.length) smokeCommands.push(parsedCommand);
    });
  }

  if (issues.length > 0) throw new SandboxLayerValidationError(issues);

  return { version: 1, name, layer: { dockerfile: normalizedDockerfile }, smoke: { commands: smokeCommands } };
}

function splitLogicalInstructions(
  path: string,
  text: string,
): Array<{ text: string; startLine: number; endLine: number }> {
  assertSize(path, text, MAX_LAYER_BYTES);
  rejectSecrets(path, text);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const result: Array<{ text: string; startLine: number; endLine: number }> = [];
  let current = "";
  let startLine = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const rawLine = lines[index]!;
    const trimmed = rawLine.trim();
    if (!current && (!trimmed || trimmed.startsWith("#"))) {
      if (/^#\s*syntax\s*=/i.test(trimmed)) {
        throw new SandboxLayerValidationError(path, "BuildKit syntax directives are not supported", lineNumber);
      }
      continue;
    }
    if (/<<\s*[-\w'"]+/.test(rawLine)) {
      throw new SandboxLayerValidationError(path, "heredocs are not supported in sandbox layer files", lineNumber);
    }
    if (!current) startLine = lineNumber;
    const continued = /\\\s*$/.test(rawLine);
    current += (current ? " " : "") + rawLine.replace(/\\\s*$/, "").trim();
    if (byteLength(current) > MAX_LAYER_BYTES) {
      throw new SandboxLayerValidationError(path, "continued instruction exceeds layer size limit", startLine);
    }
    if (!continued) {
      result.push({ text: current.trim(), startLine, endLine: lineNumber });
      current = "";
      startLine = 0;
    }
  }
  if (current) {
    throw new SandboxLayerValidationError(path, "unterminated line continuation", startLine);
  }
  return result;
}

function splitEnvTokens(path: string, body: string, startLine: number): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (const char of body) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote) throw new SandboxLayerValidationError(path, "ENV contains an unterminated quote", startLine);
  if (current) tokens.push(current);
  return tokens;
}

function parseEnvValues(path: string, body: string, startLine: number): Record<string, string> {
  const values: Record<string, string> = {};
  const tokens = splitEnvTokens(path, body, startLine);
  if (tokens.length > MAX_ENV_VARS) {
    throw new SandboxLayerValidationError(path, `ENV may set at most ${MAX_ENV_VARS} variables`, startLine);
  }
  for (const token of tokens) {
    const separator = token.indexOf("=");
    if (separator <= 0) {
      throw new SandboxLayerValidationError(path, "ENV entries must use KEY=value form", startLine);
    }
    const key = token.slice(0, separator);
    let value = token.slice(separator + 1);
    if (!ENV_KEY_RE.test(key)) {
      throw new SandboxLayerValidationError(path, `invalid ENV key '${key}'`, startLine);
    }
    if (key.length > MAX_ENV_KEY_CHARS) {
      throw new SandboxLayerValidationError(path, `ENV key '${key}' is too long`, startLine);
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!value || value.includes("\0") || /[\r\n]/.test(value) || byteLength(value) > MAX_ENV_VALUE_BYTES) {
      throw new SandboxLayerValidationError(
        path,
        `ENV value for '${key}' must be 1-${MAX_ENV_VALUE_BYTES} bytes with no NUL or newline`,
        startLine,
      );
    }
    if (SECRET_PATTERN.test(value)) {
      throw new SandboxLayerValidationError(
        path,
        `ENV value for '${key}' appears to contain obvious secret material`,
        startLine,
      );
    }
    values[key] = value;
  }
  if (Object.keys(values).length === 0) {
    throw new SandboxLayerValidationError(path, "ENV must set at least one value", startLine);
  }
  return values;
}

function assertRunSafety(path: string, command: string, startLine: number): void {
  if (byteLength(command) > MAX_RUN_COMMAND_BYTES) {
    throw new SandboxLayerValidationError(path, `RUN command exceeds ${MAX_RUN_COMMAND_BYTES} byte limit`, startLine);
  }
  if (/(^|\s)--mount=/.test(command)) {
    throw new SandboxLayerValidationError(path, "BuildKit RUN --mount is not supported", startLine);
  }
  if (SECRET_PATTERN.test(command)) {
    throw new SandboxLayerValidationError(path, "RUN command appears to contain obvious secret material", startLine);
  }
  const lower = command.toLowerCase();
  const targetsForbiddenPath = FORBIDDEN_PATHS.some((forbidden) => lower.includes(forbidden.toLowerCase()));
  if (targetsForbiddenPath && FORBIDDEN_TARGETING_OPS.test(lower)) {
    throw new SandboxLayerValidationError(path, "RUN modifies a Cycloid-owned runtime path", startLine);
  }
}

export function parseSandboxLayerDockerfile(path: string, text: string): SandboxLayerInstruction[] {
  const instructions = splitLogicalInstructions(path, text);
  return instructions.map((entry) => {
    const match = entry.text.match(/^([A-Za-z]+)\s*(.*)$/s);
    if (!match) {
      throw new SandboxLayerValidationError(path, "invalid Dockerfile instruction", entry.startLine);
    }
    const instruction = match[1]!.toUpperCase();
    const body = match[2]!.trim();
    if (instruction === "RUN") {
      if (!body) throw new SandboxLayerValidationError(path, "RUN must not be empty", entry.startLine);
      assertRunSafety(path, body, entry.startLine);
      return { kind: "run", command: body, startLine: entry.startLine, endLine: entry.endLine };
    }
    if (instruction === "ENV") {
      return {
        kind: "env",
        values: parseEnvValues(path, body, entry.startLine),
        startLine: entry.startLine,
        endLine: entry.endLine,
      };
    }
    throw new SandboxLayerValidationError(
      path,
      `${instruction} is not supported in Cycloid sandbox layer files. V1 layers support only RUN and ENV.`,
      entry.startLine,
    );
  });
}

export function normalizeSandboxLayerInstructions(instructions: SandboxLayerInstruction[]): string {
  return JSON.stringify(
    instructions.map((instruction) => {
      if (instruction.kind === "run") return { kind: "run", command: instruction.command };
      return {
        kind: "env",
        values: Object.fromEntries(
          Object.entries(instruction.values).sort(([left], [right]) => left.localeCompare(right)),
        ),
      };
    }),
  );
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
}

export function canonicalSandboxLayerSourceJson(input: {
  manifest: SandboxLayerManifest;
  instructions: SandboxLayerInstruction[];
  buildIdentity?: ParseSandboxLayerSourceInput["buildIdentity"];
}): string {
  return JSON.stringify(
    sortJsonValue({
      schemaVersion: 1,
      manifest: {
        version: input.manifest.version,
        name: input.manifest.name,
        layerDockerfile: input.manifest.layer.dockerfile,
        smokeCommands: input.manifest.smoke.commands,
      },
      layer: JSON.parse(normalizeSandboxLayerInstructions(input.instructions)) as unknown,
      buildIdentity: input.buildIdentity ?? null,
    }),
  );
}

export async function parseSandboxLayerSource(input: ParseSandboxLayerSourceInput): Promise<ParsedSandboxLayerSource> {
  const manifest = parseSandboxLayerManifest(input.manifestPath, input.manifestText);
  if (manifest.layer.dockerfile !== input.layerPath) {
    throw new SandboxLayerValidationError(
      input.manifestPath,
      `layer.dockerfile must match fetched layer path '${input.layerPath}'`,
      undefined,
      "layer.dockerfile",
      "layer_path_mismatch",
    );
  }
  const instructions = parseSandboxLayerDockerfile(input.layerPath, input.layerText);
  const canonicalSource = canonicalSandboxLayerSourceJson({
    manifest,
    instructions,
    buildIdentity: input.buildIdentity,
  });
  return {
    manifest: {
      version: manifest.version,
      name: manifest.name,
      layerDockerfile: manifest.layer.dockerfile,
      smokeCommands: manifest.smoke.commands,
    },
    layer: { instructions },
    hashes: {
      manifestHash: await computeSha256Hex(input.manifestText),
      layerHash: await computeSha256Hex(input.layerText),
      normalizedSourceHash: await computeSha256Hex(canonicalSource),
    },
  };
}
