import { parse as parseYaml } from "yaml";

import { AGENT_CHILD_ENV_EXACT_ALLOWLIST } from "../../../../shared/constants/agent-child-env.js";
import type { AppRuntimeProfileConfig } from "../../../../shared/types/repo-runtime.js";
import type {
  AppRuntimeProfileDiagnostic,
  AppRuntimeProfileSource,
  DockerRuntimeEntry,
  PreviewContract,
  PreviewContractAdditionalPort,
  PreviewContractAuthConfig,
  PreviewContractE2EConfig,
  PreviewContractGeneratedComposeEnv,
} from "../../../../shared/types/sandbox.js";
import { REPO_PREVIEW_DOCKER_COMPOSE_FILES } from "../constants/repo-preview.js";
import { githubHeaders } from "../github/pr.js";
import { getFileContent } from "../memory/github.js";
import { tracedFetch } from "../observability/wrappers.js";
import { asNonEmptyString } from "../utils.js";

const DEFAULT_CWD = "/workspace/repo";
const SUPPORTED_STRATEGY_MESSAGE = 'Only Docker App Runtime Profiles are supported. Set appRuntime.runner to "docker".';

/** Fetch only root-level entries (non-recursive) — fast for any repo size. */
async function fetchRootEntries(token: string, owner: string, repo: string, ref: string): Promise<string[]> {
  const res = await tracedFetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}`,
    { headers: githubHeaders(token) },
    "github.fetchRootEntries",
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { tree: Array<{ path: string; type: string }> };
  return data.tree.map((e) => e.path);
}

type CycloidRuntimeConfig = {
  appRuntime?: AppRuntimeProfileConfig;
};

type AppRuntimeProfileResolution = {
  dockerEnabled: boolean;
  previewContract: PreviewContract | null;
  source: AppRuntimeProfileSource;
  diagnostics: AppRuntimeProfileDiagnostic[];
};

function addDiagnostic(diagnostics: AppRuntimeProfileDiagnostic[], diagnostic: AppRuntimeProfileDiagnostic): void {
  diagnostics.push(diagnostic);
}

function coercePositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizePreviewPort(value: unknown, diagnostics: AppRuntimeProfileDiagnostic[], field: string): number | null {
  const parsed = coercePositiveInt(value);
  if (parsed && parsed <= 65_535) {
    return parsed;
  }
  addDiagnostic(diagnostics, {
    code: "invalid_port_mapping",
    severity: "error",
    field,
    value: typeof value === "number" || typeof value === "string" || typeof value === "boolean" ? value : null,
    message: "App Runtime Profile url.hostPort must be a positive TCP port in the range 1-65535.",
  });
  return null;
}

function sanitizePortMappingPort(
  value: unknown,
  diagnostics: AppRuntimeProfileDiagnostic[],
  field: string,
): number | null {
  const parsed = coercePositiveInt(value);
  if (parsed && parsed <= 65_535) {
    return parsed;
  }
  addDiagnostic(diagnostics, {
    code: "invalid_port_mapping",
    severity: "error",
    field,
    value: typeof value === "number" || typeof value === "string" || typeof value === "boolean" ? value : null,
    message: `${field} must be a positive TCP port in the range 1-65535.`,
  });
  return null;
}

function sanitizeAdditionalPorts(
  value: unknown,
  diagnostics: AppRuntimeProfileDiagnostic[],
  field: string,
  primaryService: string,
  primaryHostPort: number,
): PreviewContractAdditionalPort[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    addDiagnostic(diagnostics, {
      code: "invalid_port_mapping",
      severity: "error",
      field,
      message: "App Runtime Profile additionalPorts must be an array.",
    });
    return undefined;
  }

  const seenHostPorts = new Set([primaryHostPort]);
  const sanitized: PreviewContractAdditionalPort[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const entryField = `${field}[${index}]`;
    if (!isRecord(entry)) {
      addDiagnostic(diagnostics, {
        code: "invalid_port_mapping",
        severity: "error",
        field: entryField,
        message: "Each additionalPorts entry must be an object.",
      });
      continue;
    }

    const hostPort = sanitizePortMappingPort(entry.hostPort, diagnostics, `${entryField}.hostPort`);
    const service = entry.service === undefined ? primaryService : asNonEmptyString(entry.service);
    if (!service) {
      addDiagnostic(diagnostics, {
        code: "invalid_port_mapping",
        severity: "error",
        field: `${entryField}.service`,
        value: typeof entry.service === "string" ? entry.service : null,
        message: "App Runtime Profile additionalPorts[].service must be a non-empty string when provided.",
      });
    }
    const containerPort =
      entry.containerPort === undefined
        ? undefined
        : sanitizePortMappingPort(entry.containerPort, diagnostics, `${entryField}.containerPort`);

    const duplicateHostPort = hostPort !== null && seenHostPorts.has(hostPort);
    if (duplicateHostPort) {
      addDiagnostic(diagnostics, {
        code: "invalid_port_mapping",
        severity: "error",
        field: `${entryField}.hostPort`,
        value: hostPort,
        message: `App Runtime Profile additionalPorts[].hostPort ${hostPort} duplicates another exposed host port.`,
      });
    }
    if (hostPort === null || !service || containerPort === null || duplicateHostPort) {
      if (hostPort !== null) {
        seenHostPorts.add(hostPort);
      }
      continue;
    }

    seenHostPorts.add(hostPort);
    sanitized.push({
      ...(service !== primaryService ? { service } : {}),
      hostPort,
      ...(containerPort ? { containerPort } : {}),
    });
  }

  return sanitized.length > 0 ? sanitized : undefined;
}

function sanitizePath(value: unknown): string | undefined {
  const trimmed = asNonEmptyString(value);
  if (!trimmed) return undefined;
  const path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return path === "/" ? undefined : path;
}

function isValidRepoRelativePath(value: unknown): value is string {
  const trimmed = asNonEmptyString(value);
  if (!trimmed) return false;
  if (trimmed === ".") return true;
  return !trimmed.startsWith("/") && !trimmed.split("/").includes("..");
}

function sanitizeLegacyCwd(value: unknown, diagnostics: AppRuntimeProfileDiagnostic[], field: string): string {
  const trimmed = asNonEmptyString(value);
  if (!trimmed || trimmed === ".") return DEFAULT_CWD;
  if (!isValidRepoRelativePath(trimmed)) {
    addDiagnostic(diagnostics, {
      code: "invalid_cwd",
      severity: "error",
      field,
      value: trimmed,
      message: `Invalid legacy App Runtime Profile cwd ${JSON.stringify(trimmed)}. Use a repo-relative directory without "..".`,
    });
    return DEFAULT_CWD;
  }
  return `${DEFAULT_CWD}/${trimmed}`;
}

async function validateRepoFile(
  token: string,
  owner: string,
  repo: string,
  ref: string,
  path: string,
): Promise<boolean> {
  return (await getFileContent(token, owner, repo, path, ref)) !== null;
}

function sanitizeStringMap(
  value: unknown,
  diagnostics: AppRuntimeProfileDiagnostic[],
  field: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    addDiagnostic(diagnostics, {
      code: "invalid_env",
      severity: "error",
      field,
      message: `${field} must be an object with string values.`,
    });
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.some(([, entryValue]) => typeof entryValue !== "string")) {
    addDiagnostic(diagnostics, {
      code: "invalid_env",
      severity: "error",
      field,
      message: `${field} must contain only string values.`,
    });
    return undefined;
  }
  return Object.fromEntries(entries as Array<[string, string]>);
}

function sanitizeGeneratedComposeEnv(
  value: unknown,
  diagnostics: AppRuntimeProfileDiagnostic[],
  field: string,
): PreviewContractGeneratedComposeEnv | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    addDiagnostic(diagnostics, {
      code: "invalid_env",
      severity: "error",
      field,
      message: `${field} must be an object with generated env specs.`,
    });
    return undefined;
  }

  const sanitized: PreviewContractGeneratedComposeEnv = {};
  for (const [key, spec] of Object.entries(value)) {
    const entryField = `${field}.${key}`;
    if (!key.trim()) {
      addDiagnostic(diagnostics, {
        code: "invalid_env",
        severity: "error",
        field: entryField,
        message: `${field} keys must be non-empty strings.`,
      });
      continue;
    }
    const reservedEnvVarDescription = describeReservedEnvVar(key, { allowCustomerRuntimeExceptions: false });
    if (reservedEnvVarDescription) {
      addDiagnostic(diagnostics, {
        code: "invalid_env",
        severity: "error",
        field: entryField,
        value: key,
        message: `${field} key '${key}' uses a ${reservedEnvVarDescription}; pick a different name.`,
      });
      continue;
    }
    if (!isRecord(spec)) {
      addDiagnostic(diagnostics, {
        code: "invalid_env",
        severity: "error",
        field: entryField,
        message: `${entryField} must be an object.`,
      });
      continue;
    }
    if (spec.type !== "hex") {
      addDiagnostic(diagnostics, {
        code: "invalid_env",
        severity: "error",
        field: `${entryField}.type`,
        message: `${entryField}.type must be "hex".`,
      });
      continue;
    }
    const byteCount = coercePositiveInt(spec.bytes);
    if (!byteCount || byteCount > 128) {
      addDiagnostic(diagnostics, {
        code: "invalid_env",
        severity: "error",
        field: `${entryField}.bytes`,
        message: `${entryField}.bytes must be an integer in the range 1-128.`,
      });
      continue;
    }
    sanitized[key] = { type: "hex", bytes: byteCount };
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

async function resolveDefaultComposeFile(
  token: string,
  owner: string,
  repo: string,
  ref: string,
  tree: string[],
): Promise<string | undefined> {
  const rootComposeFile = REPO_PREVIEW_DOCKER_COMPOSE_FILES.find((path) => tree.includes(path));
  if (!rootComposeFile) return undefined;
  return (await validateRepoFile(token, owner, repo, ref, rootComposeFile)) ? rootComposeFile : undefined;
}

async function sanitizeComposeFiles(
  token: string,
  owner: string,
  repo: string,
  ref: string,
  values: unknown,
  tree: string[],
  diagnostics: AppRuntimeProfileDiagnostic[],
  field: string,
): Promise<string[] | null> {
  const rawFiles = Array.isArray(values) ? values : [];
  const defaultComposeFile =
    rawFiles.length > 0 ? undefined : await resolveDefaultComposeFile(token, owner, repo, ref, tree);
  if (rawFiles.length === 0 && !defaultComposeFile) {
    addDiagnostic(diagnostics, {
      code: "docker_compose_missing",
      severity: "error",
      field,
      value: null,
      message: "Docker App Runtime Profile did not specify entry.files and no root-level Compose file was detected.",
    });
    return null;
  }

  const candidates: unknown[] = rawFiles.length > 0 ? rawFiles : [defaultComposeFile];
  const files: string[] = [];
  for (const candidate of candidates) {
    if (!isValidRepoRelativePath(candidate)) {
      addDiagnostic(diagnostics, {
        code: "invalid_compose_file",
        severity: "error",
        field,
        value: typeof candidate === "string" ? candidate : null,
        message: `Invalid Docker Compose file path in App Runtime Profile. Use repo-relative files without "..".`,
      });
      continue;
    }
    if (!(await validateRepoFile(token, owner, repo, ref, candidate))) {
      addDiagnostic(diagnostics, {
        code: "docker_compose_missing",
        severity: "error",
        field,
        value: candidate,
        message: `Docker Compose file ${JSON.stringify(candidate)} does not exist in the repository.`,
      });
      continue;
    }
    files.push(candidate);
  }
  return files.length > 0 ? files : null;
}

async function inferSingleComposeService(
  token: string,
  owner: string,
  repo: string,
  ref: string,
  files: string[],
): Promise<string | null> {
  const services = new Set<string>();
  for (const file of files) {
    const content = await getFileContent(token, owner, repo, file, ref);
    if (!content) return null;
    try {
      const parsed = parseYaml(content) as unknown;
      if (!isRecord(parsed) || !isRecord(parsed.services)) return null;
      for (const serviceName of Object.keys(parsed.services)) {
        services.add(serviceName);
      }
    } catch {
      return null;
    }
  }
  return services.size === 1 ? [...services][0] : null;
}

async function buildDockerPreviewContract(
  token: string,
  owner: string,
  repo: string,
  ref: string,
  profile: AppRuntimeProfileConfig,
  tree: string[],
  diagnostics: AppRuntimeProfileDiagnostic[],
  fieldPrefix: string,
): Promise<PreviewContract | null> {
  if (profile.kind !== "web") {
    addDiagnostic(diagnostics, {
      code: "invalid_entry",
      severity: "error",
      field: `${fieldPrefix}.kind`,
      value: profile.kind ?? null,
      message: 'App Runtime Profile kind must be "web".',
    });
    return null;
  }

  if (profile.runner !== "docker") {
    addDiagnostic(diagnostics, {
      code: "unsupported_runner",
      severity: "error",
      field: `${fieldPrefix}.runner`,
      value: profile.runner ?? null,
      message: SUPPORTED_STRATEGY_MESSAGE,
    });
    return null;
  }

  if (!isRecord(profile.entry)) {
    addDiagnostic(diagnostics, {
      code: "invalid_entry",
      severity: "error",
      field: `${fieldPrefix}.entry`,
      message: "App Runtime Profile entry is required.",
    });
    return null;
  }

  const hostPort = sanitizePreviewPort(profile.url?.hostPort, diagnostics, `${fieldPrefix}.url.hostPort`);
  const readyPath = sanitizePath(profile.ready?.path);
  const openPath = sanitizePath(profile.open?.path ?? profile.url?.path);
  const urlPath = sanitizePath(profile.url?.path);
  const composeEnv = sanitizeStringMap(profile.composeEnv, diagnostics, `${fieldPrefix}.composeEnv`);
  const generatedComposeEnv = sanitizeGeneratedComposeEnv(
    profile.generatedComposeEnv,
    diagnostics,
    `${fieldPrefix}.generatedComposeEnv`,
  );
  const env = sanitizeStringMap(profile.env, diagnostics, `${fieldPrefix}.env`);
  const timeoutSeconds = coercePositiveInt(profile.ready?.timeoutSeconds);
  const sanitizedCwd = sanitizeLegacyCwd(profile.cwd, diagnostics, `${fieldPrefix}.cwd`);
  const containerPort =
    profile.portMapping?.containerPort === undefined
      ? undefined
      : sanitizePortMappingPort(
          profile.portMapping.containerPort,
          diagnostics,
          `${fieldPrefix}.portMapping.containerPort`,
        );

  const entry = profile.entry;
  let resolvedEntry: DockerRuntimeEntry | null = null;
  if (entry.type === "compose") {
    const files = await sanitizeComposeFiles(
      token,
      owner,
      repo,
      ref,
      entry.files,
      tree,
      diagnostics,
      `${fieldPrefix}.entry.files`,
    );
    const service =
      asNonEmptyString(entry.service) ??
      (files ? await inferSingleComposeService(token, owner, repo, ref, files) : null);
    let profiles: string[] | undefined;
    if (entry.profiles !== undefined) {
      if (
        !Array.isArray(entry.profiles) ||
        entry.profiles.some((profileName) => typeof profileName !== "string" || !profileName.trim())
      ) {
        addDiagnostic(diagnostics, {
          code: "invalid_entry",
          severity: "error",
          field: `${fieldPrefix}.entry.profiles`,
          message: "Compose App Runtime Profile entry.profiles must contain only non-empty strings.",
        });
        return null;
      }
      profiles = entry.profiles.map((profileName) => profileName.trim());
    }
    if (!files || !service) {
      addDiagnostic(diagnostics, {
        code: "invalid_entry",
        severity: "error",
        field: `${fieldPrefix}.entry.service`,
        message: "Compose App Runtime Profile entry requires files and service.",
      });
      return null;
    }
    resolvedEntry = {
      type: "compose",
      files,
      service,
      ...(profiles ? { profiles } : {}),
    };
  } else if (entry.type === "dockerfile") {
    const service = asNonEmptyString(entry.service);
    const context = asNonEmptyString(entry.context);
    const dockerfile = asNonEmptyString(entry.dockerfile);
    const invalidPath = [context, dockerfile].some((path) => !isValidRepoRelativePath(path));
    if (!service || !context || !dockerfile || invalidPath) {
      addDiagnostic(diagnostics, {
        code: "invalid_path",
        severity: "error",
        field: `${fieldPrefix}.entry`,
        message: "Dockerfile App Runtime Profile entry requires repo-relative context, dockerfile, and service.",
      });
      return null;
    }
    if (!(await validateRepoFile(token, owner, repo, ref, dockerfile))) {
      addDiagnostic(diagnostics, {
        code: "dockerfile_missing",
        severity: "error",
        field: `${fieldPrefix}.entry.dockerfile`,
        value: dockerfile,
        message: `Dockerfile ${JSON.stringify(dockerfile)} does not exist in the repository.`,
      });
      return null;
    }
    if (containerPort === undefined) {
      addDiagnostic(diagnostics, {
        code: "invalid_port_mapping",
        severity: "error",
        field: `${fieldPrefix}.portMapping.containerPort`,
        message: "Dockerfile App Runtime Profile entries require portMapping.containerPort.",
      });
      return null;
    }
    resolvedEntry = { type: "dockerfile", context, dockerfile, service };
  } else {
    addDiagnostic(diagnostics, {
      code: "invalid_entry",
      severity: "error",
      field: `${fieldPrefix}.entry.type`,
      value:
        typeof (entry as Record<string, unknown>).type === "string" ? (entry as Record<string, string>).type : null,
      message: 'App Runtime Profile entry.type must be "compose" or "dockerfile".',
    });
    return null;
  }

  const auth = sanitizeAuthBlock(profile.auth, diagnostics, `${fieldPrefix}.auth`);
  const e2e = sanitizeE2EBlock(profile.e2e, diagnostics, `${fieldPrefix}.e2e`);

  if (hostPort === null || diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return null;
  }

  const additionalPorts = sanitizeAdditionalPorts(
    profile.additionalPorts,
    diagnostics,
    `${fieldPrefix}.additionalPorts`,
    resolvedEntry.service,
    hostPort,
  );
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return null;
  }

  return {
    cwd: sanitizedCwd,
    kind: "web",
    runner: "docker",
    entry: resolvedEntry,
    url: {
      hostPort,
      ...(urlPath ? { path: urlPath } : {}),
    },
    ...(containerPort ? { portMapping: { containerPort } } : {}),
    ...(additionalPorts ? { additionalPorts } : {}),
    ...(composeEnv ? { composeEnv } : {}),
    ...(generatedComposeEnv ? { generatedComposeEnv } : {}),
    ...(env ? { env } : {}),
    ...(readyPath || timeoutSeconds
      ? { ready: { ...(readyPath ? { path: readyPath } : {}), ...(timeoutSeconds ? { timeoutSeconds } : {}) } }
      : {}),
    ...(openPath ? { open: { path: openPath } } : {}),
    ...(auth ? { auth } : {}),
    ...(e2e ? { e2e } : {}),
  };
}

const E2E_CREDENTIAL_NAME_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/;
const E2E_CREDENTIAL_ENV_VAR_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;
// Reserved envVar prefixes the customer cannot bind to. Without this, a
// declared `credentials[].envVar` could shadow platform secrets the bridge
// relies on (e.g. CYCLOID_BRIDGE_TOKEN, GITHUB_TOKEN). Within the customer's
// own sandbox the worst case is self-DoS, but blocking it at validation time
// keeps the failure mode discoverable instead of silent.
const RESERVED_ENV_VAR_PREFIXES = [
  "ARCANIST_",
  "BRIDGE_",
  "CLAUDE_", // CLAUDE_CLI_PATH and other agent-runtime execution-control names
  "CODEX_",
  "GH_", // GH_TOKEN, GH_HOST, GH_REPO, etc. -- gh CLI auth
  "GITHUB_",
  "OPENAI_",
  "SANDBOX_", // SANDBOX_AUTH_TOKEN, SANDBOX_ID, etc.
  "SESSION_",
  "TOKEN_",
];

// Reserved exact envVar names. Unlike prefixes these are short common names
// that shouldn't be reserved by prefix (would over-block) but must not be
// rebindable from a contract. Includes every exact name on the agent-child
// env allowlist plus NODE_OPTIONS: a customer credential declared under an
// allowlisted name would otherwise survive into the agent child env, and
// NODE_OPTIONS can preload code into the Node-based agent processes.
const RESERVED_ENV_VAR_NAMES = new Set<string>([
  "PORT",
  "HOST",
  "NODE_ENV",
  "NODE_OPTIONS",
  ...AGENT_CHILD_ENV_EXACT_ALLOWLIST,
]);
const CUSTOMER_RUNTIME_ENV_VAR_EXCEPTIONS = new Set(["ARCANIST_LOGIN_USERNAME", "ARCANIST_LOGIN_PASSWORD"]);

type ReservedEnvVarOptions = {
  allowCustomerRuntimeExceptions?: boolean;
};

function describeReservedEnvVar(
  envVar: string,
  { allowCustomerRuntimeExceptions = true }: ReservedEnvVarOptions = {},
): string | null {
  if (allowCustomerRuntimeExceptions && CUSTOMER_RUNTIME_ENV_VAR_EXCEPTIONS.has(envVar)) return null;
  if (RESERVED_ENV_VAR_NAMES.has(envVar)) return `reserved name (${Array.from(RESERVED_ENV_VAR_NAMES).join(", ")})`;
  if (RESERVED_ENV_VAR_PREFIXES.some((prefix) => envVar.startsWith(prefix))) {
    return `reserved prefix (${RESERVED_ENV_VAR_PREFIXES.join(", ")})`;
  }
  return null;
}

function isReservedEnvVar(envVar: string): boolean {
  return describeReservedEnvVar(envVar) !== null;
}

function sanitizeE2ECommand(
  value: unknown,
  diagnostics: AppRuntimeProfileDiagnostic[],
  field: string,
  required: boolean,
): string | null {
  if (value === undefined || value === null) {
    if (required) {
      addDiagnostic(diagnostics, {
        code: "missing_e2e_test_command",
        severity: "error",
        field,
        message: `App Runtime Profile ${field} is required when appRuntime.e2e is declared.`,
      });
    }
    return null;
  }
  if (typeof value !== "string" || !value.trim()) {
    addDiagnostic(diagnostics, {
      code: "invalid_e2e_command",
      severity: "error",
      field,
      message: `App Runtime Profile ${field} must be a non-empty string.`,
    });
    return null;
  }
  return value.trim();
}

function sanitizeAuthCommand(value: unknown, diagnostics: AppRuntimeProfileDiagnostic[], field: string): string | null {
  if (value === undefined || value === null) {
    addDiagnostic(diagnostics, {
      code: "invalid_auth_config",
      severity: "error",
      field,
      message: `App Runtime Profile ${field} is required when appRuntime.auth is declared.`,
    });
    return null;
  }
  if (typeof value !== "string" || !value.trim()) {
    addDiagnostic(diagnostics, {
      code: "invalid_auth_config",
      severity: "error",
      field,
      message: `App Runtime Profile ${field} must be a non-empty string.`,
    });
    return null;
  }
  return value.trim();
}

function sanitizeCredentialDeclarations(
  value: unknown,
  diagnostics: AppRuntimeProfileDiagnostic[],
  field: string,
  label: string,
  code: AppRuntimeProfileDiagnostic["code"] = "invalid_e2e_credential",
): PreviewContractE2EConfig["credentials"] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    addDiagnostic(diagnostics, {
      code,
      severity: "error",
      field,
      message: `App Runtime Profile ${label}.credentials must be an array.`,
    });
    return undefined;
  }

  const sanitizedCredentials: PreviewContractE2EConfig["credentials"] = [];
  const seen = new Set<string>();
  const seenEnvVars = new Set<string>();
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    const credField = `${field}[${i}]`;
    if (!isRecord(entry)) {
      addDiagnostic(diagnostics, {
        code,
        severity: "error",
        field: credField,
        message: `Each ${label}.credentials entry must be an object with name and envVar.`,
      });
      continue;
    }
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const envVar = typeof entry.envVar === "string" ? entry.envVar.trim() : "";
    if (!E2E_CREDENTIAL_NAME_PATTERN.test(name)) {
      addDiagnostic(diagnostics, {
        code,
        severity: "error",
        field: `${credField}.name`,
        value: name,
        message: `${label}.credentials[].name must match [a-zA-Z0-9_.-]{1,64}.`,
      });
      continue;
    }
    if (!E2E_CREDENTIAL_ENV_VAR_PATTERN.test(envVar)) {
      addDiagnostic(diagnostics, {
        code,
        severity: "error",
        field: `${credField}.envVar`,
        value: envVar,
        message: `${label}.credentials[].envVar must be a POSIX-style env var name (uppercase, digits, underscore).`,
      });
      continue;
    }
    if (isReservedEnvVar(envVar)) {
      addDiagnostic(diagnostics, {
        code,
        severity: "error",
        field: `${credField}.envVar`,
        value: envVar,
        message: RESERVED_ENV_VAR_NAMES.has(envVar)
          ? `${label}.credentials[].envVar '${envVar}' is a reserved env var name; pick a different name.`
          : `${label}.credentials[].envVar '${envVar}' uses a reserved prefix (${RESERVED_ENV_VAR_PREFIXES.join(", ")}); pick a different name.`,
      });
      continue;
    }
    if (seen.has(name)) {
      addDiagnostic(diagnostics, {
        code,
        severity: "error",
        field: `${credField}.name`,
        value: name,
        message: `${label}.credentials[].name '${name}' is declared more than once.`,
      });
      continue;
    }
    if (seenEnvVars.has(envVar)) {
      addDiagnostic(diagnostics, {
        code,
        severity: "error",
        field: `${credField}.envVar`,
        value: envVar,
        message: `${label}.credentials[].envVar '${envVar}' is declared more than once; pick a different envVar per credential.`,
      });
      continue;
    }
    const source = entry.source;
    if (
      source !== undefined &&
      source !== "business_openai_key" &&
      source !== "business_anthropic_key" &&
      source !== "business_neon_branch"
    ) {
      addDiagnostic(diagnostics, {
        code,
        severity: "error",
        field: `${credField}.source`,
        value: typeof source === "string" ? source : null,
        message:
          `${label}.credentials[].source must be "business_openai_key", ` +
          `"business_anthropic_key", or "business_neon_branch" when present.`,
      });
      continue;
    }
    seen.add(name);
    seenEnvVars.add(envVar);
    sanitizedCredentials.push({ name, envVar, ...(source ? { source } : {}) });
  }

  return sanitizedCredentials.length > 0 ? sanitizedCredentials : undefined;
}

function sanitizeAuthValidatePath(
  value: unknown,
  diagnostics: AppRuntimeProfileDiagnostic[],
  field: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = asNonEmptyString(value);
  if (!trimmed) {
    addDiagnostic(diagnostics, {
      code: "invalid_auth_config",
      severity: "error",
      field,
      message: "App Runtime Profile auth.validatePath must be a non-empty app-relative path.",
    });
    return undefined;
  }
  if (
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.includes("\\") ||
    trimmed.includes("?") ||
    trimmed.includes("#") ||
    /[\u0000-\u001F\u007F]/.test(trimmed) ||
    trimmed.includes("://")
  ) {
    addDiagnostic(diagnostics, {
      code: "invalid_auth_config",
      severity: "error",
      field,
      value: trimmed,
      message: "App Runtime Profile auth.validatePath must be an app-relative path like /dashboard.",
    });
    return undefined;
  }
  return trimmed;
}

function sanitizeAuthBlock(
  value: unknown,
  diagnostics: AppRuntimeProfileDiagnostic[],
  field: string,
): PreviewContractAuthConfig | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    addDiagnostic(diagnostics, {
      code: "invalid_auth_config",
      severity: "error",
      field,
      message: `App Runtime Profile ${field} must be an object.`,
    });
    return null;
  }

  const command = sanitizeAuthCommand(value.command, diagnostics, `${field}.command`);
  const validatePath = sanitizeAuthValidatePath(value.validatePath, diagnostics, `${field}.validatePath`);
  const credentials = sanitizeCredentialDeclarations(
    value.credentials,
    diagnostics,
    `${field}.credentials`,
    "auth",
    "invalid_auth_config",
  );

  if (!command) return null;

  return {
    command,
    ...(validatePath ? { validatePath } : {}),
    ...(credentials ? { credentials } : {}),
  };
}

function sanitizeE2EBlock(
  value: unknown,
  diagnostics: AppRuntimeProfileDiagnostic[],
  field: string,
): PreviewContractE2EConfig | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    addDiagnostic(diagnostics, {
      code: "invalid_e2e_command",
      severity: "error",
      field,
      message: `App Runtime Profile ${field} must be an object.`,
    });
    return null;
  }
  const testCommand = sanitizeE2ECommand(value.testCommand, diagnostics, `${field}.testCommand`, true);
  const seedCommand = sanitizeE2ECommand(value.seedCommand, diagnostics, `${field}.seedCommand`, false);
  const resetCommand = sanitizeE2ECommand(value.resetCommand, diagnostics, `${field}.resetCommand`, false);
  const credentials = sanitizeCredentialDeclarations(value.credentials, diagnostics, `${field}.credentials`, "e2e");

  if (!testCommand) return null;

  return {
    testCommand,
    ...(seedCommand ? { seedCommand } : {}),
    ...(resetCommand ? { resetCommand } : {}),
    ...(credentials ? { credentials } : {}),
  };
}

function getConfiguredRuntimeProfile(
  parsedConfig: CycloidRuntimeConfig | null,
): { profile: AppRuntimeProfileConfig; fieldPrefix: "appRuntime" } | null {
  if (parsedConfig?.appRuntime) return { profile: parsedConfig.appRuntime, fieldPrefix: "appRuntime" };
  return null;
}

async function resolveAppRuntimeProfileConfig(
  token: string,
  owner: string,
  repo: string,
  ref: string,
  profile: AppRuntimeProfileConfig,
  fieldPrefix = "appRuntime",
): Promise<AppRuntimeProfileResolution> {
  const diagnostics: AppRuntimeProfileDiagnostic[] = [];
  if (profile.runner !== "docker") {
    addDiagnostic(diagnostics, {
      code: "unsupported_runner",
      severity: "error",
      field: `${fieldPrefix}.runner`,
      value: profile.runner ?? null,
      message: SUPPORTED_STRATEGY_MESSAGE,
    });
    return {
      dockerEnabled: false,
      previewContract: null,
      source: "none",
      diagnostics,
    };
  }

  const tree = await fetchRootEntries(token, owner, repo, ref);
  const previewContract = await buildDockerPreviewContract(
    token,
    owner,
    repo,
    ref,
    profile,
    tree,
    diagnostics,
    fieldPrefix,
  );
  return {
    dockerEnabled: previewContract !== null,
    previewContract,
    source: "config_docker",
    diagnostics,
  };
}

export async function resolveAppRuntimeProfile(
  token: string,
  owner: string,
  repo: string,
  ref: string,
): Promise<AppRuntimeProfileResolution> {
  const diagnostics: AppRuntimeProfileDiagnostic[] = [];
  const configText = await getFileContent(token, owner, repo, ".cycloid.json", ref);

  let parsedConfig: CycloidRuntimeConfig | null = null;
  if (configText) {
    try {
      parsedConfig = JSON.parse(configText) as CycloidRuntimeConfig;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[repo-preview] Failed to parse .cycloid.json", {
        owner,
        repo,
        ref,
        error: String(error),
      });
      addDiagnostic(diagnostics, {
        code: "invalid_config_json",
        severity: "error",
        field: ".cycloid.json",
        message: `Failed to parse .cycloid.json App Runtime Profile: ${String(error)}`,
      });
      return { dockerEnabled: false, previewContract: null, source: "none", diagnostics };
    }
  }

  const configuredProfile = getConfiguredRuntimeProfile(parsedConfig);
  if (configuredProfile) {
    return resolveAppRuntimeProfileConfig(
      token,
      owner,
      repo,
      ref,
      configuredProfile.profile,
      configuredProfile.fieldPrefix,
    );
  }

  addDiagnostic(diagnostics, {
    code: "no_runtime_profile",
    severity: "info",
    message:
      'No App Runtime Profile is configured. Add .cycloid.json with appRuntime.kind "web", runner "docker", entry, url.hostPort, and ready.path to enable runtime verification.',
  });
  return { dockerEnabled: false, previewContract: null, source: "none", diagnostics };
}
