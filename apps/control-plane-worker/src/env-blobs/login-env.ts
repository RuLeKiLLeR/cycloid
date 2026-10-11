export const REPO_LOGIN_ENV_BLOB_NAME = "app_login";

const REPO_LOGIN_ENV_KEYS = [
  "ARCANIST_LOGIN_USERNAME",
  "ARCANIST_LOGIN_PASSWORD",
  "ARCANIST_LOGIN_PAGE",
  "ARCANIST_AUTHENTICATED_PAGE",
] as const;

type RepoLoginEnvKey = (typeof REPO_LOGIN_ENV_KEYS)[number];

export type RepoRuntimeEnvVars = Record<string, string>;
type RepoLoginEnvVars = Partial<Record<RepoLoginEnvKey, string>>;

const MAX_REPO_LOGIN_ENV_BYTES = 16 * 1024;
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_RUNTIME_KEYS = new Set(["PATH", "HOME", "PWD", "SHELL", "USER"]);

export class RepoRuntimeEnvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoRuntimeEnvValidationError";
  }
}

export function assertRepoRuntimeEnvKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new RepoRuntimeEnvValidationError(`Invalid env key: ${key}`);
  }
  if (RESERVED_RUNTIME_KEYS.has(key)) {
    throw new RepoRuntimeEnvValidationError(`Reserved runtime key: ${key}`);
  }
}

export function assertRepoRuntimeEnvValue(key: string, value: string): void {
  if (value.includes("\0")) {
    throw new RepoRuntimeEnvValidationError(`Value for ${key} contains an invalid character`);
  }
  if (value.includes("\n") || value.includes("\r")) {
    throw new RepoRuntimeEnvValidationError(`Multiline values are not supported for ${key}`);
  }
}

function decodeEnvValue(rawValue: string, lineNumber: number): string {
  const value = rawValue.trim();
  if (!value) return "";

  const quote = value[0];
  if (quote !== "'" && quote !== '"') return value;

  if (value.length < 2 || value[value.length - 1] !== quote) {
    throw new RepoRuntimeEnvValidationError(`Multiline values are not supported on line ${lineNumber}`);
  }

  const inner = value.slice(1, -1);
  if (quote === "'") return inner;

  return inner.replace(/\\([\\rt"])/g, (_match, escaped: string) => {
    switch (escaped) {
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "\\":
        return "\\";
      case '"':
        return '"';
      default:
        return escaped;
    }
  });
}

function assertRelativeSandboxPath(key: RepoLoginEnvKey, value: string): void {
  if (!value.startsWith("/") || value.startsWith("//")) {
    throw new RepoRuntimeEnvValidationError(`${key} must be a sandbox-absolute path starting with /`);
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    throw new RepoRuntimeEnvValidationError(`${key} must not be an external URL`);
  }
  if (value.includes("?") || value.includes("#")) {
    throw new RepoRuntimeEnvValidationError(`${key} must not include query strings or fragments`);
  }
  if (value.includes("\\") || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new RepoRuntimeEnvValidationError(`${key} must be a clean relative path`);
  }
}

export function parseRepoRuntimeEnv(envText: string): RepoRuntimeEnvVars {
  const bytes = new TextEncoder().encode(envText).byteLength;
  if (bytes > MAX_REPO_LOGIN_ENV_BYTES) {
    throw new RepoRuntimeEnvValidationError("Repository env file is too large");
  }

  const parsed = new Map<string, string>();
  const lines = envText.split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    if (rawLine.includes("\0")) {
      throw new RepoRuntimeEnvValidationError(`Line ${lineNumber} contains an invalid character`);
    }
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const assignment = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
    const equalsIndex = assignment.indexOf("=");
    if (equalsIndex <= 0) {
      throw new RepoRuntimeEnvValidationError(`Line ${lineNumber} must be KEY=value`);
    }

    const key = assignment.slice(0, equalsIndex).trim();
    if (!KEY_PATTERN.test(key)) {
      throw new RepoRuntimeEnvValidationError(`Line ${lineNumber} has an invalid key`);
    }
    if (RESERVED_RUNTIME_KEYS.has(key)) {
      throw new RepoRuntimeEnvValidationError(`Line ${lineNumber} uses reserved runtime key: ${key}`);
    }
    if (parsed.has(key)) {
      throw new RepoRuntimeEnvValidationError(`Duplicate env key: ${key}`);
    }

    const value = decodeEnvValue(assignment.slice(equalsIndex + 1), lineNumber);
    assertRepoRuntimeEnvValue(key, value);
    // Shell-looking syntax is stored literally and passed as process env, not
    // interpolated through a shell. Keep downstream consumers on that boundary.
    parsed.set(key, value);
  }

  const vars = Object.fromEntries(parsed.entries());
  if (typeof vars.ARCANIST_LOGIN_PAGE === "string")
    assertRelativeSandboxPath("ARCANIST_LOGIN_PAGE", vars.ARCANIST_LOGIN_PAGE);
  if (typeof vars.ARCANIST_AUTHENTICATED_PAGE === "string")
    assertRelativeSandboxPath("ARCANIST_AUTHENTICATED_PAGE", vars.ARCANIST_AUTHENTICATED_PAGE);
  return vars;
}

export function normalizeRepoRuntimeKeyNames(keyNames: readonly string[]): string[] {
  return keyNames.filter((key) => KEY_PATTERN.test(key) && !RESERVED_RUNTIME_KEYS.has(key));
}

function encodeRepoRuntimeEnvValue(value: string): string {
  if (value === "") return '""';
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\r/g, "\\r").replace(/"/g, '\\"')}"`;
}

export function formatRepoRuntimeEnv(envVars: RepoRuntimeEnvVars): string {
  const entries = Object.entries(envVars).sort(([left], [right]) => left.localeCompare(right));
  for (const [key, value] of entries) {
    assertRepoRuntimeEnvKey(key);
    assertRepoRuntimeEnvValue(key, value);
  }
  return entries.map(([key, value]) => `${key}=${encodeRepoRuntimeEnvValue(value)}`).join("\n");
}

export function pickRepoLoginEnvVars(envVars: RepoRuntimeEnvVars): RepoLoginEnvVars {
  return Object.fromEntries(REPO_LOGIN_ENV_KEYS.filter((key) => key in envVars).map((key) => [key, envVars[key]]));
}
