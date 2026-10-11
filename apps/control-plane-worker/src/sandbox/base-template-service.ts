import {
  type AgentRuntimeBackend,
  IMAGE_ADVERTISED_AGENT_RUNTIME_BACKENDS,
  isAgentRuntimeBackend,
  parseAgentRuntimeBackendCapabilities,
} from "../../../../shared/agent/agent-runtime-backend.js";
import { ENVIRONMENT } from "../../../../shared/constants/environment.js";
import { createLogger } from "../logger";
import type { Env } from "../types";
import { resolveRepoSandboxSpec } from "./repo-sandbox-specs";
import { E2B_CLOUD_RUNTIME_BACKEND, FREESTYLE_RUNTIME_BACKEND, type RuntimeBackend } from "./runtime-backend";

const log = createLogger({ bindings: { component: "sandbox-base-template-service" } });

export type SandboxBaseTemplateProvider = "e2b";
export type SandboxBaseTemplateSource = "registry" | "env_fallback";
export type SandboxBaseTemplateVersionQuality = "versioned" | "unversioned";
export type SandboxBaseTemplateRegisteredByKind = "admin" | "automation";

export interface SandboxBaseTemplateRow {
  id: string;
  provider: SandboxBaseTemplateProvider;
  runtime_backend: RuntimeBackend;
  resource_profile_key: string;
  base_template_ref: string;
  base_version: string;
  is_current: number;
  registered_by_kind: SandboxBaseTemplateRegisteredByKind;
  registered_by_user_id: number | null;
  github_actor: string | null;
  git_sha: string | null;
  workflow_run_url: string | null;
  smoke_status: string;
  capabilities: string | null;
  content_hash: string | null;
  created_at: number;
  superseded_at: number | null;
}

export interface ResolvedSandboxBaseTemplate {
  provider: SandboxBaseTemplateProvider;
  runtimeBackend: RuntimeBackend;
  resourceProfileKey: string;
  baseTemplateRef: string;
  baseVersion: string;
  source: SandboxBaseTemplateSource;
  versionQuality: SandboxBaseTemplateVersionQuality;
  /** Agent runtime backends this template image advertises (parsed from the capabilities column). */
  agentRuntimeBackends: AgentRuntimeBackend[];
}

export interface SandboxLayerArtifactBaseProvenance {
  artifactId: string;
  providerArtifactRef: string;
  resourceProfileKey: string;
  baseTemplateRef: string;
  baseVersion: string;
}

export interface RegisterSandboxBaseTemplatesInput {
  provider: unknown;
  runtimeBackend: unknown;
  bases: unknown;
  capabilities?: unknown;
  registeredByKind: SandboxBaseTemplateRegisteredByKind;
  registeredByUserId: number | null;
  nowMs: number;
}

export class SandboxBaseTemplateError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "invalid_provider"
      | "invalid_runtime_backend"
      | "invalid_resource_profile"
      | "invalid_base_template"
      | "invalid_base_version"
      | "invalid_content_hash"
      | "invalid_smoke_status"
      | "invalid_capabilities",
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "SandboxBaseTemplateError";
  }
}

type RegisterBase = {
  resourceProfileKey: string;
  baseTemplateRef: string;
  baseVersion: string;
  gitSha: string | null;
  workflowRunUrl: string | null;
  githubActor: string | null;
  contentHash: string | null;
  smokeStatus: "passed";
};

/**
 * Agent runtime backends that are part of the always-installed image baseline and therefore
 * do NOT require an explicit capability advertisement to spawn. Legacy registry rows (and prod
 * env fallbacks) predate the capabilities column, so gating these would break existing sessions.
 * Opencode is intentionally excluded: it is an opt-in backend that must be proven per template.
 */
const BASELINE_AGENT_RUNTIME_BACKENDS: ReadonlySet<AgentRuntimeBackend> = new Set(["codex", "claude_code"]);

/**
 * Freestyle snapshots have NO D1 registry: `sandbox_base_templates` (and its registration
 * path) are E2B-only -- `normalizeProvider`/`normalizeRuntimeBackend` reject anything but
 * `e2b`/`e2b_cloud`, so a freestyle-keyed registry lookup always misses and the E2B env
 * fallback advertises an empty set. A Freestyle-routed session instead boots the single fixed
 * snapshot named by `FREESTYLE_DEFAULT_SNAPSHOT_ID`, so the backends that snapshot advertises
 * are declared here, keyed by the EXACT snapshot id, and MUST stay in lockstep with both that
 * env var (`apps/control-plane-worker/wrangler.toml`) and what
 * `scripts/freestyle-build-base-snapshot.mjs` installs into that snapshot. A snapshot id absent
 * from this map advertises nothing, so any opt-in backend (opencode) fails closed against an
 * unproven snapshot -- the same fail-closed contract the E2B env-fallback branch enforces.
 * Baseline backends (codex/claude_code) are never gated, so an unmapped snapshot still runs them.
 */
const FREESTYLE_SNAPSHOT_ADVERTISED_AGENT_RUNTIME_BACKENDS: ReadonlyMap<string, readonly AgentRuntimeBackend[]> =
  new Map([
    // "base-2026-07-08": full-parity base snapshot (scripts/freestyle-build-base-snapshot.mjs):
    // installs and smokes codex, the version-locked claude_code bridge SDK, and the opencode
    // CLI/SDK; carries the #7150 start-bridge fix (boot-code git bypasses the agent policy
    // wrapper). Pinned as a literal — never aliased to IMAGE_ADVERTISED_AGENT_RUNTIME_BACKENDS —
    // because the snapshot is immutable: a backend added to the E2B image later must not be
    // advertised for a snapshot that was never rebuilt with it.
    ["sh-oqd4vrtk2araj4vj90io", ["codex", "claude_code", "opencode"]],
    // "cycloid-base-full-tf-fix": the PREVIOUS base (2026-07-06). Kept mapped while
    // sessions that booted from it are still in flight; remove together with the
    // snapshot itself once traffic has cycled onto base-2026-07-08.
    ["sh-n11sne1mmkhyj4rw83tk", ["codex", "claude_code", "opencode"]],
    // "cycloid-sha-ef3990c0": trycycloid/cycloid per-repo prebaked snapshot built from
    // base-2026-07-08 (scripts/freestyle-build-repo-snapshot.mjs; repo checkout +
    // node_modules baked, toolchain inherited unchanged — same advertised set).
    // Registered in FREESTYLE_REPO_SNAPSHOT_MAP_JSON (wrangler.toml). Rebuilds mint
    // a NEW id: update both the map var and this entry together.
    ["sh-uxeq4e8pjym6o7zp5khx", ["codex", "claude_code", "opencode"]],
  ]);

/**
 * Resolve the agent runtime backends advertised by the Freestyle snapshot the session will
 * actually boot: the per-repo prebaked snapshot when the spawn resolved one (`snapshotIdOverride`,
 * from FREESTYLE_REPO_SNAPSHOT_MAP_JSON), else `FREESTYLE_DEFAULT_SNAPSHOT_ID`. Returns an
 * empty advertised set for an unset or unmapped snapshot id so the caller fails closed on
 * opt-in backends.
 */
export function resolveFreestyleSnapshotAdvertisedAgentBackends(
  env: Env,
  snapshotIdOverride?: string | null,
): {
  snapshotId: string | null;
  agentRuntimeBackends: AgentRuntimeBackend[];
} {
  const snapshotId = snapshotIdOverride?.trim() || env.FREESTYLE_DEFAULT_SNAPSHOT_ID?.trim() || null;
  const advertised = snapshotId ? FREESTYLE_SNAPSHOT_ADVERTISED_AGENT_RUNTIME_BACKENDS.get(snapshotId) : undefined;
  return { snapshotId, agentRuntimeBackends: advertised ? [...advertised] : [] };
}

export class SandboxTemplateCapabilityError extends Error {
  constructor(
    readonly agentRuntimeBackend: AgentRuntimeBackend,
    readonly resourceProfileKey: string,
    message: string,
  ) {
    super(message);
    this.name = "SandboxTemplateCapabilityError";
  }
}

/**
 * Fail-closed spawn preflight: reject a session whose agent runtime backend is NOT advertised by
 * the active base template image. Only opt-in (non-baseline) backends are gated, so this never
 * blocks codex/claude_code. Template registration soft-fails on 404/5xx and the control plane can
 * fall back to env templates, so "build the template first" is not self-enforcing -- this is the
 * enforceable guard that keeps opencode from spawning against an image lacking the opencode CLI/SDK.
 */
export async function assertActiveTemplateSupportsAgentBackend(
  env: Env,
  input: {
    agentRuntimeBackend: AgentRuntimeBackend;
    resourceProfileKey: string | null;
    runtimeBackend?: RuntimeBackend;
    layerArtifactBase?: SandboxLayerArtifactBaseProvenance;
    // Freestyle per-repo prebaked snapshot selected by the spawn (overrides the default
    // snapshot as what actually boots). Callers re-run this gate with it because the
    // early spawn preflight fires before repo visibility/branch are resolved.
    freestyleSnapshotId?: string | null;
  },
): Promise<void> {
  if (BASELINE_AGENT_RUNTIME_BACKENDS.has(input.agentRuntimeBackend)) return;
  // Freestyle-routed sessions never resolve from the E2B `sandbox_base_templates` registry or a
  // layer artifact (layer resolution is `backend_unsupported` for non-e2b backends): they boot the
  // fixed snapshot named by FREESTYLE_DEFAULT_SNAPSHOT_ID. Validate the requested backend against
  // that snapshot's advertised set so opencode is proven against what actually boots, not rejected
  // by the E2B env-fallback's empty set. Branch first so a freestyle session can never fall through
  // to the E2B registry/layer paths.
  if (input.runtimeBackend === FREESTYLE_RUNTIME_BACKEND) {
    assertFreestyleSnapshotSupportsAgentBackend(env, {
      agentRuntimeBackend: input.agentRuntimeBackend,
      resourceProfileKey: input.resourceProfileKey ?? "default",
      snapshotIdOverride: input.freestyleSnapshotId ?? null,
    });
    return;
  }
  if (input.layerArtifactBase) {
    await assertLayerArtifactBaseSupportsAgentBackend(env, {
      agentRuntimeBackend: input.agentRuntimeBackend,
      runtimeBackend: input.runtimeBackend ?? E2B_CLOUD_RUNTIME_BACKEND,
      layerArtifactBase: input.layerArtifactBase,
    });
    return;
  }
  // A null profile key (e.g. business-less session) cannot resolve a registered template, so fall
  // back to the default profile; the resolution still fails closed if it advertises no opencode.
  const resourceProfileKey = input.resourceProfileKey ?? "default";
  const resolved = await resolveCurrentSandboxBaseTemplateForProfile(env, {
    runtimeBackend: input.runtimeBackend,
    resourceProfileKey,
  });
  if (resolved.agentRuntimeBackends.includes(input.agentRuntimeBackend)) return;
  log.warn(
    {
      event: "sandbox_template.capability_preflight_rejected",
      agentRuntimeBackend: input.agentRuntimeBackend,
      resourceProfileKey,
      runtimeBackend: resolved.runtimeBackend,
      baseTemplateRef: resolved.baseTemplateRef,
      baseVersion: resolved.baseVersion,
      source: resolved.source,
      advertisedBackends: resolved.agentRuntimeBackends,
    },
    "Sandbox spawn rejected: active template does not advertise the requested agent backend",
  );
  throw new SandboxTemplateCapabilityError(
    input.agentRuntimeBackend,
    resourceProfileKey,
    `Active sandbox template does not advertise the '${input.agentRuntimeBackend}' agent runtime backend ` +
      `(template ${resolved.baseTemplateRef}@${resolved.baseVersion}, source ${resolved.source}). ` +
      `Build and register a template that advertises '${input.agentRuntimeBackend}' before spawning.`,
  );
}

/**
 * Fail-closed Freestyle preflight: reject an opt-in backend the configured Freestyle base snapshot
 * does not advertise. An unset or unmapped `FREESTYLE_DEFAULT_SNAPSHOT_ID` advertises nothing, so
 * the spawn fails closed rather than booting a snapshot whose backends cannot be proven.
 */
function assertFreestyleSnapshotSupportsAgentBackend(
  env: Env,
  input: {
    agentRuntimeBackend: AgentRuntimeBackend;
    resourceProfileKey: string;
    snapshotIdOverride?: string | null;
  },
): void {
  const { snapshotId, agentRuntimeBackends } = resolveFreestyleSnapshotAdvertisedAgentBackends(
    env,
    input.snapshotIdOverride,
  );
  if (agentRuntimeBackends.includes(input.agentRuntimeBackend)) return;
  log.warn(
    {
      event: "sandbox_template.capability_preflight_rejected",
      agentRuntimeBackend: input.agentRuntimeBackend,
      resourceProfileKey: input.resourceProfileKey,
      runtimeBackend: FREESTYLE_RUNTIME_BACKEND,
      source: "freestyle_snapshot",
      baseTemplateRef: snapshotId,
      advertisedBackends: agentRuntimeBackends,
      rejectionCause: snapshotId ? "backend_not_advertised" : "missing_snapshot_id",
    },
    "Sandbox spawn rejected: active Freestyle snapshot does not advertise the requested agent backend",
  );
  throw new SandboxTemplateCapabilityError(
    input.agentRuntimeBackend,
    input.resourceProfileKey,
    snapshotId
      ? `Active Freestyle base snapshot ${snapshotId} does not advertise the '${input.agentRuntimeBackend}' ` +
          `agent runtime backend. Build and register a Freestyle snapshot that advertises ` +
          `'${input.agentRuntimeBackend}' before spawning.`
      : `FREESTYLE_DEFAULT_SNAPSHOT_ID is not configured, so the '${input.agentRuntimeBackend}' agent runtime ` +
          `backend cannot be proven for a Freestyle spawn.`,
  );
}

async function assertLayerArtifactBaseSupportsAgentBackend(
  env: Env,
  input: {
    agentRuntimeBackend: AgentRuntimeBackend;
    runtimeBackend: RuntimeBackend;
    layerArtifactBase: SandboxLayerArtifactBaseProvenance;
  },
): Promise<void> {
  const rows = await getSandboxBaseTemplatesByRef(env.DB, {
    runtimeBackend: input.runtimeBackend,
    resourceProfileKey: input.layerArtifactBase.resourceProfileKey,
    baseTemplateRef: input.layerArtifactBase.baseTemplateRef,
    baseVersion: input.layerArtifactBase.baseVersion,
  });
  const advertisedBackends = intersectAdvertisedAgentRuntimeBackends(rows);
  if (advertisedBackends.includes(input.agentRuntimeBackend)) return;

  const rejectionCause = rows.length === 0 ? "missing_historical_base_template" : "backend_not_advertised";
  log.warn(
    {
      event: "sandbox_template.capability_preflight_rejected",
      agentRuntimeBackend: input.agentRuntimeBackend,
      resourceProfileKey: input.layerArtifactBase.resourceProfileKey,
      runtimeBackend: input.runtimeBackend,
      source: "layer_artifact_base",
      sandboxLayerArtifactId: input.layerArtifactBase.artifactId ?? null,
      sandboxLayerArtifactRef: input.layerArtifactBase.providerArtifactRef ?? null,
      baseTemplateRef: input.layerArtifactBase.baseTemplateRef,
      baseVersion: input.layerArtifactBase.baseVersion,
      advertisedBackends,
      historicalBaseTemplateRowCount: rows.length,
      rejectionCause,
    },
    "Sandbox spawn rejected: selected layer artifact base does not advertise the requested agent backend",
  );
  throw new SandboxTemplateCapabilityError(
    input.agentRuntimeBackend,
    input.layerArtifactBase.resourceProfileKey,
    rows.length === 0
      ? `Selected sandbox layer artifact base ${input.layerArtifactBase.baseTemplateRef}@${input.layerArtifactBase.baseVersion} ` +
          `has no matching registered historical base template row for resource profile ` +
          `'${input.layerArtifactBase.resourceProfileKey}'. Build and register a template that advertises ` +
          `'${input.agentRuntimeBackend}' before spawning.`
      : `Selected sandbox layer artifact base ${input.layerArtifactBase.baseTemplateRef}@${input.layerArtifactBase.baseVersion} ` +
          `does not advertise the '${input.agentRuntimeBackend}' agent runtime backend. Rebuild the layer on a ` +
          `template that advertises '${input.agentRuntimeBackend}' before spawning.`,
  );
}

export async function resolveCurrentSandboxBaseTemplate(
  env: Env,
  input: {
    runtimeBackend: RuntimeBackend;
    resourceProfileKey: string;
    resourceProfile: { runtimeTemplateId: string };
  },
): Promise<ResolvedSandboxBaseTemplate> {
  const registryRow = await getCurrentSandboxBaseTemplate(env.DB, {
    runtimeBackend: input.runtimeBackend,
    resourceProfileKey: input.resourceProfileKey,
  });
  if (registryRow) {
    log.info(
      {
        provider: registryRow.provider,
        runtimeBackend: registryRow.runtime_backend,
        resourceProfileKey: registryRow.resource_profile_key,
        baseTemplateRef: registryRow.base_template_ref,
        baseVersion: registryRow.base_version,
        source: "registry",
      },
      "Sandbox base template resolved from registry",
    );
    return {
      provider: registryRow.provider,
      runtimeBackend: registryRow.runtime_backend,
      resourceProfileKey: registryRow.resource_profile_key,
      baseTemplateRef: registryRow.base_template_ref,
      baseVersion: registryRow.base_version,
      source: "registry",
      versionQuality: "versioned",
      agentRuntimeBackends: parseAgentRuntimeBackendCapabilities(registryRow.capabilities),
    };
  }

  const baseVersion = env.SANDBOX_IMAGE_VERSION?.trim() || env.SENTRY_RELEASE?.trim() || "unversioned";
  log.warn(
    {
      provider: "e2b",
      runtimeBackend: input.runtimeBackend,
      resourceProfileKey: input.resourceProfileKey,
      baseTemplateRef: input.resourceProfile.runtimeTemplateId,
      baseVersion,
      source: "env_fallback",
      versionQuality: baseVersion === "unversioned" ? "unversioned" : "versioned",
    },
    "Sandbox base template resolved from environment fallback",
  );
  return {
    provider: "e2b",
    runtimeBackend: input.runtimeBackend,
    resourceProfileKey: input.resourceProfileKey,
    baseTemplateRef: input.resourceProfile.runtimeTemplateId,
    baseVersion,
    source: "env_fallback",
    versionQuality: baseVersion === "unversioned" ? "unversioned" : "versioned",
    // Env fallback means the registry has no row, so prod/QA cannot prove the env template's
    // backends and must fail closed (empty). Local dev runs against the freshly built image,
    // which installs every backend, so trust the image's advertised set there.
    agentRuntimeBackends: env.WORKER_ENV === ENVIRONMENT.Local ? [...IMAGE_ADVERTISED_AGENT_RUNTIME_BACKENDS] : [],
  };
}

export async function resolveCurrentSandboxBaseTemplateForProfile(
  env: Env,
  input: { runtimeBackend?: RuntimeBackend; resourceProfileKey: string },
): Promise<ResolvedSandboxBaseTemplate> {
  const runtimeBackend = input.runtimeBackend ?? E2B_CLOUD_RUNTIME_BACKEND;
  const registryRow = await getCurrentSandboxBaseTemplate(env.DB, {
    runtimeBackend,
    resourceProfileKey: input.resourceProfileKey,
  });
  if (registryRow) {
    log.info(
      {
        provider: registryRow.provider,
        runtimeBackend: registryRow.runtime_backend,
        resourceProfileKey: registryRow.resource_profile_key,
        baseTemplateRef: registryRow.base_template_ref,
        baseVersion: registryRow.base_version,
        source: "registry",
      },
      "Sandbox base template resolved from registry",
    );
    return {
      provider: registryRow.provider,
      runtimeBackend: registryRow.runtime_backend,
      resourceProfileKey: registryRow.resource_profile_key,
      baseTemplateRef: registryRow.base_template_ref,
      baseVersion: registryRow.base_version,
      source: "registry",
      versionQuality: "versioned",
      agentRuntimeBackends: parseAgentRuntimeBackendCapabilities(registryRow.capabilities),
    };
  }
  const sizingRepo = input.resourceProfileKey.includes("/") ? input.resourceProfileKey.split("/") : null;
  const resourceProfile = sizingRepo
    ? resolveRepoSandboxSpec(env, sizingRepo[0]!, sizingRepo[1]!)
    : resolveRepoSandboxSpec(env, "default", "default");
  return resolveCurrentSandboxBaseTemplate(env, {
    runtimeBackend,
    resourceProfileKey: input.resourceProfileKey,
    resourceProfile,
  });
}

export async function getCurrentSandboxBaseTemplate(
  db: D1Database,
  input: { runtimeBackend: RuntimeBackend; resourceProfileKey: string },
): Promise<SandboxBaseTemplateRow | null> {
  return db
    .prepare(
      `SELECT *
       FROM sandbox_base_templates
       WHERE runtime_backend = ?
         AND resource_profile_key = ?
         AND is_current = 1
       LIMIT 1`,
    )
    .bind(input.runtimeBackend, input.resourceProfileKey)
    .first<SandboxBaseTemplateRow>();
}

export async function getSandboxBaseTemplatesByRef(
  db: D1Database,
  input: {
    runtimeBackend: RuntimeBackend;
    resourceProfileKey: string;
    baseTemplateRef: string;
    baseVersion: string;
  },
): Promise<SandboxBaseTemplateRow[]> {
  const result = await db
    .prepare(
      `SELECT *
       FROM sandbox_base_templates
       WHERE runtime_backend = ?
         AND resource_profile_key = ?
         AND base_template_ref = ?
         AND base_version = ?
       ORDER BY created_at DESC`,
    )
    .bind(input.runtimeBackend, input.resourceProfileKey, input.baseTemplateRef, input.baseVersion)
    .all<SandboxBaseTemplateRow>();
  return result.results ?? [];
}

export async function registerSandboxBaseTemplates(
  db: D1Database,
  input: RegisterSandboxBaseTemplatesInput,
): Promise<SandboxBaseTemplateRow[]> {
  const provider = normalizeProvider(input.provider);
  const runtimeBackend = normalizeRuntimeBackend(input.runtimeBackend);
  const bases = normalizeBases(input.bases);
  const capabilities = normalizeCapabilities(input.capabilities);
  const rows: SandboxBaseTemplateRow[] = [];
  for (const base of bases) {
    const row = await registerSandboxBaseTemplate(db, {
      id: crypto.randomUUID(),
      provider,
      runtimeBackend,
      base,
      capabilities,
      registeredByKind: input.registeredByKind,
      registeredByUserId: input.registeredByUserId,
      nowMs: input.nowMs,
    });
    log.info(
      {
        provider,
        runtimeBackend,
        resourceProfileKey: row.resource_profile_key,
        baseTemplateRef: row.base_template_ref,
        baseVersion: row.base_version,
        registeredByKind: row.registered_by_kind,
        registeredByUserId: row.registered_by_user_id,
        githubActor: row.github_actor,
        gitSha: row.git_sha,
        workflowRunUrl: row.workflow_run_url,
        smokeStatus: row.smoke_status,
        capabilities: row.capabilities,
        contentHash: row.content_hash,
      },
      "Sandbox base template registered",
    );
    rows.push(row);
  }
  return rows;
}

function intersectAdvertisedAgentRuntimeBackends(rows: SandboxBaseTemplateRow[]): AgentRuntimeBackend[] {
  if (rows.length === 0) return [];
  const [first, ...rest] = rows.map((row) => new Set(parseAgentRuntimeBackendCapabilities(row.capabilities)));
  return [...IMAGE_ADVERTISED_AGENT_RUNTIME_BACKENDS].filter(
    (backend) => first?.has(backend) && rest.every((capabilities) => capabilities.has(backend)),
  );
}

async function registerSandboxBaseTemplate(
  db: D1Database,
  input: {
    id: string;
    provider: SandboxBaseTemplateProvider;
    runtimeBackend: RuntimeBackend;
    base: RegisterBase;
    capabilities: AgentRuntimeBackend[];
    registeredByKind: SandboxBaseTemplateRegisteredByKind;
    registeredByUserId: number | null;
    nowMs: number;
  },
): Promise<SandboxBaseTemplateRow> {
  const supersedeCurrent = db
    .prepare(
      `UPDATE sandbox_base_templates
       SET is_current = 0, superseded_at = ?
       WHERE runtime_backend = ?
         AND resource_profile_key = ?
         AND is_current = 1`,
    )
    .bind(input.nowMs, input.runtimeBackend, input.base.resourceProfileKey);
  const insertReplacement = db
    .prepare(
      `INSERT INTO sandbox_base_templates (
         id, provider, runtime_backend, resource_profile_key, base_template_ref, base_version,
         is_current, registered_by_kind, registered_by_user_id, github_actor, git_sha,
         workflow_run_url, smoke_status, capabilities, content_hash, created_at, superseded_at
       )
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      input.id,
      input.provider,
      input.runtimeBackend,
      input.base.resourceProfileKey,
      input.base.baseTemplateRef,
      input.base.baseVersion,
      input.registeredByKind,
      input.registeredByUserId,
      input.base.githubActor,
      input.base.gitSha,
      input.base.workflowRunUrl,
      input.base.smokeStatus,
      JSON.stringify(input.capabilities),
      input.base.contentHash,
      input.nowMs,
    );
  await db.batch([supersedeCurrent, insertReplacement]);
  const row = await getCurrentSandboxBaseTemplate(db, {
    runtimeBackend: input.runtimeBackend,
    resourceProfileKey: input.base.resourceProfileKey,
  });
  if (!row || row.id !== input.id) {
    throw new SandboxBaseTemplateError("invalid_request", "Unable to register sandbox base template", 409);
  }
  return row;
}

function normalizeCapabilities(value: unknown): AgentRuntimeBackend[] {
  // Optional: omitting capabilities registers a template advertising no opt-in backends
  // (legacy/unknown image), which makes the opencode spawn preflight fail closed against it.
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new SandboxBaseTemplateError(
      "invalid_capabilities",
      "capabilities must be an array of agent runtime backends",
    );
  }
  const seen = new Set<AgentRuntimeBackend>();
  for (const entry of value) {
    if (!isAgentRuntimeBackend(entry)) {
      throw new SandboxBaseTemplateError(
        "invalid_capabilities",
        `capabilities contains an unknown backend: ${String(entry)}`,
      );
    }
    seen.add(entry);
  }
  return [...seen];
}

function normalizeProvider(value: unknown): SandboxBaseTemplateProvider {
  if (value !== "e2b") throw new SandboxBaseTemplateError("invalid_provider", "provider must be e2b");
  return value;
}

function normalizeRuntimeBackend(value: unknown): RuntimeBackend {
  if (value !== E2B_CLOUD_RUNTIME_BACKEND) {
    throw new SandboxBaseTemplateError("invalid_runtime_backend", "runtimeBackend must be e2b_cloud");
  }
  return value;
}

function normalizeBases(value: unknown): RegisterBase[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new SandboxBaseTemplateError("invalid_request", "bases must be a non-empty array");
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new SandboxBaseTemplateError("invalid_request", "base entry is invalid");
    }
    const record = item as Record<string, unknown>;
    const smokeStatus = readString(record.smokeStatus);
    if (smokeStatus !== "passed") {
      throw new SandboxBaseTemplateError("invalid_smoke_status", "smokeStatus must be passed");
    }
    return {
      resourceProfileKey: normalizeResourceProfileKey(record.resourceProfileKey),
      baseTemplateRef: normalizeSimpleString(record.baseTemplateRef, "invalid_base_template", "baseTemplateRef"),
      baseVersion: normalizeSimpleString(record.baseVersion, "invalid_base_version", "baseVersion"),
      gitSha: readOptionalString(record.gitSha),
      workflowRunUrl: readOptionalString(record.workflowRunUrl),
      githubActor: readOptionalString(record.githubActor),
      contentHash: normalizeOptionalContentHash(record.contentHash),
      smokeStatus,
    };
  });
}

function normalizeOptionalContentHash(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return normalizeSimpleString(value, "invalid_content_hash", "contentHash");
}

function normalizeResourceProfileKey(value: unknown): string {
  const normalized = readString(value)?.toLowerCase();
  if (!normalized || !/^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)?$/.test(normalized)) {
    throw new SandboxBaseTemplateError("invalid_resource_profile", "resourceProfileKey is invalid");
  }
  return normalized;
}

function normalizeSimpleString(
  value: unknown,
  code: ConstructorParameters<typeof SandboxBaseTemplateError>[0],
  label: string,
): string {
  const normalized = readString(value);
  if (!normalized || normalized.length > 300) {
    throw new SandboxBaseTemplateError(code, `${label} is invalid`);
  }
  return normalized;
}

function readOptionalString(value: unknown): string | null {
  const normalized = readString(value);
  return normalized ?? null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
