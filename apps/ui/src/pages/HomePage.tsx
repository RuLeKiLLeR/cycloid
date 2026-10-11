import {
  type Dispatch,
  type MutableRefObject,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useSearchParams } from "react-router";

import {
  ONBOARDING_REASON_CODES,
  ONBOARDING_STEP_STATUS,
  type OnboardingStepStatus,
} from "../../../../shared/constants/onboarding";
import { fetchOnboardingStatus } from "../api/onboarding";
import { fetchSessionPrerequisites, type SessionPrerequisites } from "../api/sessions";
import { updateSettings } from "../api/settings";
import { fetchRepoSkills } from "../api/skills";
import { HeroNoticeStack } from "../components/home/HeroNoticeStack";
import { useLayoutContext } from "../components/Layout";
import { PromptForm, type PromptFormHandle } from "../components/PromptForm";
import { PublicLoginShell } from "../components/PublicLoginShell";
import { SearchableSelectChip } from "../components/SearchableSelectChip";
import { SsoOrgsNotice } from "../components/SsoOrgsNotice";
import { useToast } from "../components/Toast";
import { Button, buttonClasses } from "../components/ui";
import { useAuthenticatedTitle } from "../hooks/useAuthenticatedTitle";
import { useMountEffect, useSyncEffect } from "../hooks/useEffects";
import type { PlanModeSetting, UserSettings, UserSettingsUpdate } from "../types";
import { getDisconnectedPersonalIntegrationWarnings } from "../utils/integration-disconnect-warning";
import { beginLatestRequest, isLatestRequest } from "../utils/latestRequest";
import {
  buildModelOptions,
  findModelOption,
  getDefaultReasoningEffortForModel,
  getReasoningEffortsForModel,
} from "../utils/models";
import { parseRepoFullNameFromUrl } from "../utils/repos";

// Blocking reason codes the user can resolve themselves on the Model API keys
// page. Business-managed / integration-disabled blocks need an admin instead,
// so those fall back to a generic Settings link.
const USER_FIXABLE_MODEL_KEY_REASONS: ReadonlySet<string> = new Set([
  ONBOARDING_REASON_CODES.CREDENTIALS_MISSING,
  ONBOARDING_REASON_CODES.CREDENTIALS_INVALID,
  ONBOARDING_REASON_CODES.CREDENTIALS_PRESENT,
]);

export async function persistPlanModeToggle({
  next,
  previous,
  setSettings,
  persist,
  onError,
  requestSequenceRef,
}: {
  next: PlanModeSetting;
  previous: PlanModeSetting;
  setSettings: Dispatch<SetStateAction<UserSettings | null>>;
  persist: (patch: UserSettingsUpdate) => Promise<UserSettings>;
  onError: () => void;
  requestSequenceRef: MutableRefObject<number>;
}): Promise<void> {
  const sequence = beginLatestRequest(requestSequenceRef);
  setSettings((current) => (current ? { ...current, planMode: next } : current));
  try {
    const updated = await persist({ planMode: next });
    if (!isLatestRequest(requestSequenceRef, sequence)) return;
    setSettings(updated);
  } catch {
    if (!isLatestRequest(requestSequenceRef, sequence)) return;
    setSettings((current) => (current ? { ...current, planMode: previous } : current));
    onError();
  }
}

export function getNextPlanModeSetting(current: PlanModeSetting): PlanModeSetting {
  if (current === "off") return "auto";
  if (current === "auto") return "on";
  return "off";
}

// Each suggestion is complete enough to launch as-is through the normal guarded
// session-submit path.
const STARTER_PROMPTS: readonly { label: string; prompt: string }[] = [
  {
    label: "Find a small bug",
    prompt: "Find and fix one small, high-confidence bug in this repository. Add a focused regression test.",
  },
  {
    label: "Fix a flaky test",
    prompt: "Find and fix one high-confidence source of test flakiness. Verify the affected test repeatedly.",
  },
  {
    label: "Fix N+1 queries",
    prompt: "Audit the codebase for N+1 queries and fix the highest-impact confirmed instance with focused coverage.",
  },
];

export function HomeHeroLayout({
  heading,
  notices,
  composer,
  children,
}: {
  heading: ReactNode;
  notices: ReactNode;
  composer: ReactNode;
  children: ReactNode;
}) {
  // Dashboard hero choreography (the playbook's five-beat exception): heading
  // leads, notices and composer follow, the tray and session queues close.
  return (
    <div className="mx-auto w-full max-w-[58rem]">
      <h1 className="editorial-rise editorial-rise-1 mb-6 text-center font-display text-3xl text-text-primary">
        {heading}
      </h1>
      {notices}
      <div data-testid="home-composer" className="editorial-rise editorial-rise-3 relative z-10">
        {composer}
      </div>
      {children}
    </div>
  );
}

function StarterPromptTray({ disabled, onSelect }: { disabled: boolean; onSelect: (prompt: string) => void }) {
  return (
    <div className="editorial-rise editorial-rise-4 mt-4 flex flex-wrap items-center justify-center gap-2">
      {/* Inline with same-size sans buttons, so it shares their family — an
          eyebrow here would switch fonts mid-group (DESIGN.md grouping rule). */}
      <span className="text-sm text-text-muted">Try</span>
      {STARTER_PROMPTS.map(({ label, prompt }) => (
        <Button key={label} variant="ghost" size="sm" disabled={disabled} onClick={() => onSelect(prompt)}>
          {label}
        </Button>
      ))}
    </div>
  );
}

export function HomePage() {
  const {
    user,
    capabilities,
    repos,
    reposLoaded,
    reposError,
    ssoOrgs,
    userFreshValidated,
    refreshingRepos,
    refreshRepos,
    selectedRepo,
    setSelectedRepo,
    selectedRepoFreshValidated,
    settings,
    setSettings,
    models,
    selectedModel,
    selectModelForNewSession,
    creating,
    handleNewSessionPrompt,
    loadFilesForHomePage,
  } = useLayoutContext();
  const toast = useToast();
  const [installUrl, setInstallUrl] = useState<string | null>(null);
  // Source of truth for the setup pill below. We avoid `models[].hasApiKey`
  // because the local-dev shim (bootstrap.ts) flips it true off the wrangler
  // env var, masking the fact that the user hasn't actually added a key.
  const [modelKeyStatus, setModelKeyStatus] = useState<OnboardingStepStatus | null>(null);
  // Pre-flight credential gate. Source of truth: the same backend evaluator
  // session-create will run, so a disabled submit reflects exactly what would
  // happen on submit. Local-dev env keys count here (the backend honors them),
  // even though the chip above still nags via the strict onboarding status.
  const [sessionPrereqs, setSessionPrereqs] = useState<SessionPrerequisites | null>(null);
  const planModeRequestSequence = useRef(0);
  const promptFormRef = useRef<PromptFormHandle>(null);
  const modelOptions = useMemo(() => buildModelOptions(models), [models]);
  const selectedModelOption = useMemo(
    () =>
      selectedModel
        ? modelOptions.find(
            (option) => option.providerID === selectedModel.providerID && option.modelID === selectedModel.modelID,
          )
        : undefined,
    [modelOptions, selectedModel],
  );
  const selectedRepoLabel = useMemo(() => {
    if (!selectedRepo) return "Repository";
    const parts = selectedRepo.fullName.split("/");
    return parts.length > 1 ? parts[1] : selectedRepo.fullName;
  }, [selectedRepo]);
  const selectedModelLabel = useMemo(() => {
    if (selectedModelOption) return selectedModelOption.label;
    if (!selectedModel) return "Model";
    return findModelOption(models, selectedModel)?.label ?? selectedModel.modelID;
  }, [models, selectedModel, selectedModelOption]);
  const reasoningEfforts = useMemo(() => getReasoningEffortsForModel(models, selectedModel), [models, selectedModel]);
  const defaultReasoningEffort = useMemo(
    () => getDefaultReasoningEffortForModel(models, selectedModel),
    [models, selectedModel],
  );
  const [searchParams, setSearchParams] = useSearchParams();
  // Onboarding-wizard task templates arrive as ?template=...; seed the
  // composer once on mount and keep the URL otherwise untouched.
  const templatePromptRef = useRef(searchParams.get("template"));
  const templatePrompt = templatePromptRef.current;
  const isSupportView = Boolean(user?.impersonation?.readOnly);

  useMountEffect(() => {
    fetchOnboardingStatus()
      .then((steps) => {
        const step = steps.find((s) => s.id === "openai_key");
        setModelKeyStatus(step?.status ?? ONBOARDING_STEP_STATUS.NOT_CONNECTED);
      })
      // Soft-fail: if the fetch errors the pill stays hidden rather than
      // flashing a wrong "missing key" warning.
      .catch(() => {});
  });

  // Refetch the credential-gate prereq whenever the chosen model changes —
  // anthropic vs openai may resolve different credentials, so a model switch
  // can flip canStartSession.
  useSyncEffect(() => {
    const modelId = selectedModel?.modelID;
    if (!modelId) {
      setSessionPrereqs(null);
      return;
    }
    let cancelled = false;
    // Clear the stale answer so the submit button doesn't pretend an old
    // credential gate still applies while the refetch is in flight (e.g.
    // switching from a model with a key to one without).
    setSessionPrereqs(null);
    fetchSessionPrerequisites(modelId)
      .then((result) => {
        if (!cancelled) setSessionPrereqs(result);
      })
      // Soft-fail: leave the previous answer in place. The backend gate is
      // still the ultimate enforcer; the UI just won't pre-empt the click.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedModel?.modelID]);

  useSyncEffect(() => {
    // The ref above captured the template; strip the param so back-navigation
    // to this URL doesn't re-seed the composer (mirrors setup/sso cleanup).
    if (!searchParams.has("template")) return;
    searchParams.delete("template");
    setSearchParams(searchParams, { replace: true });
  }, [searchParams, setSearchParams]);

  useSyncEffect(() => {
    // Fetch the install URL when the user has no repos (always) or has repos but
    // no install URL resolved yet.
    if (user && reposLoaded && (repos.length === 0 || !installUrl)) {
      import("../api/repos").then(({ fetchInstallUrl }) =>
        fetchInstallUrl()
          .then(setInstallUrl)
          .catch(() => {}),
      );
    }
  }, [user, reposLoaded, repos.length, installUrl]);

  useAuthenticatedTitle(user === null ? "Sign in — Cycloid" : "Cycloid");

  const modelSelectDisabled = modelOptions.length === 0;
  const modelRequired = !modelSelectDisabled;
  const selectedModelUnavailable =
    modelRequired && !!selectedModel && (!selectedModelOption || !!selectedModelOption.disabled);
  const missingSubmitSelections = [
    selectedRepo ? null : "repository",
    modelRequired && (!selectedModel || selectedModelUnavailable) ? "model" : null,
  ].filter((value): value is string => value !== null);
  const sessionBlocked = sessionPrereqs?.canStartSession === false;
  const sessionBlockedMissingKey =
    sessionBlocked && USER_FIXABLE_MODEL_KEY_REASONS.has(sessionPrereqs?.blocking?.reasonCode ?? "");
  const submitDisabledReason =
    selectedModelUnavailable && selectedModelOption?.disabledReason
      ? selectedModelOption.disabledReason
      : selectedRepo && !selectedRepoFreshValidated
        ? "Repository access is still refreshing. Try again in a moment."
        : missingSubmitSelections.length === 2
          ? "Pick a repository and model to send prompt"
          : missingSubmitSelections.length === 1
            ? `Pick a ${missingSubmitSelections[0]} to send prompt`
            : sessionBlocked
              ? sessionBlockedMissingKey
                ? "Add a model API key in Settings to send prompt"
                : "Finish setup in Settings to send prompt"
              : undefined;
  const repoRequiresAttention = !selectedRepo || !selectedRepoFreshValidated;
  const modelRequiresAttention = modelRequired && (!selectedModel || selectedModelUnavailable);
  const disconnectedIntegrationWarnings = useMemo(
    () => (user && userFreshValidated ? getDisconnectedPersonalIntegrationWarnings(user) : []),
    [user, userFreshValidated],
  );
  const missingDefaultRepo =
    settings !== null &&
    reposLoaded &&
    (!settings.defaultRepo || !repos.some((repo) => repo.fullName === settings.defaultRepo));
  const missingModelKey =
    modelKeyStatus !== null &&
    modelKeyStatus !== ONBOARDING_STEP_STATUS.CONNECTED &&
    modelKeyStatus !== ONBOARDING_STEP_STATUS.BUSINESS_MANAGED;
  const showSetupNotice = missingDefaultRepo || missingModelKey;

  async function handleHomePromptSubmit(payload: Parameters<typeof handleNewSessionPrompt>[0]) {
    if (!selectedRepo) throw new Error("Pick a repository to send prompt");
    if (!selectedRepoFreshValidated) throw new Error("Repository access is still refreshing. Try again in a moment.");
    if (modelRequired && (!selectedModel || selectedModelUnavailable)) {
      throw new Error(selectedModelOption?.disabledReason ?? "Pick a model to send prompt");
    }
    await handleNewSessionPrompt(payload);
  }

  function handleStarterPromptSelect(prompt: string) {
    if (creating || submitDisabledReason) return;
    void promptFormRef.current?.submitPrompt(prompt);
  }

  const loadSkillsForHomePage = useCallback(async () => {
    if (!selectedRepoFreshValidated) return [];
    if (!selectedRepo) return [];
    const parsed = parseRepoFullNameFromUrl(selectedRepo.fullName);
    if (!parsed) return [];
    return fetchRepoSkills(parsed.owner, parsed.repo);
  }, [selectedRepo, selectedRepoFreshValidated]);

  const planModeAvailable = capabilities?.planApproval === true;
  const planModeSetting = settings?.planMode ?? "off";
  const handleTogglePlanMode = useCallback(() => {
    const previous = settings?.planMode ?? "off";
    void persistPlanModeToggle({
      next: getNextPlanModeSetting(previous),
      previous,
      setSettings,
      persist: updateSettings,
      onError: () => toast("Couldn't update plan mode. Please try again.", { variant: "error" }),
      requestSequenceRef: planModeRequestSequence,
    });
  }, [settings, setSettings, toast]);

  // --- Signed out ---
  if (user === null) {
    return <PublicLoginShell />;
  }

  if (user === undefined) {
    return (
      <div className="flex h-full w-full items-center justify-center px-4" aria-hidden>
        <div className="w-full max-w-3xl motion-safe:animate-pulse">
          <div className="mx-auto h-7 w-2/3 max-w-md rounded bg-surface-2" />
          <div className="mt-8 h-28 w-full rounded-lg bg-surface-2" />
          <div className="mt-3 flex justify-center gap-2">
            <div className="h-7 w-24 bg-surface-2" />
            <div className="h-7 w-20 bg-surface-2" />
          </div>
        </div>
      </div>
    );
  }

  // --- Authenticated empty state: no repos connected ---
  // When every accessible repo lives behind an SSO-withheld org, `repos` is
  // empty but the dropdown below never renders, so the SSO prompt must live here
  // (before the generic connect-repository copy) or it would never be seen.
  if (user && reposLoaded && repos.length === 0) {
    if (isSupportView) {
      return (
        <div className="mx-auto max-w-3xl px-4 pt-8 md:pt-14">
          <p className="eyebrow mb-4">Read only</p>
          <h1 className="font-display-tight text-4xl text-text-primary mb-4">Support view is active.</h1>
          <p className="text-sm text-text-secondary">Select a customer session from the sidebar.</p>
        </div>
      );
    }

    // When orgs are withheld behind SSO the blocker is authorization, not a
    // missing app install — the wizard's install step would mislead.
    if (ssoOrgs.length > 0) {
      return (
        <div className="max-w-3xl mx-auto px-4 pt-8 md:pt-14">
          <div className="editorial-rise editorial-rise-1">
            <h1 className="font-display-tight text-3xl text-text-primary mb-4">Authorize SSO</h1>
            <p className="text-base text-text-secondary leading-relaxed max-w-xl mb-8">
              Authorize your organization&apos;s SSO, then refresh.
            </p>
          </div>
          <SsoOrgsNotice ssoOrgs={ssoOrgs} onRefresh={refreshRepos} refreshing={refreshingRepos} className="mb-8" />
          {reposError && <p className="text-sm text-error mb-4 font-mono-tabular">{reposError}</p>}
        </div>
      );
    }

    return (
      <div className="mx-auto max-w-3xl px-4 pt-8 md:pt-14">
        <div className="editorial-rise editorial-rise-1">
          <h1 className="font-display-tight text-3xl text-text-primary mb-4">Connect a repository</h1>
          <p className="text-base text-text-secondary leading-relaxed max-w-xl mb-6">
            Install GitHub access for the repos Cycloid should use.
          </p>
          {installUrl ? (
            <a href={installUrl} target="_blank" rel="noopener noreferrer" className={buttonClasses()}>
              Install GitHub access
            </a>
          ) : (
            <Link to="/settings/integrations" className={buttonClasses()}>
              Open integrations
            </Link>
          )}
        </div>
      </div>
    );
  }

  const showComposer = !isSupportView && (repos.length > 0 || !reposLoaded);

  // --- Authenticated ---
  const hasHeroNotice =
    ssoOrgs.length > 0 ||
    showSetupNotice ||
    disconnectedIntegrationWarnings.length > 0 ||
    Boolean(reposError && user) ||
    sessionBlocked;

  return (
    <div className="control-room-canvas control-room-page flex h-full min-h-full flex-col">
      {isSupportView && (
        <div className="mx-auto max-w-3xl px-4 pt-8 md:pt-14 text-center">
          <p className="eyebrow mb-4">Read only</p>
          <h1 className="font-display-tight text-4xl text-text-primary mb-4">Support view is active.</h1>
          <p className="text-sm text-text-secondary">Select a customer session from the sidebar.</p>
        </div>
      )}

      {showComposer && (
        <>
          <div className="control-room-content flex flex-1 flex-col justify-center">
            <HomeHeroLayout
              heading={`Hey, ${user.name?.split(" ")[0] || user.login}. What should Cycloid build?`}
              notices={
                hasHeroNotice ? (
                  <div
                    data-testid="home-hero-notices"
                    className="editorial-rise editorial-rise-2 mb-6 flex w-full max-w-[58rem] flex-col gap-3"
                  >
                    <HeroNoticeStack
                      ssoOrgs={ssoOrgs}
                      onRefreshRepos={refreshRepos}
                      refreshingRepos={refreshingRepos}
                      missingDefaultRepo={missingDefaultRepo}
                      missingModelKey={missingModelKey}
                      disconnectedIntegrationWarnings={disconnectedIntegrationWarnings}
                    />
                    {reposError && user && (
                      <p className="text-center font-mono-tabular text-sm text-error">{reposError}</p>
                    )}
                    {sessionBlocked && <SessionBlockedNotice missingModelKey={sessionBlockedMissingKey} />}
                  </div>
                ) : null
              }
              composer={
                <PromptForm
                  ref={promptFormRef}
                  lifecycle={{ phase: "idle" }}
                  variant="chat"
                  onSubmit={handleHomePromptSubmit}
                  loadFiles={selectedRepo && selectedRepoFreshValidated ? loadFilesForHomePage : undefined}
                  loadSkills={selectedRepo && selectedRepoFreshValidated ? loadSkillsForHomePage : undefined}
                  busyLabel={creating ? "Starting session…" : undefined}
                  placeholder="Describe what you want Cycloid to build…"
                  initialValue={templatePrompt ?? undefined}
                  reasoningEfforts={reasoningEfforts}
                  defaultReasoningEffort={defaultReasoningEffort}
                  submitDisabledReason={submitDisabledReason}
                  planModeAvailable={planModeAvailable}
                  planMode={planModeSetting}
                  onTogglePlanMode={handleTogglePlanMode}
                  takeoverRepoUrl={selectedRepo?.url}
                  leadingChips={
                    <>
                      <span
                        className="inline-flex"
                        aria-busy={!reposLoaded}
                        aria-label={!reposLoaded ? "Loading repositories" : undefined}
                      >
                        <SearchableSelectChip
                          id="home-repo-select"
                          ariaLabel="Repository"
                          label={selectedRepo ? selectedRepoLabel : "Repository"}
                          selectedLabel={selectedRepo ? selectedRepo.url : "Repository"}
                          value={selectedRepo?.url ?? ""}
                          disabled={!reposLoaded}
                          placeholderActive={!selectedRepo}
                          requiresAttention={repoRequiresAttention}
                          onChange={(next) => {
                            if (next === "__add_repos__") {
                              if (installUrl) window.open(installUrl, "_blank", "noopener,noreferrer");
                              return false;
                            }
                            const repo = repos.find((r) => r.url === next) ?? null;
                            if (repo) setSelectedRepo(repo);
                          }}
                          // No disabled placeholder row: the search field anchors
                          // the open menu, and a first row styled like an option
                          // but unpickable reads as a broken choice.
                          options={[
                            ...repos.map((r) => ({
                              value: r.url,
                              label: `${r.fullName}${r.private ? " · private" : ""}`,
                            })),
                            ...(reposLoaded ? [{ value: "__add_repos__", label: "+ Add more repositories" }] : []),
                          ]}
                        />
                      </span>
                      <SearchableSelectChip
                        id="home-model-select"
                        ariaLabel="Model"
                        label={selectedModel ? selectedModelLabel : "Model"}
                        selectedLabel={selectedModel ? selectedModelLabel : "Model"}
                        value={selectedModelOption?.id ?? ""}
                        disabled={modelSelectDisabled}
                        placeholderActive={!selectedModel}
                        requiresAttention={modelRequiresAttention}
                        onChange={(next) => {
                          const option = modelOptions.find((candidate) => candidate.id === next);
                          if (!option || option.disabled) return;
                          selectModelForNewSession({ providerID: option.providerID, modelID: option.modelID });
                        }}
                        // Same as the repo chip: no disabled placeholder row.
                        options={[
                          ...modelOptions.map((option) => ({
                            value: option.id,
                            label: `${option.label}${option.disabledReason ? ` · ${option.disabledReason}` : ""}`,
                            disabled: option.disabled,
                            group: option.groupLabel,
                          })),
                        ]}
                      />
                    </>
                  }
                />
              }
            >
              {creating && (
                <p className="mt-3 flex items-center justify-center gap-2 text-base text-text-muted">
                  <span className="status-dot review-loop-breathe h-1.5 w-1.5 rounded-full bg-live" />
                  Creating session…
                </p>
              )}

              <StarterPromptTray disabled={creating || !!submitDisabledReason} onSelect={handleStarterPromptSelect} />
            </HomeHeroLayout>
          </div>
        </>
      )}
    </div>
  );
}

function SessionBlockedNotice({ missingModelKey, className }: { missingModelKey: boolean; className?: string }) {
  return (
    <div
      role="alert"
      className={`editorial-fade flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border border-warning-soft-border bg-warning-soft px-3 py-2 text-text-secondary ${className ?? ""}`}
    >
      <p className="min-w-0 text-sm">
        {missingModelKey
          ? "Add a model API key before starting a session."
          : "Finish setup in Settings before starting a session."}
      </p>
      <Link
        to={missingModelKey ? "/settings/api-keys" : "/settings"}
        className={buttonClasses({ size: "sm", className: "shrink-0" })}
      >
        {missingModelKey ? "Add model API key" : "Open settings"}
      </Link>
    </div>
  );
}
