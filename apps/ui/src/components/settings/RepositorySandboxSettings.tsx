import { useState } from "react";

import {
  createSandboxLayerBuildRequest,
  fetchSandboxLayerAssignments,
  fetchSandboxLayerBuildHistory,
  fetchSandboxLayerBuildLogs,
  fetchSandboxLayerResolutionPreview,
  type SandboxLayerBuildHistoryItem,
  type SandboxLayerBuildLogChunk,
  type SandboxLayerResolutionPreview,
} from "../../api/sandbox-layers";
import {
  resourceProfileDescription,
  SANDBOX_BUILD_HISTORY_LIMIT,
  SANDBOX_BUILD_LOG_CHUNK_LIMIT,
  SANDBOX_TIER_LABELS,
  sandboxBuildStatusMeta,
  sandboxFailurePhaseLabel,
  TEMPLATE_ID_COPY_RESET_MS,
} from "../../constants/devEnvironment";
import { useSyncEffect } from "../../hooks/useEffects";
import { Badge, Button, CopyButton } from "../ui";
import { formatRelativeTime, shortId } from "./sandboxLayerShared";
import { parseRepoFullName } from "./workspaceSettingsShared";

const SANDBOX_BUILD_POLL_MS = 5_000;

function resolveSandboxBuildHistorySource(input: {
  selectedSourceRepo?: string | null;
  compactSelectedSourceRepo?: string | null;
  businessDefaultSourceRepo?: string | null;
  selectedRepo?: string | null;
}): string {
  return (
    input.selectedSourceRepo ??
    input.compactSelectedSourceRepo ??
    input.businessDefaultSourceRepo ??
    input.selectedRepo ??
    ""
  );
}

function buildActorLabel(
  actor: { userId: number; login: string | null; name: string | null } | null | undefined,
): string {
  if (!actor) return "Not available";
  if (actor.login) return `@${actor.login}`;
  if (actor.name) return actor.name;
  return `User ${actor.userId}`;
}

function absoluteTime(value: number | null | undefined): string | undefined {
  return value ? new Date(value).toLocaleString() : undefined;
}

function sandboxSourceUrl(sourceRepo: string, manifestPath: string): string | null {
  const parsed = parseRepoFullName(sourceRepo);
  if (!parsed) return null;
  const encodedPath = manifestPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://github.com/${encodeURIComponent(parsed.repoOwner)}/${encodeURIComponent(parsed.repoName)}/blob/HEAD/${encodedPath}`;
}

/**
 * Per-repo dev environment surface for the repository picked on the
 * Repositories page: what Cycloid's runtime is for this repo (image, setup
 * state, staleness), the fixed machine profile, and environment build history.
 * The workspace-default source editor lives in SandboxEnvironmentSettings on
 * WorkspacePoliciesSettings.
 */
export function RepositorySandboxSettings({
  businessId,
  selectedRepo,
  reposLoaded,
  hasRepos,
  canAccessIntegrationDebug,
}: {
  businessId: string;
  selectedRepo: string;
  reposLoaded: boolean;
  hasRepos: boolean;
  canAccessIntegrationDebug: boolean;
}) {
  const [businessDefaultSourceRepo, setBusinessDefaultSourceRepo] = useState<string | null>(null);
  const [resolution, setResolution] = useState<SandboxLayerResolutionPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [buildHistory, setBuildHistory] = useState<SandboxLayerBuildHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [diagnosticsBuildId, setDiagnosticsBuildId] = useState<string | null>(null);
  const [diagnosticsLogs, setDiagnosticsLogs] = useState<Record<string, SandboxLayerBuildLogChunk[]>>({});
  const [diagnosticsLogsLoading, setDiagnosticsLogsLoading] = useState<Record<string, boolean>>({});
  const [diagnosticsLogsError, setDiagnosticsLogsError] = useState<Record<string, string | null>>({});
  const [rebuildSubmitting, setRebuildSubmitting] = useState(false);
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  const [rebuildIdempotencyKey, setRebuildIdempotencyKey] = useState(() => crypto.randomUUID());
  const [resolutionRefresh, setResolutionRefresh] = useState(0);

  // Business default source is only a fallback for the build-history query; fetch
  // it quietly and treat any failure as "no default" rather than surfacing an error.
  useSyncEffect(() => {
    let cancelled = false;
    fetchSandboxLayerAssignments(businessId)
      .then((assignments) => {
        if (!cancelled) setBusinessDefaultSourceRepo(assignments.businessDefault?.sourceRepo ?? null);
      })
      .catch(() => {
        if (!cancelled) setBusinessDefaultSourceRepo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  // Collapse expandable panels when the picked repo changes so we never show
  // one repo's expanded history or details under another repo's headline.
  useSyncEffect(() => {
    setHistoryOpen(false);
    setDetailsOpen(false);
    setRebuildError(null);
    setRebuildIdempotencyKey(crypto.randomUUID());
  }, [selectedRepo]);

  useSyncEffect(() => {
    const parsed = selectedRepo ? parseRepoFullName(selectedRepo) : null;
    if (!parsed) {
      setResolution(null);
      setLoadError(null);
      return;
    }
    let cancelled = false;
    const initialLoad = resolution?.repo !== selectedRepo;
    if (initialLoad) setLoading(true);
    setLoadError(null);
    fetchSandboxLayerResolutionPreview(businessId, parsed.repoOwner, parsed.repoName)
      .then((nextResolution) => {
        if (!cancelled) setResolution(nextResolution);
      })
      .catch((error) => {
        if (cancelled) return;
        setResolution(null);
        setLoadError(error instanceof Error ? error.message : "Failed to load the dev environment");
      })
      .finally(() => {
        if (!cancelled && initialLoad) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, resolutionRefresh, selectedRepo]);

  const selected = resolution?.selection ?? null;
  const latestBuild = resolution?.latestRepoBuild ?? null;
  const latestBuildFailed = latestBuild?.status === "failed";
  const failedCustom = !selected && latestBuildFailed;
  const outdated = selected?.baseStatus === "outdated";
  const latestBuildMeta = latestBuild ? sandboxBuildStatusMeta(latestBuild.status) : null;
  const buildInProgress = latestBuildMeta?.inProgress === true;
  const resourceProfileKey = selected?.resourceProfileKey ?? resolution?.resourceProfileKey ?? null;
  const historySourceRepo = resolveSandboxBuildHistorySource({
    selectedSourceRepo: selected?.sourceRepo,
    compactSelectedSourceRepo: resolution?.selected?.sourceRepo,
    businessDefaultSourceRepo,
    selectedRepo,
  });
  const historySource = parseRepoFullName(historySourceRepo);
  const targetRepo = parseRepoFullName(selectedRepo);
  const recoveryNeeded = latestBuildFailed || outdated;
  const sourceManifestPath = selected?.manifestPath ?? latestBuild?.manifestPath ?? ".cycloid/sandbox.yaml";
  const manageSourceUrl = historySourceRepo ? sandboxSourceUrl(historySourceRepo, sourceManifestPath) : null;
  const rebuildDisabledReason = rebuildSubmitting
    ? "Submitting the build request."
    : buildInProgress
      ? "A build is already in progress."
      : !historySource || !targetRepo
        ? "No valid sandbox source is available to rebuild."
        : null;

  useSyncEffect(() => {
    if (!buildInProgress) return;
    const timeout = window.setTimeout(() => setResolutionRefresh((value) => value + 1), SANDBOX_BUILD_POLL_MS);
    return () => window.clearTimeout(timeout);
  }, [buildInProgress, latestBuild?.id, latestBuild?.status, resolutionRefresh]);

  // History is user-facing for workspace admins (the control plane requires
  // business admin for the list endpoint, and this component only mounts for
  // admins). Raw logs remain collapsed until explicitly requested.
  useSyncEffect(() => {
    if (!historyOpen || !historySourceRepo || !resolution) {
      setBuildHistory([]);
      setHistoryError(null);
      setDiagnosticsBuildId(null);
      setDiagnosticsLogs({});
      setDiagnosticsLogsLoading({});
      setDiagnosticsLogsError({});
      return;
    }
    let cancelled = false;
    setHistoryLoading(true);
    setHistoryError(null);
    fetchSandboxLayerBuildHistory(businessId, {
      sourceRepo: historySourceRepo,
      targetRepo: selectedRepo || null,
      limit: SANDBOX_BUILD_HISTORY_LIMIT,
    })
      .then((builds) => {
        if (!cancelled) setBuildHistory(builds);
      })
      .catch((error) => {
        if (cancelled) return;
        setBuildHistory([]);
        setHistoryError(error instanceof Error ? error.message : "Failed to load environment history");
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, historyOpen, historySourceRepo, resolution, selectedRepo]);

  async function loadBuildDiagnosticsLogs(buildId: string) {
    if (diagnosticsLogs[buildId] || diagnosticsLogsLoading[buildId]) return;
    setDiagnosticsLogsLoading((current) => ({ ...current, [buildId]: true }));
    setDiagnosticsLogsError((current) => ({ ...current, [buildId]: null }));
    try {
      const logs = await fetchSandboxLayerBuildLogs(businessId, buildId, { limit: SANDBOX_BUILD_LOG_CHUNK_LIMIT });
      setDiagnosticsLogs((current) => ({ ...current, [buildId]: logs }));
    } catch (error) {
      setDiagnosticsLogsError((current) => ({
        ...current,
        [buildId]: error instanceof Error ? error.message : "Failed to load build logs",
      }));
    } finally {
      setDiagnosticsLogsLoading((current) => ({ ...current, [buildId]: false }));
    }
  }

  async function toggleDiagnostics(buildId: string) {
    if (diagnosticsBuildId === buildId) {
      setDiagnosticsBuildId(null);
      return;
    }
    setDiagnosticsBuildId(buildId);
    await loadBuildDiagnosticsLogs(buildId);
  }

  async function rebuildEnvironment() {
    if (rebuildDisabledReason || !historySource || !targetRepo) return;
    setRebuildSubmitting(true);
    setRebuildError(null);
    try {
      await createSandboxLayerBuildRequest(businessId, historySource.repoOwner, historySource.repoName, {
        manifestPath: sourceManifestPath,
        targetRepo: { owner: targetRepo.repoOwner, name: targetRepo.repoName },
        idempotencyKey: rebuildIdempotencyKey,
      });
      setRebuildIdempotencyKey(crypto.randomUUID());
      setHistoryOpen(true);
      setResolutionRefresh((value) => value + 1);
    } catch (error) {
      setRebuildError(error instanceof Error ? error.message : "Failed to rebuild the environment");
    } finally {
      setRebuildSubmitting(false);
    }
  }

  if (!reposLoaded) {
    return <p className="px-4 py-4 text-base text-text-muted">Loading repositories…</p>;
  }
  if (!hasRepos) {
    return <p className="px-4 py-4 text-base text-text-muted">No repositories available.</p>;
  }
  if (loading) {
    return <p className="px-4 py-4 text-base text-text-muted">Loading the dev environment…</p>;
  }
  if (loadError) {
    return (
      <p role="alert" className="px-4 py-4 text-base text-error">
        {loadError}
      </p>
    );
  }
  if (!resolution) {
    return <p className="px-4 py-4 text-base text-text-muted">Choose a repository to see its dev environment.</p>;
  }

  const statusBadge = failedCustom ? (
    <Badge tone="error" role="status">
      Setup failed
    </Badge>
  ) : outdated ? (
    <Badge tone="error" role="status">
      Rebuild needed
    </Badge>
  ) : selected ? (
    <Badge tone="success" role="status">
      Ready
    </Badge>
  ) : (
    <Badge role="status">Default</Badge>
  );

  return (
    <>
      {/* Loaded-content fade: the parent section's dividers rely on these being
          direct children, so each top-level block carries the (shared) fade. */}
      <div className="editorial-fade px-4 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-md font-medium text-text-primary">
            {selected ? "Custom environment" : "Cycloid default environment"}
          </p>
          {statusBadge}
        </div>

        <div className="mt-2 space-y-1 text-base text-text-secondary">
          {selected ? (
            <>
              <p>
                Cycloid runs this repository in an environment built from {selected.sourceRepo} (
                {SANDBOX_TIER_LABELS[selected.tier]}).
              </p>
              <p>
                Built {formatRelativeTime(selected.builtAt)} by {buildActorLabel(selected.createdBy)}
                {selected.smokeStatus === "passed"
                  ? " · setup check passed"
                  : selected.smokeStatus === "failed"
                    ? " · setup check failed"
                    : ""}
                .
              </p>
            </>
          ) : (
            <p>No custom setup for this repository; sessions start from Cycloid's standard image.</p>
          )}
          <p>{resourceProfileDescription(resourceProfileKey)}</p>
          {latestBuildFailed ? <p>Last failure: {formatRelativeTime(latestBuild?.updatedAt)}.</p> : null}
        </div>

        {outdated && selected ? (
          <div role="alert" className="editorial-fade mt-3 border border-error-soft-border bg-error-soft px-3 py-2.5">
            <p className="text-base text-error">
              This environment was built on an outdated base image. New sessions may fail to start until it is rebuilt
              from {selected.sourceRepo}.
            </p>
            {selected.currentBaseVersion ? (
              <p className="mt-1 font-mono text-xs text-error">
                Built on {shortId(selected.baseVersion)} · current {shortId(selected.currentBaseVersion)}
              </p>
            ) : null}
          </div>
        ) : null}

        {latestBuildFailed ? (
          <div role="alert" className="editorial-fade mt-3 border border-error-soft-border bg-error-soft px-3 py-2.5">
            <p className="text-base text-error">
              The last environment build failed {formatRelativeTime(latestBuild?.updatedAt)}.{" "}
              {selected
                ? "The previous custom environment remains active."
                : "Sessions fall back to the Cycloid default image."}
            </p>
            <p className="mt-1 text-sm text-error">
              {latestBuild?.smoke?.status === "failed"
                ? `Setup check failed${latestBuild.smoke.command ? `: ${latestBuild.smoke.command}` : ""}`
                : (latestBuild?.error ?? "Build failed")}
            </p>
            {latestBuild ? (
              <div className="mt-2">
                <Button size="sm" variant="ghost" onClick={() => void toggleDiagnostics(latestBuild.id)}>
                  {diagnosticsBuildId === latestBuild.id ? "Hide logs" : "Show logs"}
                </Button>
                {diagnosticsBuildId === latestBuild.id ? (
                  <BuildLogOutput
                    loading={diagnosticsLogsLoading[latestBuild.id] === true}
                    error={diagnosticsLogsError[latestBuild.id]}
                    logs={diagnosticsLogs[latestBuild.id]}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {buildInProgress && latestBuildMeta ? (
          <div className="editorial-fade mt-3 border border-live-border px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-2 text-base text-text-secondary">
                {/* Heartbeat: the sanctioned liveness pulse for an in-progress build. */}
                <span
                  aria-hidden
                  className="status-dot review-loop-breathe h-1.5 w-1.5 shrink-0 rounded-full bg-live"
                />
                <Badge tone="accent">{latestBuildMeta.label}</Badge>
                <span>Build updated {formatRelativeTime(latestBuild?.updatedAt)}.</span>
              </p>
              {latestBuild ? (
                <Button size="sm" variant="ghost" onClick={() => void toggleDiagnostics(latestBuild.id)}>
                  {diagnosticsBuildId === latestBuild.id ? "Hide logs" : "Show logs"}
                </Button>
              ) : null}
            </div>
            {latestBuild && diagnosticsBuildId === latestBuild.id ? (
              <BuildLogOutput
                loading={diagnosticsLogsLoading[latestBuild.id] === true}
                error={diagnosticsLogsError[latestBuild.id]}
                logs={diagnosticsLogs[latestBuild.id]}
              />
            ) : null}
          </div>
        ) : null}

        {recoveryNeeded ? (
          <div className="mt-3 border-t border-border pt-3">
            <div className="flex flex-wrap items-center gap-2">
              {manageSourceUrl ? (
                <a
                  href={manageSourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="control-sm inline-flex items-center border border-border-strong px-3 text-sm font-medium text-text-primary hover:border-border-focus"
                >
                  Manage source
                </a>
              ) : null}
              <Button
                size="sm"
                variant="primary"
                disabled={rebuildDisabledReason !== null}
                aria-describedby={rebuildDisabledReason ? "sandbox-rebuild-disabled-reason" : undefined}
                onClick={() => void rebuildEnvironment()}
              >
                {rebuildSubmitting ? "Rebuilding…" : "Rebuild environment"}
              </Button>
            </div>
            {rebuildDisabledReason ? (
              <p id="sandbox-rebuild-disabled-reason" className="mt-2 text-sm text-text-muted">
                {rebuildDisabledReason}
              </p>
            ) : null}
            {rebuildError ? (
              <p role="alert" className="mt-2 text-sm text-error">
                {rebuildError}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="editorial-fade px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-md font-medium text-text-primary">Environment history</p>
            <p className="mt-1 text-sm text-text-muted">
              Recent builds of this environment. A bad build here silently degrades every session on this repository.
            </p>
          </div>
          <Button size="sm" disabled={!historySourceRepo} onClick={() => setHistoryOpen((value) => !value)}>
            {historyOpen ? "Hide history" : "Show history"}
          </Button>
        </div>

        {historyOpen ? (
          historyLoading ? (
            <p className="mt-3 text-base text-text-muted">Loading environment history…</p>
          ) : historyError ? (
            <p role="alert" className="mt-3 text-base text-error">
              {historyError}
            </p>
          ) : buildHistory.length === 0 ? (
            <p className="mt-3 text-base text-text-muted">No environment builds yet.</p>
          ) : (
            <ul className="mt-3 border border-border">
              {buildHistory.map((build) => {
                const meta = sandboxBuildStatusMeta(build.status);
                return (
                  <li key={build.id} className="border-border px-3 py-2.5 [&+&]:border-t">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                      <span className="font-mono-tabular text-xs text-text-muted" title={absoluteTime(build.createdAt)}>
                        {formatRelativeTime(build.createdAt)}
                      </span>
                      <span className="min-w-0 break-words text-sm text-text-secondary">
                        {build.sourceRepo} @ {shortId(build.commitSha)} · by {buildActorLabel(build.createdBy)}
                      </span>
                    </div>
                    {build.status === "completed" ? (
                      <p className="mt-1 text-sm text-text-secondary">
                        Completed {formatRelativeTime(build.completedAt)}
                        {build.smokeStatus === "passed"
                          ? " · setup check passed"
                          : build.smokeStatus === "failed"
                            ? " · setup check failed"
                            : ""}
                      </p>
                    ) : null}
                    {build.failureSummary ? (
                      <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                        <p className="min-w-0 break-words text-sm text-error">
                          {sandboxFailurePhaseLabel(build.failureSummary.phase)} failed: {build.failureSummary.reason}
                          {" — "}
                          {build.failureSummary.activeTemplateUnchanged
                            ? "the previous environment stayed active."
                            : "no custom environment is active."}
                        </p>
                        <Button size="sm" variant="ghost" onClick={() => void toggleDiagnostics(build.id)}>
                          {diagnosticsBuildId === build.id ? "Hide logs" : "Show logs"}
                        </Button>
                      </div>
                    ) : null}
                    {build.failureSummary && diagnosticsBuildId === build.id ? (
                      <div className="mt-2 border-t border-border pt-2">
                        <p className="text-sm text-text-secondary">
                          {build.failureSummary.command
                            ? `Command: ${build.failureSummary.command}`
                            : "No command recorded."}
                          {build.failureSummary.exitCode == null ? "" : ` Exit code: ${build.failureSummary.exitCode}.`}
                        </p>
                        <BuildLogOutput
                          loading={diagnosticsLogsLoading[build.id] === true}
                          error={diagnosticsLogsError[build.id]}
                          logs={diagnosticsLogs[build.id]}
                        />
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )
        ) : null}
      </div>

      {canAccessIntegrationDebug && selected ? (
        <div className="editorial-fade px-4 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-md font-medium text-text-primary">Technical details</p>
              <p className="mt-1 text-sm text-text-muted">Internal identifiers for debugging this environment.</p>
            </div>
            <Button size="sm" onClick={() => setDetailsOpen((value) => !value)}>
              {detailsOpen ? "Hide details" : "Show details"}
            </Button>
          </div>
          {detailsOpen ? (
            <dl className="mt-3 space-y-1 text-base text-text-secondary">
              <DetailRow label="Build ID" value={selected.buildId} />
              <DetailRow
                label="Image ID"
                value={selected.templateId}
                action={
                  <CopyButton value={selected.templateId} label="Copy image ID" resetMs={TEMPLATE_ID_COPY_RESET_MS} />
                }
              />
              <DetailRow label="Commit" value={selected.commitSha} />
              <DetailRow label="Profile key" value={selected.resourceProfileKey} />
              <DetailRow label="Base template" value={selected.baseTemplateRef} />
              <DetailRow label="Base version" value={selected.baseVersion} />
              <DetailRow label="Current base" value={selected.currentBaseVersion ?? "Not available"} />
              <DetailRow label="Base source" value={selected.baseSource} />
              <DetailRow label="Base status" value={selected.baseStatus === "active" ? "Active" : "Outdated"} />
              <DetailRow label="Manifest" value={selected.manifestPath} />
              <DetailRow label="Layer" value={selected.layerPath} />
            </dl>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function DetailRow({ label, value, action }: { label: string; value: string; action?: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3">
      <dt className="text-text-muted">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1 break-words text-text-primary">
        <span className="min-w-0 break-words">{value}</span>
        {action ?? null}
      </dd>
    </div>
  );
}

function BuildLogOutput({
  loading,
  error,
  logs,
}: {
  loading: boolean;
  error: string | null | undefined;
  logs: SandboxLayerBuildLogChunk[] | undefined;
}) {
  if (loading) return <p className="mt-2 text-sm text-text-muted">Loading build logs…</p>;
  if (error) return <p className="mt-2 text-sm text-error">{error}</p>;
  if (!logs?.length) return <p className="mt-2 text-sm text-text-muted">No build log chunks found.</p>;
  return (
    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap border border-border bg-surface-2 p-3 text-xs text-text-secondary">
      {logs.map((log) => `#${log.sequence} ${log.message}`).join("\n\n")}
    </pre>
  );
}
