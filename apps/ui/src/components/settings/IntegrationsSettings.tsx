import { useState } from "react";
import { useSearchParams } from "react-router";

// eslint-disable-next-line no-restricted-imports -- pre-existing: remove in Phase 1
import {
  INTEGRATION_DISPLAY_NAMES,
  isCustomerFacingIntegration,
  USER_OAUTH_INTEGRATION_IDS,
  type UserOAuthIntegrationId,
} from "../../../../../shared/constants/integration-helpers";
import {
  ONBOARDING_REASON_CODES,
  ONBOARDING_STEP_STATUS,
  type OnboardingStep,
} from "../../../../../shared/constants/onboarding";
import { INTEGRATION_LIFECYCLE_REASON_CODE } from "../../../../../shared/enums/integration-lifecycle";
import { fetchMyGithubIntegrationSummary, type GithubIntegrationSummary } from "../../api/integration-lifecycle";
import { INTEGRATION_REASON_CODE_COPY } from "../../constants/integration-health";
import { SLACK_WORKSPACE_INSTALL_URL } from "../../constants/integrations";
import { useMountEffect, useSyncEffect } from "../../hooks/useEffects";
import type { Repo, UserIntegrations } from "../../types";
import { clearRememberedPersonalIntegration } from "../../utils/integration-disconnect-warning";
import { useConfirm } from "../ConfirmDialog";
import { useLayoutContext } from "../Layout";
import { Button, buttonClasses } from "../ui";
import { CallbackBanner, formatHealthCheckedAt, resolveCallbackMessage } from "./integrationsShared";
import { SettingsPageHeader } from "./SettingsLayout";

type PersonalOauthRowId = UserOAuthIntegrationId | "slack";

const OAUTH_CONNECT_URL: Record<PersonalOauthRowId, string> = {
  linear: "/auth/linear",
  jira: "/auth/jira",
  notion: "/auth/notion",
  slack: "/auth/slack",
};
type GithubRepoContext = {
  owner: string;
  repo: string;
  fullName: string;
};

type GithubRemediation = {
  tone: "error" | "warning" | "info";
  title: string;
  description: string;
  actionLabel?: string;
};

export function JiraSitePicker({
  nonce,
  onDone,
}: {
  nonce: string;
  onDone: (result: { connected: boolean; siteName: string | null }) => void;
}) {
  const [sites, setSites] = useState<Array<{ cloudId: string; url: string; name: string | null }> | null>(null);
  const [selectedCloudId, setSelectedCloudId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useMountEffect(() => {
    void (async () => {
      try {
        const { fetchJiraPendingSites } = await import("../../api/integrations");
        const pending = await fetchJiraPendingSites(nonce);
        setSites(pending.sites);
        setSelectedCloudId(pending.sites[0]?.cloudId ?? null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "This Jira site selection has expired. Connect Jira again.");
      }
    })();
  });

  async function handleConfirm() {
    if (!selectedCloudId || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const { finalizeJiraSite } = await import("../../api/integrations");
      const result = await finalizeJiraSite(nonce, selectedCloudId);
      if (!result.ok) {
        setError("This Jira site selection is no longer valid. Connect Jira again.");
        setSubmitting(false);
        return;
      }
      const site = sites?.find((candidate) => candidate.cloudId === selectedCloudId) ?? null;
      onDone({ connected: true, siteName: site?.name ?? site?.url ?? null });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to finalize the Jira site selection.");
      setSubmitting(false);
    }
  }

  return (
    <div role="dialog" aria-label="Choose a Jira site" className="mb-6 border border-border bg-surface-1 px-4 py-4">
      <p className="text-sm font-medium text-text-primary">Choose a Jira site</p>
      <p className="mt-1 text-xs text-text-secondary">
        Your Atlassian account can access more than one Jira site. Pick the one Cycloid should use.
      </p>
      {error ? (
        <>
          <p className="mt-3 text-xs text-error">{error}</p>
          <div className="mt-4">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onDone({ connected: false, siteName: null })}
            >
              Dismiss
            </Button>
          </div>
        </>
      ) : !sites ? (
        <p className="mt-3 text-xs text-text-muted">Loading sites…</p>
      ) : (
        <>
          <ul className="mt-3 space-y-2">
            {sites.map((site) => (
              <li key={site.cloudId}>
                <label className="flex cursor-pointer items-center gap-2 text-sm text-text-primary">
                  <input
                    type="radio"
                    name="jira-site"
                    value={site.cloudId}
                    checked={selectedCloudId === site.cloudId}
                    onChange={() => setSelectedCloudId(site.cloudId)}
                  />
                  <span>{site.name ?? site.url}</span>
                  <span className="text-xs text-text-muted">{site.url}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex items-center gap-3">
            <Button
              type="button"
              variant="primary"
              onClick={() => void handleConfirm()}
              disabled={!selectedCloudId || submitting}
            >
              {submitting ? "Connecting…" : "Use this site"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onDone({ connected: false, siteName: null })}
              disabled={submitting}
            >
              Cancel
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function getCurrentHealthCopy(health: UserIntegrations["currentHealth"][string] | undefined): {
  text: string;
  className: string;
  detail: string | null;
} | null {
  if (!health || health.state === "unknown") return null;
  const checkedAt = formatHealthCheckedAt(health.checkedAt);
  const suffix = checkedAt ? ` at ${checkedAt}` : "";
  if (health.state === "healthy") {
    return {
      text: `Last checked${suffix}`,
      className: "text-text-muted",
      detail: null,
    };
  }
  // Reason codes render as plain copy; unmapped codes fall back to the raw
  // diagnostic string rather than exposing the bare code.
  const message =
    health.message ??
    (health.reasonCode ? (INTEGRATION_REASON_CODE_COPY[health.reasonCode] ?? health.diagnostic ?? null) : null) ??
    health.diagnostic ??
    null;
  return {
    text: health.state === "disconnected" ? "Needs attention" : "Degraded",
    className: health.state === "disconnected" ? "text-error" : "text-warning",
    detail: message,
  };
}

function resolveGithubRepoContext(selectedRepo: Repo | null): GithubRepoContext | null {
  if (!selectedRepo) return null;
  const [owner, repo] = selectedRepo.fullName.split("/");
  if (!owner || !repo) return null;
  return {
    owner,
    repo,
    fullName: selectedRepo.fullName,
  };
}

function getGithubRemediation(
  blockingStep: OnboardingStep,
  repoContext: GithubRepoContext | null,
): GithubRemediation | null {
  // Repo selection happens on Home when starting a session. This settings
  // screen manages integration connections, not session context, so don't
  // nag users to pick a repo here.
  if (blockingStep.reasonCode === ONBOARDING_REASON_CODES.GITHUB_REPO_NOT_SELECTED) {
    return null;
  }
  switch (blockingStep.reasonCode) {
    case ONBOARDING_REASON_CODES.GITHUB_BUSINESS_NOT_AUTHORIZED:
      return {
        tone: "error",
        title: "Business access required",
        description: "Ask an organization admin to authorize your GitHub account for this Cycloid business.",
      };
    case ONBOARDING_REASON_CODES.GITHUB_APP_NOT_INSTALLED:
      return {
        tone: "error",
        title: "Install the GitHub App",
        description: repoContext
          ? `Install the Cycloid GitHub App for ${repoContext.owner}, then make sure ${repoContext.fullName} is included in the installation.`
          : "Install the Cycloid GitHub App for the repository owner you want to use.",
        actionLabel: "Manage repository access",
      };
    case ONBOARDING_REASON_CODES.GITHUB_APP_INSTALL_PENDING_WEBHOOK_SYNC:
      return {
        tone: "warning",
        title: "Waiting for GitHub setup to finish",
        description:
          "GitHub reported setup complete, but Cycloid is still waiting for the installation webhook sync. Refresh this page in a moment.",
      };
    case ONBOARDING_REASON_CODES.GITHUB_REPO_ACCESS_DENIED:
      return {
        tone: "error",
        title: "Repository access is still blocked",
        description: repoContext
          ? `The GitHub App is installed, but ${repoContext.fullName} is not currently granted to Cycloid. Update the repository selection in GitHub.`
          : "The GitHub App is installed, but the selected repository is not currently granted to Cycloid.",
        actionLabel: "Manage repository access",
      };
    case ONBOARDING_REASON_CODES.GITHUB_REPO_ACCESS_CHECK_FAILED:
      return {
        tone: "warning",
        title: "Repository access check failed",
        description: repoContext
          ? `Cycloid couldn't confirm access to ${repoContext.fullName}. Refresh the page and try again.`
          : "Cycloid couldn't confirm repository access. Refresh the page and try again.",
      };
    case ONBOARDING_REASON_CODES.GITHUB_APP_SUSPENDED:
      return {
        tone: "error",
        title: "GitHub App installation is suspended",
        description: "Re-enable the GitHub App installation in GitHub, then refresh this page.",
        actionLabel: "Manage repository access",
      };
    default:
      return {
        tone: "error",
        title: "GitHub setup needs attention",
        description: "Resolve the blocking GitHub step below, then refresh the page.",
      };
  }
}

function getGithubRemediationClasses(remediation: GithubRemediation): string {
  if (remediation.tone === "warning") {
    return "border-warning-soft-border bg-warning-soft text-warning";
  }
  if (remediation.tone === "info") {
    return "border-accent-soft-border bg-accent-soft text-accent";
  }
  return "border-error-soft-border bg-error-soft text-error";
}

function getGithubLifecycleRemediation(summary: GithubIntegrationSummary | null): GithubRemediation | null {
  if (!summary || summary.status !== "failed") return null;
  const description = summary.userMessage ?? summary.message ?? "GitHub connection check failed. Try again.";

  switch (summary.reasonCode) {
    case INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_MISSING:
    case INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_REFRESH_FAILED:
    case INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_REVOKED:
    case INTEGRATION_LIFECYCLE_REASON_CODE.PROVIDER_AUTHN_REJECTED:
      return {
        tone: "error",
        title: "Reconnect GitHub",
        description,
      };
    case INTEGRATION_LIFECYCLE_REASON_CODE.INSTALL_MISSING:
      return {
        tone: "error",
        title: "Install the GitHub App",
        description,
        actionLabel: "Manage repository access",
      };
    case INTEGRATION_LIFECYCLE_REASON_CODE.REPO_ACCESS_DENIED:
      return {
        tone: "error",
        title: "Repository access is still blocked",
        description,
        actionLabel: "Manage repository access",
      };
    case INTEGRATION_LIFECYCLE_REASON_CODE.PROVIDER_API_UNAVAILABLE:
    case INTEGRATION_LIFECYCLE_REASON_CODE.PROVIDER_RATE_LIMITED:
    case INTEGRATION_LIFECYCLE_REASON_CODE.SANDBOX_TOKEN_UNPREPARED:
      return {
        tone: "warning",
        title: "GitHub is temporarily unavailable",
        description,
      };
    default:
      return {
        tone: "error",
        title: "GitHub setup needs attention",
        description,
      };
  }
}

export function IntegrationsSettings() {
  const { user, capabilities, onLinearChange, onJiraChange, onNotionChange, onSlackChange, selectedRepo } =
    useLayoutContext();
  const confirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();
  const hasBusinessMembership = user?.businessRole === "admin" || user?.businessRole === "member";
  const callbackMessage = resolveCallbackMessage(searchParams);
  const githubSetupComplete = searchParams.get("setup") === "complete";
  const jiraSiteSelectionNonce = searchParams.get("jira_site_selection");

  function handleJiraSitePickerDone(result: { connected: boolean; siteName: string | null }) {
    if (result.connected) {
      onJiraChange(true, result.siteName);
    }
    const next = new URLSearchParams(searchParams);
    next.delete("jira_site_selection");
    setSearchParams(next, { replace: true });
  }
  const githubRepoContext = resolveGithubRepoContext(selectedRepo);
  const [githubReauthError, setGithubReauthError] = useState<string | null>(null);
  const [githubReauthing, setGithubReauthing] = useState(false);
  const [githubSummary, setGithubSummary] = useState<GithubIntegrationSummary | null>(null);
  const [githubSummaryLoaded, setGithubSummaryLoaded] = useState(false);
  const [githubSummaryError, setGithubSummaryError] = useState<string | null>(null);
  const [installUrl, setInstallUrl] = useState<string | null>(null);
  const [onboardingSteps, setOnboardingSteps] = useState<OnboardingStep[] | null>(null);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [integrations, setIntegrations] = useState<UserIntegrations | null>(null);
  const [integrationError, setIntegrationError] = useState(false);

  const dismissCallbackMessage = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("error");
    next.delete("warning");
    setSearchParams(next, { replace: true });
  };

  useMountEffect(() => {
    // Integrations data gates the whole page, so its failure is fatal. The GitHub
    // install URL only feeds the install/manage-access links, so fetch it
    // independently and treat its failure as non-fatal — a failed install-url
    // request shouldn't hide the connected-accounts list.
    import("../../api/integrations")
      .then(({ fetchUserIntegrations }) => fetchUserIntegrations())
      .then(setIntegrations)
      .catch((error) => {
        console.error("Failed to fetch integrations data", error);
        setIntegrationError(true);
      });
    import("../../api/repos")
      .then(({ fetchInstallUrl }) => fetchInstallUrl())
      .then(setInstallUrl)
      .catch((error) => {
        console.error("Failed to fetch GitHub install URL", error);
      });
  });

  useSyncEffect(() => {
    if (!user) return;
    let cancelled = false;
    setGithubSummary(null);
    setGithubSummaryLoaded(false);
    setGithubSummaryError(null);

    fetchMyGithubIntegrationSummary()
      .then((summary) => {
        if (cancelled) return;
        setGithubSummary(summary);
        setGithubSummaryLoaded(true);
      })
      .catch((error) => {
        console.error("Failed to load GitHub integration summary", error);
        if (cancelled) return;
        setGithubSummary(null);
        setGithubSummaryError("GitHub connection health is temporarily unavailable.");
        setGithubSummaryLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  useSyncEffect(() => {
    if (!user) return;
    if (!hasBusinessMembership) {
      setOnboardingSteps([]);
      setOnboardingError(null);
      return;
    }
    let cancelled = false;
    setOnboardingSteps(null);
    setOnboardingError(null);

    import("../../api/onboarding")
      .then(({ fetchOnboardingStatus }) =>
        fetchOnboardingStatus({
          owner: githubRepoContext?.owner ?? null,
          repo: githubRepoContext?.repo ?? null,
          setup: githubSetupComplete ? "complete" : null,
        }),
      )
      .then((steps) => {
        if (!cancelled) setOnboardingSteps(steps);
      })
      .catch((error) => {
        console.error("Failed to fetch onboarding status", error);
        if (!cancelled) setOnboardingError("Failed to load GitHub readiness. Please refresh the page.");
      });

    return () => {
      cancelled = true;
    };
  }, [user?.id, hasBusinessMembership, githubRepoContext?.fullName, githubSetupComplete]);

  // Render the OAuth callback banner even during loading/error states so that
  // a user who lands here straight from an OAuth redirect always sees the
  // outcome, regardless of how the integrations fetch resolves.
  const hasBanner = Boolean(callbackMessage || jiraSiteSelectionNonce);
  const banner = hasBanner ? (
    <>
      {callbackMessage ? <CallbackBanner message={callbackMessage} onDismiss={dismissCallbackMessage} /> : null}
      {jiraSiteSelectionNonce ? (
        <JiraSitePicker nonce={jiraSiteSelectionNonce} onDone={handleJiraSitePickerDone} />
      ) : null}
    </>
  ) : null;

  if (!user) return banner ? <div className="space-y-6">{banner}</div> : null;
  if (integrationError) {
    return (
      <div className="space-y-6">
        {banner}
        <p className="text-sm text-error">Failed to load integrations. Please refresh the page.</p>
      </div>
    );
  }
  if (!integrations) {
    return banner ? <div className="space-y-6">{banner}</div> : null;
  }

  const available = new Set(integrations.availableIntegrations);
  const githubBlockingStep =
    hasBusinessMembership && onboardingSteps
      ? (onboardingSteps.find(
          (step) => step.id.startsWith("github_") && step.status !== ONBOARDING_STEP_STATUS.CONNECTED,
        ) ?? null)
      : null;
  const githubRemediation = !hasBusinessMembership
    ? ({
        tone: "error",
        title: "Access unavailable",
        description: "Contact your administrator.",
      } satisfies GithubRemediation)
    : githubBlockingStep
      ? getGithubRemediation(githubBlockingStep, githubRepoContext)
      : null;
  const githubLifecycleRemediation = getGithubLifecycleRemediation(githubSummary);
  const githubStatusRemediation = githubRemediation ?? githubLifecycleRemediation;

  const connectedMap: Record<PersonalOauthRowId, boolean> = {
    linear: user.linearConnected,
    jira: user.jiraConnected,
    notion: user.notionConnected,
    slack: user.slackConnected,
  };

  const needsReconnectMap: Record<PersonalOauthRowId, boolean> = {
    linear: false,
    jira: false,
    notion: false,
    slack: user.slackNeedsReconnect,
  };

  const disconnectMap: Record<PersonalOauthRowId, () => Promise<void>> = {
    linear: async () => {
      const { disconnectLinear } = await import("../../api/auth");
      await disconnectLinear();
      clearRememberedPersonalIntegration(user.id, "linear");
      onLinearChange(false);
    },
    jira: async () => {
      const { disconnectJira } = await import("../../api/auth");
      await disconnectJira();
      clearRememberedPersonalIntegration(user.id, "jira");
      onJiraChange(false);
    },
    notion: async () => {
      const { disconnectNotion } = await import("../../api/auth");
      await disconnectNotion();
      clearRememberedPersonalIntegration(user.id, "notion");
      onNotionChange(false);
    },
    slack: async () => {
      const { disconnectSlack } = await import("../../api/auth");
      await disconnectSlack();
      clearRememberedPersonalIntegration(user.id, "slack");
      onSlackChange(false);
    },
  };

  function isDisabledByAdmin(integrationId: string): boolean {
    return !available.has(integrationId);
  }

  const enabledOauthRows = USER_OAUTH_INTEGRATION_IDS.filter(
    (id) => !isDisabledByAdmin(id) && isCustomerFacingIntegration(id),
  );
  const oauthRows: PersonalOauthRowId[] = available.has("slack") ? enabledOauthRows : [...enabledOauthRows, "slack"];
  const serviceNameClasses = "text-[22px] leading-[1.1] text-text-primary font-display";
  const statusClasses = "text-base leading-relaxed text-text-secondary";
  const metaClasses = "text-sm leading-relaxed text-text-muted";

  const currentHealthByIntegration = integrations.currentHealth ?? {};
  const rawGithubCurrentHealth = currentHealthByIntegration.github;
  const githubCurrentHealth = getCurrentHealthCopy(currentHealthByIntegration.github);
  const githubHealthLine =
    hasBusinessMembership &&
    githubSummaryLoaded &&
    githubSummary?.status !== "passed" &&
    rawGithubCurrentHealth?.state !== "healthy" &&
    githubCurrentHealth
      ? `${githubCurrentHealth.text}${githubCurrentHealth.detail ? `: ${githubCurrentHealth.detail}` : ""}`
      : null;
  const showGithubDiagnosticsLink = hasBusinessMembership && githubSummaryLoaded && githubSummary?.status === "failed";

  return (
    <div className="editorial-fade space-y-6">
      <SettingsPageHeader
        eyebrow="Connected accounts"
        title="Connected accounts"
        description="Connect your GitHub, Linear, Jira, Notion, and Slack accounts so Cycloid can act on your behalf."
      />
      {banner}
      {onboardingError && <p className="text-sm text-error">{onboardingError}</p>}

      <ul className="border-t border-border divide-y divide-border">
        {/* GitHub (always available) */}
        <li className="py-6">
          <div className="flex items-start justify-between gap-6">
            <div className="flex-1 min-w-0">
              <h3 className={serviceNameClasses} style={{ fontVariationSettings: "normal" }}>
                GitHub
              </h3>
              <p className={`mt-2 ${statusClasses}`}>Connected as @{user.login}</p>

              {hasBusinessMembership && githubRepoContext && (
                <p className={`mt-1 ${metaClasses}`}>
                  Default repository <span className="font-mono-tabular">{githubRepoContext.fullName}</span>
                </p>
              )}
              {hasBusinessMembership && !githubRepoContext && onboardingSteps && !onboardingError && (
                <p className={`mt-1 ${metaClasses}`}>No default repository set.</p>
              )}
              {hasBusinessMembership && !githubRepoContext && !onboardingSteps && !onboardingError && (
                <p className={`mt-1 ${metaClasses}`}>Checking GitHub readiness…</p>
              )}

              {githubHealthLine ? (
                <p className={`mt-1 text-sm leading-relaxed ${githubCurrentHealth?.className ?? "text-warning"}`}>
                  {githubHealthLine}
                  {showGithubDiagnosticsLink ? (
                    <>
                      {" "}
                      <a href="/settings/diagnostics" className="underline underline-offset-2 hover:text-accent">
                        View diagnostics
                      </a>
                    </>
                  ) : null}
                </p>
              ) : null}
              {hasBusinessMembership && githubSummaryError && (
                <p className={`mt-1 text-sm leading-relaxed text-warning`}>{githubSummaryError}</p>
              )}
              {githubReauthError && <p className="mt-1 text-sm text-error">{githubReauthError}</p>}

              {hasBusinessMembership &&
                installUrl &&
                !githubBlockingStep &&
                !githubLifecycleRemediation?.actionLabel && (
                  <a
                    href={installUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-3 inline-flex text-sm text-accent underline underline-offset-2 transition-colors duration-150 hover:text-text-primary"
                  >
                    Manage repository access
                  </a>
                )}

              {githubStatusRemediation && !onboardingError && (
                <div
                  className={`editorial-fade mt-3 border px-3 py-2 ${getGithubRemediationClasses(githubStatusRemediation)}`}
                >
                  <p className="text-sm font-medium">{githubStatusRemediation.title}</p>
                  <p className="mt-1 text-sm opacity-90">{githubStatusRemediation.description}</p>
                  {githubStatusRemediation.actionLabel && installUrl && (
                    <a
                      href={installUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2 inline-flex text-sm font-medium underline underline-offset-2"
                    >
                      {githubStatusRemediation.actionLabel}
                    </a>
                  )}
                </div>
              )}
            </div>
            <Button
              type="button"
              size="sm"
              onClick={async () => {
                if (
                  !(await confirm({
                    title: "Re-authorize GitHub?",
                    message:
                      "This logs you out and revokes your GitHub connection. Active sessions will lose GitHub access, and you'll need to log in again and reselect the correct org.",
                    confirmLabel: "Re-authorize",
                    destructive: true,
                  }))
                ) {
                  return;
                }
                setGithubReauthing(true);
                setGithubReauthError(null);
                window.location.href = "/auth/github/reauthorize";
              }}
              disabled={githubReauthing}
            >
              Re-authorize
            </Button>
          </div>
        </li>

        {/* Other personal OAuth integrations */}
        {oauthRows.map((id) => {
          const connected = connectedMap[id];
          const linked = id === "slack" && user.slackLinked === true;
          const scope = integrations.integrationScopes[id];
          const rawCurrentHealth = currentHealthByIntegration[id];
          const lifecycleReconnectRequired =
            id !== "slack" &&
            connected &&
            rawCurrentHealth?.state === "disconnected" &&
            rawCurrentHealth.source === "lifecycle" &&
            scope !== "business";
          const needsReconnect = needsReconnectMap[id] || lifecycleReconnectRequired;
          const suppressDisconnectedHealth =
            rawCurrentHealth?.state === "disconnected" &&
            ((!connected && !linked) || (id === "slack" && connected && !needsReconnectMap[id]));
          const currentHealth = getCurrentHealthCopy(suppressDisconnectedHealth ? undefined : rawCurrentHealth);
          const label = id === "slack" ? "Slack" : INTEGRATION_DISPLAY_NAMES[id];
          return (
            <li key={id} className="py-6">
              <div className="flex items-start justify-between gap-6">
                <div className="flex-1 min-w-0">
                  <h3 className={serviceNameClasses} style={{ fontVariationSettings: "normal" }}>
                    {label}
                  </h3>
                  <p className={`mt-2 ${needsReconnect ? "text-base leading-relaxed text-warning" : statusClasses}`}>
                    {needsReconnect
                      ? "Reconnect required"
                      : connected
                        ? "Connected"
                        : linked
                          ? "Linked - @Cycloid works"
                          : "Not connected"}
                  </p>
                  {needsReconnect && id === "slack" && (
                    <p className={`mt-1 ${metaClasses}`}>Search and thread reading need a refreshed token.</p>
                  )}
                  {/* Strict false check: undefined means the cached /auth/me
                      response predates the field, not that no install exists. */}
                  {id === "slack" &&
                    user.slackWorkspaceInstalled === false &&
                    (capabilities?.canManageBusinessIntegrations ? (
                      <p className={`mt-1 ${metaClasses}`}>
                        Workspace install required first.{" "}
                        <a
                          href={SLACK_WORKSPACE_INSTALL_URL}
                          className="text-accent underline underline-offset-2 hover:opacity-80"
                        >
                          Install Cycloid in Slack →
                        </a>
                      </p>
                    ) : (
                      <p className={`mt-1 ${metaClasses}`}>Ask an admin to install Cycloid in Slack first.</p>
                    ))}
                  {id === "jira" && connected && user.jiraSiteName && (
                    <p className={`mt-1 ${metaClasses}`}>Site: {user.jiraSiteName}</p>
                  )}
                  {currentHealth && (
                    <p className={`mt-1 text-sm leading-relaxed ${currentHealth.className}`}>
                      {currentHealth.text}
                      {currentHealth.detail ? `: ${currentHealth.detail}` : ""}
                    </p>
                  )}
                  {linked && !connected && id === "slack" && capabilities?.canManageBusinessIntegrations === false && (
                    <p className={`mt-1 ${metaClasses}`}>Enabling Slack search may require a workspace owner.</p>
                  )}
                </div>
                {needsReconnect ? (
                  <a href={OAUTH_CONNECT_URL[id]} className={buttonClasses({ variant: "secondary", size: "sm" })}>
                    Reconnect
                  </a>
                ) : connected ? (
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    onClick={async () => {
                      if (
                        !(await confirm({
                          title: `Disconnect ${label}?`,
                          message: `Cycloid loses access to your ${label} account until you reconnect it. Active sessions using it may fail.`,
                          confirmLabel: "Disconnect",
                          destructive: true,
                        }))
                      ) {
                        return;
                      }
                      await disconnectMap[id]();
                    }}
                  >
                    Disconnect
                  </Button>
                ) : linked && id === "slack" ? (
                  <a href={OAUTH_CONNECT_URL[id]} className={buttonClasses({ variant: "secondary", size: "sm" })}>
                    Enable Slack search (optional)
                  </a>
                ) : (
                  <a href={OAUTH_CONNECT_URL[id]} className={buttonClasses({ variant: "secondary", size: "sm" })}>
                    Connect
                  </a>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
