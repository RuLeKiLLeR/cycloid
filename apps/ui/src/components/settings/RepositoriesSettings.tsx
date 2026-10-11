import { useId, useState } from "react";

import { useSyncEffect } from "../../hooks/useEffects";
import { useLayoutContext } from "../Layout";
import { Select } from "../ui";
import { RepositoryEnvVarsSettings } from "./RepositoryEnvVarsSettings";
import { RepositorySandboxSettings } from "./RepositorySandboxSettings";
import { ReviewerChecklistSettings } from "./ReviewerChecklistSettings";
import {
  SettingsField,
  SettingsPageHeader,
  SettingsScopeBadge,
  SettingsSection,
  SettingsSkeleton,
} from "./SettingsLayout";
import { AdminOnlyNotice, useWorkspaceAdminAccess } from "./workspaceSettingsShared";

/**
 * Per-repository settings surface. A single page-level repo picker drives every
 * section below it: the member-usable review checklist plus the admin-only
 * environment variables and sandbox resolution view.
 */
export function RepositoriesSettings() {
  const { repos, reposLoaded, settings, user, capabilities } = useLayoutContext();
  const adminAccess = useWorkspaceAdminAccess();
  const [selectedRepo, setSelectedRepo] = useState("");
  const repoSelectId = useId();

  useSyncEffect(() => {
    if (selectedRepo || !reposLoaded || repos.length === 0) return;
    setSelectedRepo(
      settings?.defaultRepo && repos.some((repo) => repo.fullName === settings.defaultRepo)
        ? settings.defaultRepo
        : repos[0]!.fullName,
    );
  }, [repos, reposLoaded, selectedRepo, settings?.defaultRepo]);

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        eyebrow="Repositories"
        title="Repositories"
        description="Settings that apply to a single repository."
      />

      <SettingsSection
        title="Repository"
        description="Choose which repository these settings apply to."
        meta={
          reposLoaded ? (
            <span>
              <span className="numeral">{repos.length}</span> available
            </span>
          ) : (
            "Loading"
          )
        }
      >
        <SettingsField
          label="Repository"
          htmlFor={repoSelectId}
          hint={
            !reposLoaded
              ? "Loading repositories…"
              : repos.length === 0
                ? "No repositories are available yet."
                : undefined
          }
          error={reposLoaded && repos.length === 0 ? "Connect a repository before adding settings." : undefined}
        >
          <Select
            id={repoSelectId}
            value={selectedRepo}
            disabled={!reposLoaded || repos.length === 0}
            onChange={(event) => setSelectedRepo(event.target.value)}
          >
            <option value="">{reposLoaded ? "Choose a repository…" : "Loading…"}</option>
            {repos.map((repo) => (
              <option key={repo.fullName} value={repo.fullName}>
                {repo.fullName}
              </option>
            ))}
          </Select>
        </SettingsField>
      </SettingsSection>

      <SettingsSection
        title="Review checklist"
        description="Which reviewers Cycloid waits for before it responds on this repo's PRs, and how it handles merge conflicts."
        meta={<SettingsScopeBadge scope="user" />}
      >
        <ReviewerChecklistSettings repoFullName={selectedRepo} />
      </SettingsSection>

      <SettingsSection
        title="Environment variables"
        description="Variables Cycloid exposes to sessions on this repository. Values stay encrypted and write-only; existing values are never returned to the browser."
        meta={<SettingsScopeBadge scope="repository" />}
      >
        {adminAccess === "admin" ? (
          <RepositoryEnvVarsSettings selectedRepo={selectedRepo} />
        ) : adminAccess === "loading" ? (
          <SettingsSkeleton rows={3} showHeader={false} control={false} />
        ) : (
          <AdminOnlyNotice message="Ask a workspace admin to change repository environment variables." />
        )}
      </SettingsSection>

      <SettingsSection
        title="Dev environment"
        description="The environment Cycloid runs in for this repository: image, setup state, machine size, and recent build history."
        meta={<SettingsScopeBadge scope="repository" />}
      >
        {adminAccess === "admin" && user?.businessId ? (
          <RepositorySandboxSettings
            businessId={user.businessId}
            selectedRepo={selectedRepo}
            reposLoaded={reposLoaded}
            hasRepos={repos.length > 0}
            canAccessIntegrationDebug={capabilities?.canAccessIntegrationDebug === true}
          />
        ) : adminAccess === "loading" ? (
          <SettingsSkeleton rows={3} showHeader={false} control={false} />
        ) : (
          <AdminOnlyNotice message="Ask a workspace admin to view this repository's dev environment." />
        )}
      </SettingsSection>
    </div>
  );
}
