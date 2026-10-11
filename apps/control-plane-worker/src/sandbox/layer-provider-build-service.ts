import { stringifyError } from "../../../../shared/utils/errors.js";
import { createLogger } from "../logger";
import type { Env, SandboxLayerBuildQueueMessage } from "../types";
import { compileSandboxLayerSmokeCommand } from "./layer-compiler";
import {
  appendNextSandboxLayerBuildLogChunk,
  claimSandboxLayerProviderBuild,
  completeSandboxLayerBuild,
  createSandboxLayerArtifact,
  getActiveSandboxLayerArtifact,
  getNewestCompletedPromotableSandboxLayerArtifact,
  getSandboxLayerArtifactForBuild,
  getSandboxLayerBuild,
  markSandboxLayerBuildFailed,
  markSandboxLayerBuildQueued,
  markSandboxLayerBuildStatus,
  promoteSandboxLayerArtifact,
  recordSandboxLayerProviderBuildStart,
  recordSandboxLayerProviderPoll,
  recordSandboxLayerSmokeSandbox,
  rescheduleSandboxLayerBuild,
  type SandboxLayerArtifactRow,
  type SandboxLayerBuildDetailsRow,
} from "./layer-db";
import {
  getE2BSandboxLayerProviderAdapter,
  type ProviderLogEntry,
  type SandboxLayerProviderAdapter,
} from "./layer-e2b-provider";
import type { SandboxLayerInstruction } from "./layer-parser";
import {
  completeRebuildCampaignBuild,
  markRebuildCampaignItemBuildingForBuild,
  markRebuildCampaignItemFailedForBuild,
} from "./layer-rebuild-campaign-service";
import { resolveSandboxLayerResourceSizingByKey } from "./layer-resource-profile";
import type { SandboxLayerBuildRequestEnvelope } from "./layer-source-service";

const log = createLogger({ bindings: { component: "sandbox-layer-provider-build-service" } });

const PROVIDER_POLL_DELAY_SECONDS = 15;
const PROVIDER_POLL_ERROR_RETRY_LIMIT = 2;
const SMOKE_SANDBOX_TIMEOUT_MS = 30 * 60 * 1000;
const SMOKE_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_LOG_CHUNK_BYTES = 32 * 1024;

type SmokeCommandLogContext = { commandIndex: number; command: string };
type SmokeCommandLogResult = SmokeCommandLogContext & { exitCode: number; stdout: string; stderr: string };

export class SandboxLayerBuildQueueError extends Error {
  constructor(
    readonly code: "sandbox_layer_build_queue_unavailable" | "sandbox_layer_build_queue_send_failed",
    message: string,
  ) {
    super(message);
    this.name = "SandboxLayerBuildQueueError";
  }
}

let providerAdapterForTest: SandboxLayerProviderAdapter | null = null;

export function setSandboxLayerProviderAdapterForTest(adapter: SandboxLayerProviderAdapter | null): void {
  providerAdapterForTest = adapter;
}

export async function queueSandboxLayerBuildRequest(
  env: Env,
  buildRequest: SandboxLayerBuildRequestEnvelope,
): Promise<SandboxLayerBuildRequestEnvelope> {
  if (
    buildRequest.status === "completed" &&
    buildRequest.promotionEligibility === "default_branch_head" &&
    buildRequest.willPromote === 1
  ) {
    const activeTemplateRef = await ensureCompletedDefaultBranchBuildPromoted(env, buildRequest.id);
    return activeTemplateRef ? { ...buildRequest, activeTemplateRef } : buildRequest;
  }
  if (buildRequest.status !== "validated") return buildRequest;
  const queue = env.SANDBOX_LAYER_BUILD_QUEUE;
  if (!queue) {
    throw new SandboxLayerBuildQueueError(
      "sandbox_layer_build_queue_unavailable",
      "Sandbox layer build queue is not configured",
    );
  }
  try {
    await queue.send({ buildId: buildRequest.id, reason: "start", attempt: 0 });
  } catch (err) {
    throw new SandboxLayerBuildQueueError(
      "sandbox_layer_build_queue_send_failed",
      err instanceof Error ? err.message : "Unable to enqueue sandbox layer build",
    );
  }
  await markSandboxLayerBuildQueued(env.DB, { buildId: buildRequest.id, nowMs: Date.now() });
  const row = await getSandboxLayerBuild(env.DB, buildRequest.id);
  return { ...buildRequest, status: row?.status ?? "queued" };
}

export async function ensureCompletedDefaultBranchBuildPromoted(env: Env, buildId: string): Promise<string | null> {
  const build = await getSandboxLayerBuild(env.DB, buildId);
  if (
    !build ||
    build.status !== "completed" ||
    build.promotion_eligibility !== "default_branch_head" ||
    build.will_promote !== 1
  ) {
    return null;
  }
  let artifact = await getSandboxLayerArtifactForBuild(env.DB, build.id);
  const nowMs = Date.now();
  if (!artifact) {
    if (!build.provider_artifact_ref) {
      log.warn({ buildId: build.id }, "Completed sandbox layer build cannot be promoted without provider artifact ref");
      return null;
    }
    artifact = await createSandboxLayerArtifact(env.DB, {
      id: crypto.randomUUID(),
      sourceId: build.source_id,
      buildId: build.id,
      provider: build.provider,
      providerArtifactRef: build.provider_artifact_ref,
      runtimeBackend: build.runtime_backend,
      resourceProfileKey: build.resource_profile_key,
      status: "candidate",
      nowMs,
    });
    log.warn({ buildId: build.id, artifactId: artifact.id }, "Repaired missing sandbox layer artifact row");
  }

  const active = await getActiveSandboxLayerArtifact(env.DB, {
    sourceId: build.source_id,
    resourceProfileKey: build.resource_profile_key,
  });
  if (active?.id === artifact.id) return artifact.provider_artifact_ref;

  const result = await promoteSandboxLayerArtifact(env.DB, { buildId: build.id, artifactId: artifact.id, nowMs });
  if (result === "stale") {
    if (active) return active.provider_artifact_ref;
    const newestArtifact = await getNewestCompletedPromotableSandboxLayerArtifact(env.DB, {
      sourceId: artifact.source_id,
      resourceProfileKey: artifact.resource_profile_key,
      provider: artifact.provider,
    });
    if (!newestArtifact || newestArtifact.id === artifact.id) {
      log.warn({ buildId: build.id, artifactId: artifact.id, result }, "Sandbox layer artifact promotion skipped");
      return null;
    }
    const newestResult = await promoteSandboxLayerArtifact(env.DB, {
      buildId: newestArtifact.build_id,
      artifactId: newestArtifact.id,
      nowMs,
    });
    if (newestResult === "promoted") return newestArtifact.provider_artifact_ref;
    log.warn(
      {
        buildId: build.id,
        artifactId: artifact.id,
        result,
        newestBuildId: newestArtifact.build_id,
        newestArtifactId: newestArtifact.id,
        newestResult,
      },
      "Newest sandbox layer artifact promotion skipped",
    );
    return null;
  }
  if (result !== "promoted") {
    log.warn({ buildId: build.id, artifactId: artifact.id, result }, "Sandbox layer artifact promotion skipped");
    return null;
  }
  return artifact.provider_artifact_ref;
}

export async function handleSandboxLayerBuildQueue(
  batch: MessageBatch<SandboxLayerBuildQueueMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processSandboxLayerBuildMessage(env, message.body);
      message.ack();
    } catch (err) {
      log.error({ buildId: message.body.buildId, error: String(err) }, "Sandbox layer build queue message failed");
      message.retry();
    }
  }
}

export async function processSandboxLayerBuildMessage(env: Env, message: SandboxLayerBuildQueueMessage): Promise<void> {
  const build = await getSandboxLayerBuild(env.DB, message.buildId);
  if (!build || isTerminalStatus(build.status)) return;
  if (message.reason === "start") {
    await processStartMessage(env, build, message);
  } else if (message.reason === "poll") {
    await processPollMessage(env, build, message);
  } else {
    await processSmokeMessage(env, build, message);
  }
}

async function processStartMessage(
  env: Env,
  build: SandboxLayerBuildDetailsRow,
  message: SandboxLayerBuildQueueMessage,
): Promise<void> {
  if (build.status === "validated") {
    await markSandboxLayerBuildQueued(env.DB, { buildId: build.id, nowMs: Date.now() });
    build = (await getSandboxLayerBuild(env.DB, build.id)) ?? build;
  }
  if (build.provider_build_id && build.provider_template_ref) {
    if (build.status === "queued") {
      await markSandboxLayerBuildStatus(env.DB, build.id, "polling_provider", Date.now());
    }
    await enqueueBuildMessage(
      env,
      { buildId: build.id, reason: "poll", attempt: message.attempt },
      PROVIDER_POLL_DELAY_SECONDS,
    );
    return;
  }
  if (build.status !== "queued") return;
  const claimed = await claimSandboxLayerProviderBuild(env.DB, { buildId: build.id, nowMs: Date.now() });
  if (!claimed) return;
  const claimedBuild = (await getSandboxLayerBuild(env.DB, build.id)) ?? build;
  const adapter = getProviderAdapter();
  const resourceSizing = resolveSandboxLayerResourceSizingByKey({
    resourceProfileKey: claimedBuild.resource_profile_key,
  });
  try {
    const started = await adapter.startBuild({
      env,
      baseTemplateRef: claimedBuild.base_template_ref,
      generatedName: generatedTemplateName(claimedBuild),
      instructions: parseInstructions(claimedBuild),
      cpuCount: resourceSizing.cpuCount,
      memoryMB: resourceSizing.memoryMB,
      provenance: buildProvenance(claimedBuild),
      skipCache: shouldSkipLayerBuildCache(claimedBuild),
      logger: log,
    });
    await recordSandboxLayerProviderBuildStart(env.DB, {
      buildId: claimedBuild.id,
      providerTemplateRef: started.providerTemplateRef,
      providerBuildId: started.providerBuildId,
      nowMs: Date.now(),
    });
    await markRebuildCampaignItemBuildingForBuild(env.DB, claimedBuild.id);
    await appendLogChunk(env.DB, claimedBuild.id, "Provider build started.");
    await enqueueBuildMessage(
      env,
      { buildId: claimedBuild.id, reason: "poll", attempt: 0 },
      PROVIDER_POLL_DELAY_SECONDS,
    );
  } catch (err) {
    await failBuildAndCampaign(env, claimedBuild, classifyProviderError(err, "provider_build_start_failed"));
  }
}

async function processPollMessage(
  env: Env,
  build: SandboxLayerBuildDetailsRow,
  message: SandboxLayerBuildQueueMessage,
): Promise<void> {
  if (build.status === "queued" && build.provider_template_ref && build.provider_build_id) {
    await processStartMessage(env, build, { ...message, reason: "start" });
    return;
  }
  if (build.status !== "polling_provider") return;
  if (!build.provider_template_ref || !build.provider_build_id) {
    await failBuildAndCampaign(env, build, "provider_build_missing");
    return;
  }
  let status: Awaited<ReturnType<SandboxLayerProviderAdapter["getBuildStatus"]>>;
  try {
    status = await getProviderAdapter().getBuildStatus({
      env,
      providerTemplateRef: build.provider_template_ref,
      providerBuildId: build.provider_build_id,
      logsOffset: build.provider_logs_offset,
    });
  } catch (err) {
    await handleProviderPollError(env, build, message, err);
    return;
  }
  if (status.logEntries.length > 0) {
    await appendLogChunk(env.DB, build.id, JSON.stringify({ provider: status.logEntries.map(redactProviderLogEntry) }));
  }
  await recordSandboxLayerProviderPoll(env.DB, {
    buildId: build.id,
    providerLogsOffset: status.nextLogsOffset,
    nowMs: Date.now(),
  });
  if (status.status === "building") {
    await enqueueBuildMessage(
      env,
      { buildId: build.id, reason: "poll", attempt: message.attempt + 1 },
      PROVIDER_POLL_DELAY_SECONDS,
    );
    return;
  }
  if (status.status === "error") {
    await failBuildAndCampaign(env, build, `provider_build_failed:${status.error ?? "unknown"}`);
    return;
  }
  await markSandboxLayerBuildStatus(env.DB, build.id, "smoke_testing", Date.now());
  await enqueueBuildMessage(env, { buildId: build.id, reason: "smoke", attempt: 0 });
}

async function handleProviderPollError(
  env: Env,
  build: SandboxLayerBuildDetailsRow,
  message: SandboxLayerBuildQueueMessage,
  err: unknown,
): Promise<void> {
  const error = classifyProviderError(err, "provider_build_poll_failed");
  const retryable = isRetryableProviderPollError(error);
  if (retryable && build.attempts < PROVIDER_POLL_ERROR_RETRY_LIMIT) {
    const retryNumber = build.attempts + 1;
    await appendLogChunk(
      env.DB,
      build.id,
      JSON.stringify({
        providerPollError: {
          error,
          retryable,
          retryNumber,
          retryLimit: PROVIDER_POLL_ERROR_RETRY_LIMIT,
        },
      }),
    );
    const nextAttemptAt = Date.now() + PROVIDER_POLL_DELAY_SECONDS * 1000;
    const rescheduled = await rescheduleSandboxLayerBuild(env.DB, {
      buildId: build.id,
      nextAttemptAt,
    });
    if (!rescheduled) return;
    await enqueueBuildMessage(
      env,
      { buildId: build.id, reason: "start", attempt: message.attempt },
      PROVIDER_POLL_DELAY_SECONDS,
    );
    log.warn(
      { buildId: build.id, error, retryNumber, retryLimit: PROVIDER_POLL_ERROR_RETRY_LIMIT },
      "Sandbox layer provider poll failed; retrying",
    );
    return;
  }
  await appendLogChunk(
    env.DB,
    build.id,
    JSON.stringify({
      providerPollError: {
        error,
        retryable,
        ...(retryable ? { exhausted: true, retryLimit: PROVIDER_POLL_ERROR_RETRY_LIMIT } : {}),
      },
    }),
  );
  await failBuildAndCampaign(env, build, error);
  log.warn({ buildId: build.id, error }, "Sandbox layer provider poll failed");
}

async function processSmokeMessage(
  env: Env,
  build: SandboxLayerBuildDetailsRow,
  _message: SandboxLayerBuildQueueMessage,
): Promise<void> {
  if (build.status !== "smoke_testing") return;
  if (!build.provider_template_ref) {
    await failBuildAndCampaign(env, build, "provider_template_missing");
    return;
  }
  const adapter = getProviderAdapter();
  let smokeSandboxId: string | null = null;
  const results: SmokeCommandLogResult[] = [];
  let smokeResultJson: string | null = null;
  try {
    let created: { sandboxId: string };
    try {
      created = await adapter.createSmokeSandbox({
        env,
        providerTemplateRef: build.provider_template_ref,
        buildId: build.id,
        sourceId: build.source_id,
        timeoutMs: SMOKE_SANDBOX_TIMEOUT_MS,
      });
    } catch (err) {
      await failSmokeRuntime(env, build, smokeSandboxId, results, err);
      return;
    }
    smokeSandboxId = created.sandboxId;
    await recordSandboxLayerSmokeSandbox(env.DB, { buildId: build.id, smokeSandboxId, nowMs: Date.now() });

    for (const [commandIndex, command] of runtimeSmokeCommands(build).entries()) {
      const commandContext = smokeCommandLogContext(command, commandIndex);
      let result: { exitCode: number; stdout: string; stderr: string };
      try {
        result = await adapter.runSmokeCommand({
          env,
          sandboxId: smokeSandboxId,
          command,
          timeoutMs: SMOKE_COMMAND_TIMEOUT_MS,
        });
      } catch (err) {
        await failSmokeRuntime(env, build, smokeSandboxId, results, err, commandContext);
        return;
      }
      results.push({ ...commandContext, ...boundedCommandResult(result) });
      await appendLogChunk(env.DB, build.id, JSON.stringify({ smoke: results.at(-1) }));
      if (result.exitCode !== 0) {
        await failBuildAndCampaign(env, build, "smoke_command_failed", JSON.stringify({ ok: false, results }));
        return;
      }
    }
    smokeResultJson = JSON.stringify({ ok: true, results });
  } finally {
    if (smokeSandboxId) {
      try {
        await adapter.terminateSmokeSandbox({ env, sandboxId: smokeSandboxId });
      } catch (err) {
        log.error({ buildId: build.id, error: String(err) }, "Sandbox layer smoke cleanup failed");
      }
    }
  }
  if (!smokeResultJson) throw new Error("smoke_result_missing");
  await completePassedSmokeBuild(env, build, smokeResultJson, Date.now());
}

async function failSmokeRuntime(
  env: Env,
  build: SandboxLayerBuildDetailsRow,
  smokeSandboxId: string | null,
  results: SmokeCommandLogResult[],
  err: unknown,
  commandContext?: SmokeCommandLogContext,
): Promise<void> {
  const errorMessage = redactKnownSecrets(stringifyError(err));
  await appendLogChunk(
    env.DB,
    build.id,
    JSON.stringify({
      smoke: {
        error: "smoke_runtime_error",
        message: errorMessage,
        sandboxId: smokeSandboxId,
        ...commandContext,
      },
    }),
  );
  await failBuildAndCampaign(
    env,
    build,
    `smoke_runtime_error:${errorMessage}`,
    JSON.stringify({
      ok: false,
      error: "smoke_runtime_error",
      message: errorMessage,
      ...commandContext,
      results,
    }),
  );
  log.warn(
    { buildId: build.id, smokeSandboxId, error: errorMessage, ...commandContext },
    "Sandbox layer smoke runtime failed",
  );
}

async function completePassedSmokeBuild(
  env: Env,
  build: SandboxLayerBuildDetailsRow,
  smokeResultJson: string,
  nowMs: number,
): Promise<SandboxLayerArtifactRow> {
  const providerArtifactRef = build.provider_template_ref;
  if (!providerArtifactRef) throw new Error("provider_template_missing");
  const artifact = await completeSandboxLayerBuild(env.DB, build, providerArtifactRef, smokeResultJson, nowMs);
  const rebuildResult = await completeRebuildCampaignBuild(env.DB, build.id, artifact.id, nowMs);
  if (rebuildResult !== "promoted" && build.promotion_eligibility === "default_branch_head") {
    await ensureCompletedDefaultBranchBuildPromoted(env, build.id);
  }
  return artifact;
}

async function failBuildAndCampaign(
  env: Env,
  build: Pick<SandboxLayerBuildDetailsRow, "id">,
  error: string,
  smokeResultJson: string | null = null,
): Promise<void> {
  await markSandboxLayerBuildFailed(env.DB, {
    buildId: build.id,
    error,
    smokeResultJson,
    nowMs: Date.now(),
  });
  await markRebuildCampaignItemFailedForBuild(env.DB, build.id, error);
}

async function enqueueBuildMessage(
  env: Env,
  message: SandboxLayerBuildQueueMessage,
  delaySeconds?: number,
): Promise<void> {
  const queue = env.SANDBOX_LAYER_BUILD_QUEUE;
  if (!queue) throw new Error("sandbox_layer_build_queue_unavailable");
  await queue.send(message, delaySeconds ? { delaySeconds } : undefined);
}

function runtimeSmokeCommands(build: SandboxLayerBuildDetailsRow): string[] {
  const smokeCommands = JSON.parse(build.smoke_commands_json) as string[][];
  return [
    "test -x /app/start-bridge.sh",
    "test -r /etc/cycloid/layer-env.sh",
    "bash -lc '. /etc/cycloid/layer-env.sh && test \"${ARCANIST_SANDBOX_LAYER_ENV:-}\" = 1'",
    ...smokeCommands.map(compileSandboxLayerSmokeCommand),
  ];
}

function smokeCommandLogContext(command: string, commandIndex: number): SmokeCommandLogContext {
  return { commandIndex, command: redactCommandForLog(command) };
}

function parseInstructions(build: SandboxLayerBuildDetailsRow): SandboxLayerInstruction[] {
  return JSON.parse(build.layer_instructions_json) as SandboxLayerInstruction[];
}

// Decide whether to bypass E2B's cached `FROM TEMPLATE` base pull for a layer
// build. E2B keys that cache on the base template alias, NOT on the base image
// behind it, so a rebuild that reuses the cache silently bakes the OLD base even
// after the base template was redeployed.
//
// - `base_update`: campaign rebuild whose entire purpose is to move the layer
//   onto a changed base. It MUST bust the cache; otherwise it re-bakes the stale
//   base and records the layer as current-but-stale (the base-propagation
//   clobber this fixes).
// - `manual`: explicit CLI/API ops or recovery build. Infrequent and deliberate,
//   so correctness (true current base) beats cache speed.
// - `source_update` (and null): reserved for base-unchanged repo-commit rebuilds;
//   keep the cache-fast base pull since the base template did not change.
//
// This deliberately does NOT compare prior builds' base_version. That signal
// raced with concurrent rebuild-campaign items — a fresh build could complete
// first, making the next base_update rebuild see previous == current and skip the
// cache bust — which is exactly how stale layers got recorded as current.
function shouldSkipLayerBuildCache(build: SandboxLayerBuildDetailsRow): boolean {
  return build.build_reason === "base_update" || build.build_reason === "manual";
}

function buildProvenance(build: SandboxLayerBuildDetailsRow): Record<string, string> {
  return {
    build_id: build.id,
    source_id: build.source_id,
    business_id: build.business_id,
    repo_owner: build.repo_owner,
    repo_name: build.repo_name,
    commit_sha: build.commit_sha,
    compiler_version: build.compiler_version,
  };
}

function generatedTemplateName(build: SandboxLayerBuildDetailsRow): string {
  const business = build.business_id.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 12) || "biz";
  const source = build.source_id.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 10) || "source";
  const hash = build.normalized_layer_hash.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "hash";
  const base = build.base_version.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 16) || "base";
  const profile = build.resource_profile_key.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 16) || "default";
  return `cycloid-layer-${business}-${source}-${hash}-${base}-${profile}`.toLowerCase().slice(0, 96);
}

async function appendLogChunk(db: D1Database, buildId: string, message: string): Promise<void> {
  await appendNextSandboxLayerBuildLogChunk(db, {
    id: crypto.randomUUID(),
    buildId,
    message: boundLogMessage(redactKnownSecrets(message)),
    nowMs: Date.now(),
  });
}

function getProviderAdapter(): SandboxLayerProviderAdapter {
  return providerAdapterForTest ?? getE2BSandboxLayerProviderAdapter();
}

function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

function classifyProviderError(err: unknown, fallback: string): string {
  const message = stringifyError(err);
  if (message.startsWith("provider_config_missing:")) return "provider_config_missing";
  if (/auth|unauthorized|forbidden/i.test(message)) return "provider_auth_failed";
  if (/rate.?limit/i.test(message)) return "provider_rate_limited";
  if (/network|fetch|timeout/i.test(message)) return "provider_network_error";
  return `${fallback}:${message.slice(0, 256)}`;
}

function isRetryableProviderPollError(error: string): boolean {
  return error === "provider_network_error" || error === "provider_rate_limited";
}

function redactProviderLogEntry(entry: ProviderLogEntry): ProviderLogEntry {
  return { ...entry, message: redactKnownSecrets(entry.message) };
}

function boundedCommandResult(result: { exitCode: number; stdout: string; stderr: string }): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  return {
    exitCode: result.exitCode,
    stdout: boundLogMessage(redactKnownSecrets(result.stdout)),
    stderr: boundLogMessage(redactKnownSecrets(result.stderr)),
  };
}

function boundLogMessage(message: string): string {
  const encoded = new TextEncoder().encode(message);
  if (encoded.byteLength <= MAX_LOG_CHUNK_BYTES) return message;
  const head = message.slice(0, MAX_LOG_CHUNK_BYTES);
  return `${head}\n[truncated]`;
}

function redactKnownSecrets(value: string): string {
  return value
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[redacted]")
    .replace(/(?:sk-|e2b_)[A-Za-z0-9_-]{20,}/g, "[redacted]");
}

function redactCommandForLog(command: string): string {
  if (command === "test -x /app/start-bridge.sh") return command;
  if (command === "test -r /etc/cycloid/layer-env.sh") return command;
  if (command.includes("ARCANIST_SANDBOX_LAYER_ENV")) return "verify layer env hook";
  return "user smoke command";
}
