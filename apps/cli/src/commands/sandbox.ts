import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Command } from "commander";

import { parseGithubRepoFullName } from "../../../../shared/github/repo-url.js";
import {
  parseSandboxLayerManifest,
  parseSandboxLayerSource,
  SANDBOX_LAYER_MANIFEST_PATH,
  SandboxLayerValidationError,
} from "../../../../shared/sandbox-layer/parser.js";
import { sleep } from "../../../../shared/utils/timing.js";
import { apiFetch, resolveBusinessId } from "../api.js";
import { type CliConfig } from "../config.js";
import { ApiError, CliError } from "../errors.js";
import { currentRepo, git, type RepoRef } from "../git.js";
import {
  confirmOrThrow,
  emit,
  getRuntimeOptions,
  isJson,
  randomIdempotencyKey,
  resolveBusinessContext,
  type RuntimeOptions,
  writeJson,
} from "../runtime.js";

const DEFAULT_MANIFEST_PATH = SANDBOX_LAYER_MANIFEST_PATH;
const DEFAULT_POLL_INTERVAL_MS = 2500;
const MIN_POLL_INTERVAL_MS = 250;
const TERMINAL_BUILD_STATUSES = new Set(["completed", "failed", "canceled"]);

type SandboxCommandOptions = RuntimeOptions & { business?: string };

type BuildRequestEnvelope = {
  id: string;
  status: string;
  sourceRepo?: string;
  targetRepo?: string;
  requestedRef?: string;
  commitSha?: string;
  manifestPath?: string;
  layerPath?: string;
  sourceContentHash?: string;
  resourceProfileKey?: string;
  promotionEligibility?: string;
  providerArtifactRef?: string | null;
  activeTemplateRef?: string | null;
  baseTemplateRef?: string;
  baseVersion?: string;
  baseSource?: "registry" | "env_fallback";
  baseVersionQuality?: "versioned" | "unversioned";
  createdBy?: SandboxLayerBuildActor | null;
  failureSummary?: SandboxLayerFailureSummary | null;
};

type BuildRequestResponse = {
  ok: boolean;
  buildRequest: BuildRequestEnvelope;
};

type SandboxLayerBuildActor = {
  userId: number;
  login: string | null;
  name: string | null;
};

type BuildHistoryItem = {
  id: string;
  status: string;
  sourceRepo: string;
  commitSha: string;
  resourceProfileKey: string;
  templateId: string | null;
  baseTemplateRef: string;
  baseVersion: string;
  baseSource: "registry" | "env_fallback";
  baseVersionQuality: "versioned" | "unversioned";
  createdBy: SandboxLayerBuildActor;
  createdAt: number;
  completedAt: number | null;
  smokeStatus: "passed" | "failed" | null;
  failureSummary?: SandboxLayerFailureSummary | null;
};

type BuildHistoryResponse = {
  ok: boolean;
  builds: BuildHistoryItem[];
};

type SandboxLayerSelectionDetails = {
  tier: "repo_local" | "repo_assignment" | "business_default";
  sourceRepo: string;
  buildId: string;
  templateId: string;
  commitSha: string;
  resourceProfileKey: string;
  baseTemplateRef: string;
  baseVersion: string;
  currentBaseVersion: string | null;
  baseSource: "registry" | "env_fallback";
  baseVersionQuality: "versioned" | "unversioned";
  baseStatus: "active" | "outdated";
  createdBy: SandboxLayerBuildActor;
};

type SandboxLayerLatestBuild = {
  id: string;
  status: string;
  commitSha: string;
  templateId: string | null;
  resourceProfileKey: string;
  baseTemplateRef: string;
  baseVersion: string;
  createdBy: SandboxLayerBuildActor;
};

type SandboxStatusResponse = {
  repo?: string;
  resourceProfileKey?: string | null;
  selection?: SandboxLayerSelectionDetails | null;
  latestRepoBuild?: SandboxLayerLatestBuild | null;
  fallback?: { reason: string; templateId: string | null } | null;
};

type RebuildCampaignResponse = {
  ok: boolean;
  campaign: {
    id: string;
    status: string;
    summary: {
      activeArtifactsScanned: number;
      staleArtifactsFound: number;
      currentArtifactsSkipped: number;
      missingInstallationSkips: number;
      sourceUnavailableSkips: number;
      unversionedBaseSkips: number;
      activeChangedSkips: number;
      failedItems: number;
      promotedItems: number;
      buildsQueued: number;
    };
  };
};

type SandboxLayerFailureSummary = {
  phase: "validation" | "provider_build" | "smoke" | "runtime" | "unknown";
  reason: string;
  command?: string;
  commandIndex?: number;
  exitCode?: number;
  stdoutPreview?: string;
  stderrPreview?: string;
  activeTemplateUnchanged: boolean;
};

type BuildLog = {
  sequence: number;
  message: string;
  created_at?: string;
};

type BuildLogsResponse = {
  ok: boolean;
  logs: BuildLog[];
};

function currentRef(): string {
  return git(["rev-parse", "--abbrev-ref", "HEAD"]);
}

function assertCleanAndPushed(): void {
  const dirty = git(["status", "--porcelain"]);
  if (dirty) throw new CliError("user", "Sandbox layer source must be committed before build.");
  const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const ahead = git(["rev-list", "--count", `${upstream}..HEAD`]);
  if (ahead !== "0")
    throw new CliError("user", "Current commit is not pushed; push before building the sandbox layer.");
}

function assertManifestExists(path: string): void {
  if (!existsSync(path)) throw new CliError("user", `Missing sandbox manifest: ${path}`);
}

function parseRepoArg(value: string | undefined, fallback: () => RepoRef): RepoRef {
  if (!value) return fallback();
  const parsed = parseGithubRepoFullName(value);
  if (!parsed) throw new CliError("user", "repo must be owner/name or a GitHub URL");
  return { owner: parsed.owner, repo: parsed.repo };
}

function repoPath(repo: RepoRef): string {
  return `${repo.owner}/${repo.repo}`;
}

function parsePollInterval(value: string | undefined): number {
  if (!value) return DEFAULT_POLL_INTERVAL_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_POLL_INTERVAL_MS) {
    throw new CliError("user", `--poll-interval must be an integer >= ${MIN_POLL_INTERVAL_MS}.`);
  }
  return parsed;
}

function printBuildRequest(buildRequest: BuildRequestEnvelope): void {
  console.log(
    [
      `Build ${buildRequest.id} is ${buildRequest.status}.`,
      buildRequest.sourceRepo ? `source=${buildRequest.sourceRepo}` : null,
      buildRequest.targetRepo ? `target=${buildRequest.targetRepo}` : null,
      buildRequest.commitSha ? `commit=${buildRequest.commitSha}` : null,
      buildRequest.resourceProfileKey ? `profile=${buildRequest.resourceProfileKey}` : null,
      buildRequest.createdBy ? `builtBy=${buildActorLabel(buildRequest.createdBy)}` : null,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function buildActorLabel(actor: SandboxLayerBuildActor | null | undefined): string {
  if (!actor) return "unknown";
  if (actor.login) return `@${actor.login}`;
  if (actor.name) return actor.name;
  return `User ${actor.userId}`;
}

function phaseLabel(phase: SandboxLayerFailureSummary["phase"]): string {
  return phase === "provider_build" ? "provider build" : phase;
}

function printActiveTemplateStatus(buildRequest: BuildRequestEnvelope): void {
  if (buildRequest.status === "completed") {
    if (buildRequest.providerArtifactRef && buildRequest.activeTemplateRef === buildRequest.providerArtifactRef) {
      console.log(`Active template updated to ${buildRequest.providerArtifactRef}.`);
      return;
    }
    if (buildRequest.activeTemplateRef) {
      console.log(`Build completed; active template remains ${buildRequest.activeTemplateRef}.`);
      return;
    }
    console.log("Build completed but is not active; sessions will use the previous sandbox or Cycloid default.");
    return;
  }
  if (buildRequest.activeTemplateRef) {
    console.log("Active template unchanged; previous successful sandbox remains active.");
  } else {
    console.log("No previous active sandbox; sessions will use Cycloid default.");
  }
}

function printTerminalBuildSummary(buildRequest: BuildRequestEnvelope): void {
  if (buildRequest.status === "completed") {
    console.log("Sandbox build completed.");
    if (buildRequest.sourceRepo) console.log(`Source: ${buildRequest.sourceRepo}`);
    if (buildRequest.commitSha) console.log(`Commit: ${buildRequest.commitSha}`);
    if (buildRequest.baseTemplateRef && buildRequest.baseVersion) {
      console.log(`Built from: ${buildRequest.baseTemplateRef} @ ${buildRequest.baseVersion}`);
    }
    if (buildRequest.createdBy) console.log(`Built by: ${buildActorLabel(buildRequest.createdBy)}`);
    const template = buildRequest.providerArtifactRef ?? buildRequest.activeTemplateRef;
    if (template) console.log(`Template: ${template}`);
    console.log("Smoke: passed");
    printActiveTemplateStatus(buildRequest);
    return;
  }

  const failure = buildRequest.failureSummary;
  const phase = failure ? phaseLabel(failure.phase) : buildRequest.status;
  console.log(`Sandbox build failed during ${phase}.`);
  if (buildRequest.createdBy) console.log(`Built by: ${buildActorLabel(buildRequest.createdBy)}`);
  if (failure?.command) console.log(`Command: ${failure.command}`);
  if (failure?.exitCode !== undefined) console.log(`Exit code: ${failure.exitCode}`);
  console.log(`Reason: ${failure?.reason ?? `Build finished with status ${buildRequest.status}`}`);
  if (failure?.stdoutPreview) console.log(`Stdout: ${failure.stdoutPreview}`);
  if (failure?.stderrPreview) console.log(`Stderr: ${failure.stderrPreview}`);
  printActiveTemplateStatus(buildRequest);
}

function printBuildHistory(builds: BuildHistoryItem[]): void {
  if (builds.length === 0) {
    console.log("No sandbox builds found.");
    return;
  }
  for (const build of builds) {
    console.log(
      [
        `Build ${build.id} is ${build.status}.`,
        `source=${build.sourceRepo}`,
        `commit=${build.commitSha}`,
        `profile=${build.resourceProfileKey}`,
        build.templateId ? `template=${build.templateId}` : null,
        `base=${build.baseTemplateRef}@${build.baseVersion}`,
        `builtBy=${buildActorLabel(build.createdBy)}`,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
}

function selectionTierLabel(tier: SandboxLayerSelectionDetails["tier"]): string {
  if (tier === "repo_local") return "repo-local";
  if (tier === "repo_assignment") return "assigned";
  return "workspace default";
}

function printSandboxStatus(payload: SandboxStatusResponse): void {
  if (payload.selection) {
    console.log(`Using ${selectionTierLabel(payload.selection.tier)} sandbox.`);
    console.log(`Template: ${payload.selection.templateId}`);
    console.log(`Source: ${payload.selection.sourceRepo}`);
    console.log(`Commit: ${payload.selection.commitSha}`);
    console.log(`Profile: ${payload.selection.resourceProfileKey}`);
    console.log(`Built from: ${payload.selection.baseTemplateRef} @ ${payload.selection.baseVersion}`);
    console.log(`Base status: ${payload.selection.baseStatus}`);
    console.log(`Built by: ${buildActorLabel(payload.selection.createdBy)}`);
    return;
  }
  console.log("Using Cycloid default sandbox.");
  if (payload.fallback?.templateId) console.log(`Template: ${payload.fallback.templateId}`);
  if (payload.latestRepoBuild) {
    console.log(`Latest custom build: ${payload.latestRepoBuild.status}`);
    console.log(`Commit: ${payload.latestRepoBuild.commitSha}`);
    console.log(`Profile: ${payload.latestRepoBuild.resourceProfileKey}`);
    console.log(`Built from: ${payload.latestRepoBuild.baseTemplateRef} @ ${payload.latestRepoBuild.baseVersion}`);
    console.log(`Built by: ${buildActorLabel(payload.latestRepoBuild.createdBy)}`);
  }
}

function printLogs(logs: BuildLog[]): void {
  for (const log of logs) {
    console.log(log.message);
  }
}

function buildLogsPath(
  businessId: string,
  buildId: string,
  options: { afterSequence?: number; limit?: number } = {},
): string {
  const params = new URLSearchParams();
  if (options.afterSequence != null) params.set("afterSequence", String(options.afterSequence));
  if (options.limit != null) params.set("limit", String(options.limit));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return `/api/businesses/${encodeURIComponent(businessId)}/sandbox-layer/build-requests/${encodeURIComponent(
    buildId,
  )}/logs${suffix}`;
}

async function fetchAndEmitBuildLogs(
  config: CliConfig,
  businessId: string,
  buildId: string,
  options: { afterSequence?: number; limit?: number; json?: boolean },
): Promise<{ afterSequence: number | undefined; count: number }> {
  const logs = await apiFetch<BuildLogsResponse>(
    config,
    buildLogsPath(businessId, buildId, { afterSequence: options.afterSequence, limit: options.limit }),
  );
  if (logs.logs.length === 0) return { afterSequence: options.afterSequence, count: 0 };
  if (options.json) writeJson({ type: "logs", logs: logs.logs });
  else printLogs(logs.logs);
  return { afterSequence: logs.logs[logs.logs.length - 1]!.sequence, count: logs.logs.length };
}

async function drainTerminalBuildLogs(
  config: CliConfig,
  businessId: string,
  buildId: string,
  options: { afterSequence?: number; json?: boolean },
): Promise<void> {
  let afterSequence = options.afterSequence;
  for (;;) {
    const result = await fetchAndEmitBuildLogs(config, businessId, buildId, {
      afterSequence,
      limit: 500,
      json: options.json,
    });
    afterSequence = result.afterSequence;
    if (result.count === 0) return;
  }
}

async function waitForBuild(
  config: CliConfig,
  businessId: string,
  buildId: string,
  options: { follow?: boolean; pollIntervalMs: number; json?: boolean },
): Promise<BuildRequestEnvelope> {
  let afterSequence: number | undefined;
  for (;;) {
    if (options.follow) {
      const result = await fetchAndEmitBuildLogs(config, businessId, buildId, { afterSequence, json: options.json });
      afterSequence = result.afterSequence;
    }

    const status = await apiFetch<BuildRequestResponse>(
      config,
      `/api/businesses/${encodeURIComponent(businessId)}/sandbox-layer/build-requests/${encodeURIComponent(buildId)}`,
    );
    if (TERMINAL_BUILD_STATUSES.has(status.buildRequest.status)) {
      if (options.follow) {
        await drainTerminalBuildLogs(config, businessId, buildId, { afterSequence, json: options.json });
      }
      return status.buildRequest;
    }
    await sleep(options.pollIntervalMs);
  }
}

function formatValidationPayload(input: {
  manifestPath: string;
  layerPath: string;
  parsed: Awaited<ReturnType<typeof parseSandboxLayerSource>>;
}) {
  return {
    ok: true,
    manifestPath: input.manifestPath,
    layerPath: input.layerPath,
    normalizedSourceHash: input.parsed.hashes.normalizedSourceHash,
    instructionCount: input.parsed.layer.instructions.length,
    smokeCommandCount: input.parsed.manifest.smokeCommands.length,
    diagnostics: [],
  };
}

function nextBuildCommand(manifestPath: string): string {
  try {
    const repo = currentRepo();
    const manifestArg = manifestPath === DEFAULT_MANIFEST_PATH ? "" : ` --manifest ${manifestPath}`;
    return `cycloid sandbox build ${repoPath(repo)} --wait --follow${manifestArg}`;
  } catch {
    return "configure a GitHub origin, then run cycloid sandbox build <owner/repo> --wait --follow";
  }
}

function handleValidationError(err: unknown, options: { json?: boolean }, command?: Command): void {
  if (err instanceof SandboxLayerValidationError) {
    const payload = { ok: false, diagnostics: err.issues };
    if (isJson(command, options)) {
      writeJson(payload);
      process.exitCode = 1;
      return;
    }
    throw new CliError(
      "user",
      err.issues.map((issue) => `${issue.path}${issue.line ? `:${issue.line}` : ""}: ${issue.message}`).join("\n"),
    );
  }
  throw err;
}

function sourceBody(sourceRepo: RepoRef, manifestPath: string) {
  return {
    sourceRepoOwner: sourceRepo.owner,
    sourceRepoName: sourceRepo.repo,
    manifestPath,
  };
}

export async function sandboxInitCommand(options: RuntimeOptions = {}, command?: Command): Promise<void> {
  const runtime = getRuntimeOptions(command, options);
  if (existsSync(DEFAULT_MANIFEST_PATH)) throw new CliError("conflict", `${DEFAULT_MANIFEST_PATH} already exists`);
  const layerPath = ".cycloid/sandbox.layer.Dockerfile";
  if (existsSync(layerPath)) throw new CliError("conflict", `${layerPath} already exists`);
  mkdirSync(dirname(DEFAULT_MANIFEST_PATH), { recursive: true });
  writeFileSync(
    DEFAULT_MANIFEST_PATH,
    [
      "version: 1",
      "layer:",
      "  dockerfile: .cycloid/sandbox.layer.Dockerfile",
      "smoke:",
      "  commands:",
      '    - ["bash", "-lc", "command -v git && command -v python3"]',
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    layerPath,
    [
      "# Only RUN and ENV instructions are supported.",
      "# Example:",
      "# RUN apt-get update && apt-get install -y --no-install-recommends ripgrep && rm -rf /var/lib/apt/lists/*",
      "",
    ].join("\n"),
    "utf8",
  );
  const payload = { ok: true, manifestPath: DEFAULT_MANIFEST_PATH, layerPath };
  emit(command, runtime, payload, () => console.log(`Created ${DEFAULT_MANIFEST_PATH} and ${layerPath}`));
}

export async function sandboxValidateCommand(
  options: { manifest?: string; json?: boolean } & RuntimeOptions = {},
  command?: Command,
): Promise<void> {
  const manifestPath = options.manifest ?? DEFAULT_MANIFEST_PATH;
  assertManifestExists(manifestPath);
  const manifestText = readFileSync(manifestPath, "utf8");
  let layerPath: string;
  try {
    layerPath = parseSandboxLayerManifest(manifestPath, manifestText).layer.dockerfile;
    assertManifestExists(layerPath);
    const layerText = readFileSync(layerPath, "utf8");
    const parsed = await parseSandboxLayerSource({ manifestPath, manifestText, layerPath, layerText });
    const payload = formatValidationPayload({ manifestPath, layerPath, parsed });
    emit(command, options, payload, (validationPayload) => {
      console.log("Valid sandbox template.");
      console.log(`Manifest: ${validationPayload.manifestPath}`);
      console.log(`Layer: ${validationPayload.layerPath}`);
      console.log(`Normalized source hash: ${validationPayload.normalizedSourceHash}`);
      console.log(`Instructions: ${validationPayload.instructionCount}`);
      console.log(`Smoke commands: ${validationPayload.smokeCommandCount}`);
      console.log(`Next: ${nextBuildCommand(manifestPath)}`);
    });
  } catch (err) {
    handleValidationError(err, options, command);
  }
}

export async function sandboxBuildCommand(
  sourceRepoArg: string | undefined,
  options: {
    manifest?: string;
    ref?: string;
    targetRepo?: string;
    wait?: boolean;
    follow?: boolean;
    pollInterval?: string;
    idempotencyKey?: string;
    json?: boolean;
  } & SandboxCommandOptions = {},
  command?: Command,
): Promise<void> {
  const { config } = resolveBusinessContext(command, options);
  const manifestPath = options.manifest ?? DEFAULT_MANIFEST_PATH;
  assertManifestExists(manifestPath);
  if (!options.ref) assertCleanAndPushed();
  const sourceRepo = parseRepoArg(sourceRepoArg, currentRepo);
  const targetRepo = options.targetRepo ? parseRepoArg(options.targetRepo, currentRepo) : null;
  const businessId = await resolveBusinessId(config, options);
  const ref = options.ref ?? currentRef();
  let payload: BuildRequestResponse;
  try {
    payload = await apiFetch<BuildRequestResponse>(
      config,
      `/api/businesses/${encodeURIComponent(businessId)}/repos/${encodeURIComponent(sourceRepo.owner)}/${encodeURIComponent(
        sourceRepo.repo,
      )}/sandbox-layer/build-requests`,
      {
        method: "POST",
        headers: { "Idempotency-Key": options.idempotencyKey ?? randomIdempotencyKey() },
        body: JSON.stringify({
          ref,
          manifestPath,
          ...(targetRepo ? { targetRepo: { owner: targetRepo.owner, name: targetRepo.repo } } : {}),
        }),
      },
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && err.data?.serverCode === "duplicate_request") {
      throw new CliError(err.code, err.message, {
        exitCode: err.exitCode,
        requestId: err.requestId,
        data: err.data,
        hint: "Use the same --idempotency-key only for retrying the original sandbox build request.",
      });
    }
    throw err;
  }
  const json = isJson(command, options);
  if (!(json && options.follow)) {
    emit(command, options, payload, (buildPayload) => printBuildRequest(buildPayload.buildRequest));
  }

  if (!options.wait && !options.follow) return;
  const finalBuild = await waitForBuild(config, businessId, payload.buildRequest.id, {
    follow: options.follow,
    pollIntervalMs: parsePollInterval(options.pollInterval),
    json,
  });
  if (json)
    writeJson(options.follow ? { type: "build", buildRequest: finalBuild } : { ok: true, buildRequest: finalBuild });
  else printTerminalBuildSummary(finalBuild);
  if (finalBuild.status !== "completed") {
    process.exitCode = 1;
  }
}

export async function sandboxStatusCommand(
  repoArg: string | undefined,
  options: SandboxCommandOptions = {},
  command?: Command,
): Promise<void> {
  const { config } = resolveBusinessContext(command, options);
  const businessId = await resolveBusinessId(config, options);
  const repo = parseRepoArg(repoArg, currentRepo);
  const payload = await apiFetch<SandboxStatusResponse>(
    config,
    `/api/businesses/${encodeURIComponent(businessId)}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(
      repo.repo,
    )}/sandbox-layer/resolution`,
  );
  emit(command, options, payload, printSandboxStatus);
}

export async function sandboxHistoryCommand(
  sourceRepoArg: string | undefined,
  options: {
    targetRepo?: string;
    status?: string;
    limit?: string;
  } & SandboxCommandOptions = {},
  command?: Command,
): Promise<void> {
  const { config } = resolveBusinessContext(command, options);
  const businessId = await resolveBusinessId(config, options);
  const sourceRepo = parseRepoArg(sourceRepoArg, currentRepo);
  const params = new URLSearchParams({ sourceRepo: repoPath(sourceRepo) });
  if (options.targetRepo) params.set("targetRepo", repoPath(parseRepoArg(options.targetRepo, currentRepo)));
  if (options.status) params.set("status", options.status);
  if (options.limit) {
    const limit = Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new CliError("user", "--limit must be a positive integer.");
    }
    params.set("limit", String(limit));
  }
  const payload = await apiFetch<BuildHistoryResponse>(
    config,
    `/api/businesses/${encodeURIComponent(businessId)}/sandbox-layer/build-requests?${params.toString()}`,
  );
  emit(command, options, payload, (historyPayload) => printBuildHistory(historyPayload.builds));
}

export async function sandboxRebuildStaleCommand(
  options: {
    business?: string;
    all?: boolean;
    dryRun?: boolean;
    yes?: boolean;
    follow?: boolean;
    json?: boolean;
  } & RuntimeOptions = {},
  command?: Command,
): Promise<void> {
  const { config } = resolveBusinessContext(command, options);
  if (!options.dryRun && !options.yes) {
    throw new CliError("user", "Use --dry-run to preview or --yes to start a rebuild campaign.");
  }
  if (options.all && options.business) {
    throw new CliError("user", "Use either --all or --business, not both.");
  }
  const businessId = options.all ? null : await resolveBusinessId(config, options);
  let payload = await apiFetch<RebuildCampaignResponse>(config, "/api/admin/sandbox-layer/rebuild-campaigns", {
    method: "POST",
    body: JSON.stringify({
      scope: options.all ? "all" : "business",
      ...(businessId ? { businessId } : {}),
      reason: "base_update",
      dryRun: Boolean(options.dryRun),
    }),
  }).catch((error) => {
    if (error instanceof ApiError && error.status === 403) {
      throw new CliError("auth", "Only Cycloid internal admins can rebuild stale sandbox layers.");
    }
    throw error;
  });
  if (options.follow && !options.dryRun) {
    payload = await followRebuildCampaign(config, payload.campaign.id);
  }
  emit(command, options, payload, printRebuildCampaign);
}

async function followRebuildCampaign(config: CliConfig, campaignId: string): Promise<RebuildCampaignResponse> {
  for (;;) {
    const payload = await apiFetch<RebuildCampaignResponse>(
      config,
      `/api/admin/sandbox-layer/rebuild-campaigns/${encodeURIComponent(campaignId)}`,
    );
    if (isCampaignTerminal(payload.campaign.status)) return payload;
    await sleep(DEFAULT_POLL_INTERVAL_MS);
  }
}

function isCampaignTerminal(status: string): boolean {
  return status === "completed" || status === "completed_with_failures" || status === "failed";
}

function printRebuildCampaign(payload: RebuildCampaignResponse): void {
  console.log(`Campaign: ${payload.campaign.id}`);
  console.log(`Status: ${payload.campaign.status}`);
  console.log(`Active artifacts scanned: ${payload.campaign.summary.activeArtifactsScanned}`);
  console.log(`Stale artifacts found: ${payload.campaign.summary.staleArtifactsFound}`);
  console.log(`Current artifacts skipped: ${payload.campaign.summary.currentArtifactsSkipped}`);
  console.log(`Missing installation skips: ${payload.campaign.summary.missingInstallationSkips}`);
  console.log(`Source unavailable skips: ${payload.campaign.summary.sourceUnavailableSkips}`);
  console.log(`Unversioned base skips: ${payload.campaign.summary.unversionedBaseSkips}`);
  console.log(`Active changed skips: ${payload.campaign.summary.activeChangedSkips}`);
  console.log(`Failed items: ${payload.campaign.summary.failedItems}`);
  console.log(`Promoted items: ${payload.campaign.summary.promotedItems}`);
  console.log(`Builds queued: ${payload.campaign.summary.buildsQueued}`);
  if (payload.campaign.status === "completed_with_failures" || payload.campaign.status === "failed") {
    console.log("Previous active templates remain active for failed or skipped rebuild items.");
  }
}

export async function sandboxLogsCommand(
  buildId: string,
  options: {
    follow?: boolean;
    afterSequence?: string;
    limit?: string;
    pollInterval?: string;
  } & SandboxCommandOptions = {},
  command?: Command,
): Promise<void> {
  const { config } = resolveBusinessContext(command, options);
  const businessId = await resolveBusinessId(config, options);
  let afterSequence = options.afterSequence == null ? undefined : Number(options.afterSequence);
  if (afterSequence != null && (!Number.isInteger(afterSequence) || afterSequence < 0)) {
    throw new CliError("user", "--after-sequence must be a non-negative integer.");
  }
  const limit = options.limit == null ? undefined : Number(options.limit);
  if (limit != null && (!Number.isInteger(limit) || limit < 1)) {
    throw new CliError("user", "--limit must be a positive integer.");
  }

  for (;;) {
    const payload = await apiFetch<BuildLogsResponse>(
      config,
      buildLogsPath(businessId, buildId, { afterSequence, limit }),
    );
    if (payload.logs.length > 0 || !options.follow) {
      if (isJson(command, options)) writeJson(options.follow ? { type: "logs", logs: payload.logs } : payload);
      else printLogs(payload.logs);
    }
    if (!options.follow) return;
    if (payload.logs.length > 0) afterSequence = payload.logs[payload.logs.length - 1]!.sequence;
    await sleep(parsePollInterval(options.pollInterval));
  }
}

export async function sandboxAssignDefaultCommand(
  sourceRepoArg: string,
  options: { manifest?: string } & SandboxCommandOptions = {},
  command?: Command,
): Promise<void> {
  const { config } = resolveBusinessContext(command, options);
  const businessId = await resolveBusinessId(config, options);
  const sourceRepo = parseRepoArg(sourceRepoArg, currentRepo);
  const manifestPath = options.manifest ?? DEFAULT_MANIFEST_PATH;
  const payload = await apiFetch<Record<string, unknown>>(
    config,
    `/api/businesses/${encodeURIComponent(businessId)}/sandbox-layer/default-source`,
    { method: "PUT", body: JSON.stringify(sourceBody(sourceRepo, manifestPath)) },
  );
  emit(command, options, payload, () => {
    console.log(`Set default sandbox layer source to ${repoPath(sourceRepo)}.`);
    console.log(
      `Build missing target coverage with: cycloid sandbox build ${repoPath(sourceRepo)} --business ${businessId}`,
    );
  });
}

export async function sandboxAssignRepoCommand(
  targetRepoArg: string,
  sourceRepoArg: string,
  options: { manifest?: string } & SandboxCommandOptions = {},
  command?: Command,
): Promise<void> {
  const { config } = resolveBusinessContext(command, options);
  const businessId = await resolveBusinessId(config, options);
  const targetRepo = parseRepoArg(targetRepoArg, currentRepo);
  const sourceRepo = parseRepoArg(sourceRepoArg, currentRepo);
  const manifestPath = options.manifest ?? DEFAULT_MANIFEST_PATH;
  const payload = await apiFetch<Record<string, unknown>>(
    config,
    `/api/businesses/${encodeURIComponent(businessId)}/repos/${encodeURIComponent(targetRepo.owner)}/${encodeURIComponent(
      targetRepo.repo,
    )}/sandbox-layer/assignment`,
    { method: "PUT", body: JSON.stringify(sourceBody(sourceRepo, manifestPath)) },
  );
  emit(command, options, payload, () => {
    console.log(`Assigned ${repoPath(sourceRepo)} as sandbox layer source for ${repoPath(targetRepo)}.`);
    console.log(
      `Build target coverage with: cycloid sandbox build ${repoPath(sourceRepo)} --target-repo ${repoPath(
        targetRepo,
      )} --business ${businessId}`,
    );
  });
}

export async function sandboxUnassignDefaultCommand(
  options: { yes?: boolean } & SandboxCommandOptions = {},
  command?: Command,
): Promise<void> {
  if (isJson(command, options) && options.yes !== true) {
    throw new CliError("user", "`sandbox unassign default --json` requires --yes.");
  }
  const { config } = resolveBusinessContext(command, options);
  const businessId = await resolveBusinessId(config, options);
  if (!options.yes) await confirmOrThrow("Clear the business default sandbox layer source?");
  const payload = await apiFetch<Record<string, unknown>>(
    config,
    `/api/businesses/${encodeURIComponent(businessId)}/sandbox-layer/default-source`,
    { method: "DELETE" },
  );
  emit(command, options, payload, () => console.log("Cleared default sandbox layer source."));
}

export async function sandboxUnassignRepoCommand(
  targetRepoArg: string,
  options: { yes?: boolean } & SandboxCommandOptions = {},
  command?: Command,
): Promise<void> {
  if (isJson(command, options) && options.yes !== true) {
    throw new CliError("user", "`sandbox unassign repo --json` requires --yes.");
  }
  const { config } = resolveBusinessContext(command, options);
  const businessId = await resolveBusinessId(config, options);
  const targetRepo = parseRepoArg(targetRepoArg, currentRepo);
  if (!options.yes) await confirmOrThrow(`Clear sandbox layer assignment for ${repoPath(targetRepo)}?`);
  const payload = await apiFetch<Record<string, unknown>>(
    config,
    `/api/businesses/${encodeURIComponent(businessId)}/repos/${encodeURIComponent(targetRepo.owner)}/${encodeURIComponent(
      targetRepo.repo,
    )}/sandbox-layer/assignment`,
    { method: "DELETE" },
  );
  emit(command, options, payload, () => console.log(`Cleared sandbox layer assignment for ${repoPath(targetRepo)}.`));
}
