import { useState } from "react";

import type { SandboxLayerAssignments } from "../../api/sandbox-layers";
import { useSyncEffect } from "../../hooks/useEffects";
import { Badge, Button, Select } from "../ui";
import { formatRelativeTime, shortId } from "./sandboxLayerShared";
import { SettingsScopeBadge, SettingsSection } from "./SettingsLayout";
import { parseRepoFullName } from "./workspaceSettingsShared";

function repoOptions(repos: Array<{ fullName: string }>, current: string | null | undefined): string[] {
  const values = new Set<string>();
  if (current) values.add(current);
  for (const repo of repos) values.add(repo.fullName);
  return [...values];
}

function defaultSourceRepoForForm(
  businessDefault: SandboxLayerAssignments["businessDefault"],
  repos: Array<{ fullName: string }>,
  defaultRepo: string | null | undefined,
): string {
  if (businessDefault?.sourceRepo) return businessDefault.sourceRepo;
  if (defaultRepo && repos.some((repo) => repo.fullName === defaultRepo)) return defaultRepo;
  return repos[0]?.fullName ?? "";
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
 * Workspace-default sandbox source editor. Mounted on WorkspacePoliciesSettings.
 * The per-repo resolution preview (view details / template ID / build history)
 * lives in RepositorySandboxSettings on the Repositories page.
 */
export function SandboxEnvironmentSettings({
  businessId,
  repos,
  reposLoaded,
  defaultRepo,
}: {
  businessId: string;
  repos: Array<{ fullName: string }>;
  reposLoaded: boolean;
  defaultRepo: string | null | undefined;
}) {
  const [assignments, setAssignments] = useState<SandboxLayerAssignments | null>(null);
  const [assignmentsLoading, setAssignmentsLoading] = useState(false);
  const [assignmentError, setAssignmentError] = useState<string | null>(null);
  const [defaultEditorOpen, setDefaultEditorOpen] = useState(false);
  const [defaultSourceRepo, setDefaultSourceRepo] = useState("");
  const [defaultSaving, setDefaultSaving] = useState(false);

  useSyncEffect(() => {
    let cancelled = false;
    setAssignmentsLoading(true);
    setAssignmentError(null);
    import("../../api/sandbox-layers")
      .then(({ fetchSandboxLayerAssignments }) => fetchSandboxLayerAssignments(businessId))
      .then((nextAssignments) => {
        if (!cancelled) setAssignments(nextAssignments);
      })
      .catch((error) => {
        if (cancelled) return;
        setAssignments(null);
        setAssignmentError(error instanceof Error ? error.message : "Failed to load sandbox defaults");
      })
      .finally(() => {
        if (!cancelled) setAssignmentsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  const businessDefault = assignments?.businessDefault ?? null;

  useSyncEffect(() => {
    if (defaultEditorOpen) return;
    setDefaultSourceRepo(defaultSourceRepoForForm(businessDefault, repos, defaultRepo));
  }, [businessDefault?.sourceRepo, defaultEditorOpen, defaultRepo, repos]);

  const defaultRepoOptions = repoOptions(repos, defaultSourceRepo || businessDefault?.sourceRepo);
  const defaultStatus = businessDefault ? "Set" : "Not set";
  const manageSourceUrl = businessDefault
    ? sandboxSourceUrl(businessDefault.sourceRepo, businessDefault.manifestPath)
    : null;

  async function saveWorkspaceDefault() {
    const parsed = parseRepoFullName(defaultSourceRepo.trim());
    if (!parsed) {
      setAssignmentError("Choose a source repository.");
      return;
    }
    setDefaultSaving(true);
    setAssignmentError(null);
    try {
      const { setSandboxLayerBusinessDefaultSource } = await import("../../api/sandbox-layers");
      const assignment = await setSandboxLayerBusinessDefaultSource(businessId, {
        sourceRepoOwner: parsed.repoOwner,
        sourceRepoName: parsed.repoName,
      });
      setAssignments((previous) => ({
        businessDefault: assignment,
        repoAssignments: previous?.repoAssignments ?? [],
      }));
      setDefaultSourceRepo(assignment.sourceRepo);
      setDefaultEditorOpen(false);
    } catch (error) {
      setAssignmentError(error instanceof Error ? error.message : "Failed to update sandbox default");
    } finally {
      setDefaultSaving(false);
    }
  }

  async function clearWorkspaceDefault() {
    setDefaultSaving(true);
    setAssignmentError(null);
    try {
      const { clearSandboxLayerBusinessDefaultSource } = await import("../../api/sandbox-layers");
      await clearSandboxLayerBusinessDefaultSource(businessId);
      setAssignments((previous) => ({
        businessDefault: null,
        repoAssignments: previous?.repoAssignments ?? [],
      }));
      setDefaultEditorOpen(false);
    } catch (error) {
      setAssignmentError(error instanceof Error ? error.message : "Failed to clear sandbox default");
    } finally {
      setDefaultSaving(false);
    }
  }

  return (
    <SettingsSection
      title="Sandbox environment"
      description="Workspace default source new sessions build from when no repo-local or repo assignment matches."
      meta={<SettingsScopeBadge scope="workspace" />}
    >
      <div className="py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-md font-medium text-text-primary">Workspace default</p>
              <Badge tone={businessDefault ? "success" : "default"}>
                {assignmentsLoading ? "Loading" : defaultStatus}
              </Badge>
            </div>
            <div className="mt-2 space-y-1 text-base text-text-secondary">
              {assignmentsLoading ? (
                <p>Loading sandbox defaults…</p>
              ) : businessDefault ? (
                <>
                  <p className="text-text-primary">New sessions build from {businessDefault.sourceRepo}.</p>
                  <p title={businessDefault.latestActiveArtifactRef ?? undefined}>
                    Current image {shortId(businessDefault.latestActiveArtifactRef)}, updated{" "}
                    {formatRelativeTime(businessDefault.updatedAt)}.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-text-primary">No workspace default selected.</p>
                  <p>Repos fall back to the Cycloid default when no repo-local or repo assignment matches.</p>
                </>
              )}
            </div>
            {assignmentError ? <p className="mt-2 text-base text-error">{assignmentError}</p> : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
            {manageSourceUrl ? (
              <a
                href={manageSourceUrl}
                target="_blank"
                rel="noreferrer"
                className="text-base text-accent underline underline-offset-2 hover:text-text-primary"
              >
                Manage source
              </a>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setDefaultEditorOpen((value) => !value)}
              disabled={assignmentsLoading || defaultSaving || !reposLoaded || repos.length === 0}
            >
              {defaultEditorOpen ? "Cancel" : businessDefault ? "Edit default" : "Set default"}
            </Button>
            {businessDefault ? (
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={() => void clearWorkspaceDefault()}
                disabled={assignmentsLoading || defaultSaving}
              >
                {defaultSaving ? "Removing…" : "Remove"}
              </Button>
            ) : null}
          </div>
        </div>

        {defaultEditorOpen ? (
          <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <div>
              <label htmlFor="sandbox-default-source-repo" className="mb-1.5 block text-base text-text-primary">
                Source repository
              </label>
              <Select
                id="sandbox-default-source-repo"
                value={defaultSourceRepo}
                onChange={(event) => setDefaultSourceRepo(event.target.value)}
                disabled={defaultSaving || !reposLoaded || defaultRepoOptions.length === 0}
              >
                <option value="">{reposLoaded ? "Choose source repository" : "Loading"}</option>
                {defaultRepoOptions.map((repo) => (
                  <option key={repo} value={repo}>
                    {repo}
                  </option>
                ))}
              </Select>
            </div>
            <Button
              type="button"
              variant="primary"
              onClick={() => void saveWorkspaceDefault()}
              disabled={defaultSaving || !parseRepoFullName(defaultSourceRepo)}
            >
              {defaultSaving ? "Saving…" : "Save default"}
            </Button>
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
}
