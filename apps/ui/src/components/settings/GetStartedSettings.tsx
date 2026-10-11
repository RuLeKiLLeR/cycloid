import { useState } from "react";
import { Link } from "react-router";

import {
  ONBOARDING_STEP_STATUS,
  type OnboardingStep,
  type OnboardingStepId,
  type OnboardingStepStatus,
} from "../../../../../shared/constants/onboarding";
import { fetchUserIntegrations } from "../../api/integrations";
import { fetchOnboardingStatus } from "../../api/onboarding";
import { fetchInstallUrl } from "../../api/repos";
import { SLACK_WORKSPACE_INSTALL_URL } from "../../constants/integrations";
import { useMountEffect } from "../../hooks/useEffects";
import type { UserIntegrations } from "../../types";
import { CheckIcon, ChevronDownIcon } from "../icons";
import { useLayoutContext } from "../Layout";
import { Badge, type BadgeTone, buttonClasses } from "../ui";
import { SettingsPageHeader } from "./SettingsLayout";

// Steps a brand-new user works through in order, per docs/customer-first-login-guide.md.
// Steps 1 (sign-in) and 4 (api key) come from /api/onboarding/status. Steps 2 (install)
// and 3 (pick repos) are derived from `repos.length` instead, because the endpoint's
// app-install + repo-access checks need a `?owner=&repo=` query - which a brand-new
// user usually doesn't have yet, so it stays red even after a successful install.
// `default_repo` is UI-derived: there's no backend onboarding step for it,
// the status is computed locally from settings.defaultRepo against the visible
// repo list. Treating it as a slot id keeps it in the same checklist UI.
type StepSlotId = OnboardingStepId | "default_repo";

type StepSlot = {
  id: StepSlotId;
  title: string;
  body: string;
  doneCopy: string;
};

const STEP_SLOTS: StepSlot[] = [
  {
    id: "github_login",
    title: "Sign in with GitHub",
    body: "PRs are opened as you.",
    doneCopy: "Signed in.",
  },
  {
    id: "github_app_installed",
    title: "Install the GitHub App",
    body: "Install on the org or account that owns your repos.",
    doneCopy: "GitHub App installed.",
  },
  {
    id: "github_repo_access",
    title: "Pick the repositories",
    body: "Choose which repos Cycloid can use.",
    doneCopy: "{count} {noun} connected.",
  },
  {
    id: "default_repo",
    title: "Pick a default repository",
    body: "Slack mentions and Jira/Linear ticket triggers route to this repo when no other repo is named.",
    doneCopy: "Default repo: {repo}.",
  },
  {
    id: "openai_key",
    title: "Add a model API key",
    body: "Bring your own key for the agent's model.",
    doneCopy: "Model key saved.",
  },
];

type Pill = { label: string; tone: "done" | "todo" | "warning" | "managed" };

function pillForStatus(status: OnboardingStepStatus): Pill {
  switch (status) {
    case ONBOARDING_STEP_STATUS.CONNECTED:
      return { label: "Done", tone: "done" };
    case ONBOARDING_STEP_STATUS.NEEDS_RECONNECT:
      return { label: "Reconnect", tone: "warning" };
    case ONBOARDING_STEP_STATUS.VALIDATION_FAILED:
      return { label: "Needs attention", tone: "warning" };
    case ONBOARDING_STEP_STATUS.BUSINESS_MANAGED:
      return { label: "Managed", tone: "managed" };
    case ONBOARDING_STEP_STATUS.DISABLED:
      return { label: "Disabled", tone: "managed" };
    case ONBOARDING_STEP_STATUS.LOOKUP_FAILED:
      return { label: "Check failed", tone: "warning" };
    default:
      return { label: "Required", tone: "todo" };
  }
}

const PILL_BADGE_TONES: Record<Pill["tone"], BadgeTone> = {
  done: "success",
  todo: "default",
  warning: "warning",
  managed: "default",
};

type Cta = { kind: "internal"; to: string; label: string } | { kind: "external"; href: string; label: string } | null;

// Every step except sign-in keeps a CTA even when done, so a user who wants to swap
// installations, change their default repo, or rotate a key can jump to that setting's
// canonical page without leaving the checklist. The editors themselves live on those
// pages; this page only shows status and links there.
export function ctaForStep(slotId: StepSlotId, status: OnboardingStepStatus, installUrl: string | null): Cta {
  const isManagedOrDisabled =
    status === ONBOARDING_STEP_STATUS.BUSINESS_MANAGED || status === ONBOARDING_STEP_STATUS.DISABLED;
  if (isManagedOrDisabled) return null;
  const isDone = status === ONBOARDING_STEP_STATUS.CONNECTED;

  switch (slotId) {
    case "github_login":
      if (isDone) return null;
      return { kind: "external", href: "/auth/github", label: "Sign in with GitHub" };
    case "github_app_installed":
      if (!installUrl) return null;
      return {
        kind: "external",
        href: installUrl,
        label: isDone ? "Manage installations" : "Install the GitHub App",
      };
    case "github_repo_access":
      if (!installUrl) return null;
      return {
        kind: "external",
        href: installUrl,
        label: isDone ? "Add or remove repos" : "Pick repositories",
      };
    case "openai_key":
      // Canonical home: the Model API keys page (managed/disabled already returned null).
      return {
        kind: "internal",
        to: "/settings/api-keys",
        label: isDone ? "Manage API keys" : "Add a model API key",
      };
    case "default_repo":
      // Canonical home: Preferences → Session defaults → Default repository.
      return {
        kind: "internal",
        to: "/settings/preferences",
        label: isDone ? "Change default repo" : "Choose default repo",
      };
    default:
      return null;
  }
}

function StepCard({
  index,
  slot,
  status,
  description,
  cta,
}: {
  index: number;
  slot: StepSlot;
  status: OnboardingStepStatus;
  description: string;
  cta: Cta;
}) {
  const isDone = status === ONBOARDING_STEP_STATUS.CONNECTED;
  const pill = pillForStatus(status);

  // When the step is already done, downplay the CTA so it reads as "manage" not "fix".
  const ctaClass = cta
    ? buttonClasses({ variant: isDone ? "ghost" : cta.kind === "internal" ? "primary" : "secondary", size: "md" })
    : "";

  return (
    <li className="group flex items-start gap-4 border border-border bg-surface-1 p-4 transition-colors duration-200 hover:border-border-hover">
      <span
        aria-hidden
        className={`mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center border text-base font-mono-tabular tabular-nums ${
          isDone
            ? "border-success-soft-border bg-success-soft text-success"
            : "border-border bg-surface-2 text-text-muted"
        }`}
      >
        {isDone ? <CheckIcon className="h-4 w-4" /> : index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3
            className="text-lg font-medium leading-snug text-text-primary"
            style={{ textWrap: "balance" } as React.CSSProperties}
          >
            {slot.title}
          </h3>
          <Badge tone={PILL_BADGE_TONES[pill.tone]} className="shrink-0">
            {pill.label}
          </Badge>
        </div>
        <p
          className="mt-1.5 text-base leading-relaxed text-text-secondary"
          style={{ textWrap: "pretty" } as React.CSSProperties}
        >
          {description}
        </p>
        {cta ? (
          <div className="mt-3">
            {cta.kind === "internal" ? (
              <Link to={cta.to} className={ctaClass}>
                {cta.label}
              </Link>
            ) : (
              <a href={cta.href} target="_blank" rel="noopener noreferrer" className={ctaClass}>
                {cta.label}
              </a>
            )}
          </div>
        ) : null}
      </div>
    </li>
  );
}

// Map the four user-facing slots to a final status, mixing the onboarding endpoint
// (which knows about sign-in + api key state) with the client-side repos signal
// (which is the cheapest, most accurate way to know "Cycloid can see at least one
// repo for you" without needing a selected repo).
function computeStatuses(args: {
  steps: OnboardingStep[] | null;
  reposLoaded: boolean;
  repoCount: number;
  defaultRepo: string | null;
  visibleRepoFullNames: Set<string>;
}): Record<StepSlotId, OnboardingStepStatus> {
  const { steps, reposLoaded, repoCount, defaultRepo, visibleRepoFullNames } = args;
  const fromEndpoint = new Map<OnboardingStepId, OnboardingStepStatus>();
  (steps ?? []).forEach((step) => fromEndpoint.set(step.id, step.status));

  const reposPicked = reposLoaded && repoCount > 0;
  // If repos haven't loaded, we don't want to flash "Required" pills for a moment.
  // Treat unknown as NOT_CONNECTED only after the layout's repo fetch resolves.
  const installStatus: OnboardingStepStatus = reposPicked
    ? ONBOARDING_STEP_STATUS.CONNECTED
    : ONBOARDING_STEP_STATUS.NOT_CONNECTED;

  // Only count the default as connected when it points at a repo we can actually
  // see. A stale default (repo removed from the install) would otherwise still
  // mark the step done while the Slack/Jira trigger keeps failing.
  const defaultRepoStatus: OnboardingStepStatus =
    reposLoaded && defaultRepo && visibleRepoFullNames.has(defaultRepo)
      ? ONBOARDING_STEP_STATUS.CONNECTED
      : ONBOARDING_STEP_STATUS.NOT_CONNECTED;

  return {
    github_login: fromEndpoint.get("github_login") ?? ONBOARDING_STEP_STATUS.CONNECTED,
    github_business_authorized: fromEndpoint.get("github_business_authorized") ?? ONBOARDING_STEP_STATUS.CONNECTED,
    github_app_installed: installStatus,
    github_repo_access: installStatus,
    default_repo: defaultRepoStatus,
    openai_key: fromEndpoint.get("openai_key") ?? ONBOARDING_STEP_STATUS.NOT_CONNECTED,
    linear_oauth: fromEndpoint.get("linear_oauth") ?? ONBOARDING_STEP_STATUS.NOT_CONNECTED,
  };
}

function describeStep(
  slot: StepSlot,
  status: OnboardingStepStatus,
  repoCount: number,
  defaultRepo: string | null,
): string {
  if (status !== ONBOARDING_STEP_STATUS.CONNECTED) return slot.body;
  if (slot.id === "github_repo_access") {
    const noun = repoCount === 1 ? "repository" : "repositories";
    return slot.doneCopy.replace("{count}", String(repoCount)).replace("{noun}", noun);
  }
  if (slot.id === "default_repo") {
    return slot.doneCopy.replace("{repo}", defaultRepo ?? "");
  }
  return slot.doneCopy;
}

// Optional "what's next" tiles shown beneath the required checklist. These are
// not gates; they read as suggestions. Each tile carries its own state so users
// can see at a glance which optional features they've already adopted.
type NextStepBadge = { label: string; tone: "neutral" | "active" } | null;

type NextStep = {
  key: string;
  eyebrow: string;
  title: string;
  body: string;
  cta:
    | { kind: "internal"; to: string; label: string }
    | { kind: "document"; href: string; label: string }
    | { kind: "external"; href: string; label: string };
  badge: NextStepBadge;
};

// Collapsible disclosure for each major group on the page. The required-setup
// section auto-collapses once everything's done so the page doesn't dwarf the
// "What's next" content. We track manual overrides separately so a user who
// re-opens a completed section keeps it open across re-renders.
function Section({
  id,
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  summary?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const contentId = `${id}-content`;
  return (
    <section>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={onToggle}
        className="btn-press group flex w-full items-center justify-between gap-3 py-2 text-left transition-colors duration-150"
      >
        <div className="flex min-w-0 items-baseline gap-3">
          <h2 className="text-xl font-medium text-text-primary">{title}</h2>
          {summary ? <span className="text-sm text-text-muted">{summary}</span> : null}
        </div>
        <ChevronDownIcon
          className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform duration-200 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      {/* Keep the region in the DOM even when collapsed so the button's
          aria-controls reference always resolves. Screen readers can then
          correctly announce the disclosure's expanded/collapsed state. */}
      <div id={contentId} className={open ? "mt-3" : ""} hidden={!open}>
        {children}
      </div>
    </section>
  );
}

function NextStepCard({ step }: { step: NextStep }) {
  const ctaClass = buttonClasses({ variant: "secondary", size: "md" });

  return (
    <li className="flex items-start gap-4 border border-border bg-surface-1 p-4 transition-colors duration-200 hover:border-border-hover">
      <div className="min-w-0 flex-1">
        <p className="eyebrow">{step.eyebrow}</p>
        <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3
            className="text-lg font-medium leading-snug text-text-primary"
            style={{ textWrap: "balance" } as React.CSSProperties}
          >
            {step.title}
          </h3>
          {step.badge ? (
            <Badge tone={step.badge.tone === "active" ? "success" : "default"} className="shrink-0">
              {step.badge.label}
            </Badge>
          ) : null}
        </div>
        <p
          className="mt-1.5 text-base leading-relaxed text-text-secondary"
          style={{ textWrap: "pretty" } as React.CSSProperties}
        >
          {step.body}
        </p>
        <div className="mt-3">
          {step.cta.kind === "internal" ? (
            <Link to={step.cta.to} className={ctaClass}>
              {step.cta.label}
            </Link>
          ) : step.cta.kind === "document" ? (
            <a href={step.cta.href} className={ctaClass}>
              {step.cta.label}
            </a>
          ) : (
            <a href={step.cta.href} target="_blank" rel="noopener noreferrer" className={ctaClass}>
              {step.cta.label}
            </a>
          )}
        </div>
      </div>
    </li>
  );
}

type GroupedNextSteps = { optional: NextStep[]; waysToUse: NextStep[] };

export function buildNextSteps(args: {
  linearConnected: boolean;
  slackConnected: boolean;
  notionConnected: boolean;
  jiraConnected: boolean;
  canManageWorkspaceIntegrations: boolean;
  canManageCliTokens: boolean;
  // workspace-level install state (Set of integration IDs available at the workspace).
  // Linear triggers need the workspace install to be present even before
  // the personal OAuth - that's the "bot is in the room" prerequisite.
  workspaceAvailable: Set<string>;
  // Slack's "bot is in the room" prerequisite is the actual workspace (bot)
  // install, not the scope toggle - the toggle defaults to enabled for every
  // business, so it can't signal readiness.
  slackWorkspaceInstalled: boolean;
}): GroupedNextSteps {
  const personalConnectedCount = [
    args.linearConnected,
    args.slackConnected,
    args.notionConnected,
    args.jiraConnected,
  ].filter(Boolean).length;

  const optional: NextStep[] = [];

  if (args.canManageWorkspaceIntegrations) {
    // Workspace-level integrations are admin-only setup. Once configured, every
    // user in the workspace inherits access without needing their own credentials.
    // Surfaced first because the admin-only setup unblocks Slack triggers and
    // shared observability for everyone else.
    optional.push({
      key: "workspace-integrations",
      eyebrow: "For your workspace",
      title: "Set up shared workspace integrations",
      body: "Slack, Sentry, Datadog, etc. Connected once for the whole team.",
      cta: { kind: "internal", to: "/settings/workspace-integrations", label: "Manage workspace integrations" },
      badge: { label: "Admin", tone: "neutral" },
    });
  }

  // Personal OAuth connections - sign-ins under your own account so Cycloid can
  // act as you. Distinct from the workspace tile above; both can be useful even
  // for an admin (workspace Slack ≠ personal Slack DMs).
  optional.push({
    key: "personal-integrations",
    eyebrow: "For you",
    title: "Connect your own accounts",
    body: "Sign in to Linear, Notion, or Slack so Cycloid can act as you.",
    cta: { kind: "internal", to: "/settings/integrations", label: "Connect personal accounts" },
    badge:
      personalConnectedCount > 0
        ? { label: `${personalConnectedCount} connected`, tone: "active" }
        : { label: "Optional", tone: "neutral" },
  });

  // "Ways to use Cycloid" are entry points, not configuration. Each tile names a
  // surface where you can hand Cycloid a task. Setup for Linear/Slack triggers
  // lives in the Optional section above, so these tiles stay focused on the verb.
  // "Ready" means the entry-point is fully usable right now. For Linear/Slack
  // that requires the workspace install (`workspaceAvailable.has(id)`) so the
  // app is wired to fire - without it, mentions don't reach Cycloid no matter
  // what the user does. Personal OAuth on top adds attribution but isn't the
  // gating condition for the trigger to work.
  const linearWorkspaceReady = args.workspaceAvailable.has("linear");
  const slackWorkspaceReady = args.slackWorkspaceInstalled;

  const waysToUse: NextStep[] = [
    {
      key: "use-web",
      eyebrow: "From the web app",
      title: "Start a session from the home page",
      body: "Pick a repo, describe the task, get a PR.",
      cta: { kind: "internal", to: "/", label: "Start a session" },
      badge: null,
    },
    {
      key: "use-linear",
      eyebrow: "From your issue tracker",
      title: "Kick off tasks from a Linear issue",
      body: "Add the `cycloid` label to an issue; updates flow back to the ticket.",
      cta: linearWorkspaceReady
        ? { kind: "internal", to: "/settings/integrations", label: "Connect Linear" }
        : args.canManageWorkspaceIntegrations
          ? { kind: "internal", to: "/settings/workspace-integrations", label: "Set up Linear" }
          : { kind: "internal", to: "/settings/integrations", label: "Ask admin to enable Linear" },
      badge: !linearWorkspaceReady
        ? { label: "Workspace setup needed", tone: "neutral" }
        : args.linearConnected
          ? { label: "Ready", tone: "active" }
          : { label: "Connect your Linear", tone: "neutral" },
    },
    {
      key: "use-slack",
      eyebrow: "From Slack",
      title: "Trigger tasks by message",
      body: "@-mention Cycloid in a channel; updates land in-thread.",
      cta: slackWorkspaceReady
        ? { kind: "internal", to: "/settings/integrations", label: "Open Slack settings" }
        : args.canManageWorkspaceIntegrations
          ? { kind: "document", href: SLACK_WORKSPACE_INSTALL_URL, label: "Install Cycloid in Slack" }
          : { kind: "internal", to: "/settings/integrations", label: "Ask admin to install Slack" },
      badge: slackWorkspaceReady
        ? { label: "Ready", tone: "active" }
        : { label: "Workspace setup needed", tone: "neutral" },
    },
  ];

  if (args.canManageCliTokens) {
    waysToUse.push({
      key: "use-cli",
      eyebrow: "From the terminal",
      title: "Drive Cycloid from the CLI",
      body: "Mint a token to script sessions or run from a hotkey.",
      cta: { kind: "internal", to: "/settings/integrations", label: "Set up CLI" },
      badge: null,
    });
  }

  return { optional, waysToUse };
}

export function GetStartedSettings() {
  const { user, repos, reposLoaded, settings, capabilities } = useLayoutContext();
  const [steps, setSteps] = useState<OnboardingStep[] | null>(null);
  const [stepsLoaded, setStepsLoaded] = useState(false);
  const [installUrl, setInstallUrl] = useState<string | null>(null);
  const [integrations, setIntegrations] = useState<UserIntegrations | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null = follow auto-rule, boolean = user manually pinned the section.
  // Once a user clicks the disclosure we respect their choice across re-renders.
  const [requiredOverride, setRequiredOverride] = useState<boolean | null>(null);
  const [optionalOverride, setOptionalOverride] = useState<boolean | null>(null);
  const [waysOverride, setWaysOverride] = useState<boolean | null>(null);

  useMountEffect(() => {
    void Promise.all([
      fetchOnboardingStatus(),
      fetchInstallUrl().catch(() => null),
      fetchUserIntegrations().catch(() => null),
    ])
      .then(([fetchedSteps, url, fetchedIntegrations]) => {
        setSteps(fetchedSteps);
        setInstallUrl(url);
        setIntegrations(fetchedIntegrations);
      })
      .catch((err: unknown) => {
        console.error(err);
        setError("Couldn't load your setup progress. Refresh to try again.");
      })
      .finally(() => setStepsLoaded(true));
  });

  const dataReady = stepsLoaded && reposLoaded;

  if (!user) return null;

  const statuses = computeStatuses({
    steps,
    reposLoaded,
    repoCount: repos.length,
    defaultRepo: settings?.defaultRepo ?? null,
    visibleRepoFullNames: new Set(repos.map((repo) => repo.fullName)),
  });
  const completedCount = STEP_SLOTS.reduce(
    (acc, slot) =>
      acc +
      (statuses[slot.id] === ONBOARDING_STEP_STATUS.CONNECTED ||
      statuses[slot.id] === ONBOARDING_STEP_STATUS.BUSINESS_MANAGED
        ? 1
        : 0),
    0,
  );
  const totalCount = STEP_SLOTS.length;
  const allDone = dataReady && completedCount === totalCount;

  // Surface the business-authorization block separately - it isn't user-actionable
  // (only an admin can resolve it) so it sits beside the checklist, not inside it.
  const needsBusinessAccess =
    statuses.github_business_authorized !== ONBOARDING_STEP_STATUS.CONNECTED &&
    statuses.github_business_authorized !== ONBOARDING_STEP_STATUS.BUSINESS_MANAGED;

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        eyebrow="Welcome"
        title="Getting started"
        description={
          allDone ? "Everything Cycloid needs is connected." : "A short checklist to get Cycloid working on your repos."
        }
      />

      {error ? (
        <p role="alert" className="text-base text-error">
          {error}
        </p>
      ) : null}

      {needsBusinessAccess ? (
        <div className="editorial-fade border border-warning-soft-border bg-warning-soft p-4 text-warning">
          <p className="text-base font-medium">Ask an admin to authorize your account</p>
          <p
            className="mt-1 text-base leading-relaxed opacity-90"
            style={{ textWrap: "pretty" } as React.CSSProperties}
          >
            Ping your Cycloid contact or workspace admin to be approved, then refresh.
          </p>
        </div>
      ) : null}

      {dataReady && !error ? (
        // Skeleton → content: one fade on the loaded container (never per card).
        <div className="editorial-fade space-y-2">
          <Section
            id="get-started-required"
            title="Required setup"
            summary={
              <span className="inline-flex items-baseline gap-1">
                <span className="numeral text-text-secondary">{completedCount}</span>
                <span>/</span>
                <span className="numeral">{totalCount}</span>
                <span>{allDone ? "complete" : "done"}</span>
              </span>
            }
            open={requiredOverride ?? !allDone}
            onToggle={() => setRequiredOverride((prev) => !(prev ?? !allDone))}
          >
            <ol className="grid gap-3">
              {STEP_SLOTS.map((slot, index) => {
                const status = statuses[slot.id];
                return (
                  <StepCard
                    key={slot.id}
                    index={index}
                    slot={slot}
                    status={status}
                    description={describeStep(slot, status, repos.length, settings?.defaultRepo ?? null)}
                    cta={ctaForStep(slot.id, status, installUrl)}
                  />
                );
              })}
            </ol>
          </Section>

          {(() => {
            const { optional, waysToUse } = buildNextSteps({
              linearConnected: user.linearConnected,
              slackConnected: user.slackConnected,
              notionConnected: user.notionConnected,
              jiraConnected: user.jiraConnected,
              canManageWorkspaceIntegrations: capabilities?.canManageBusinessIntegrations === true,
              canManageCliTokens: capabilities?.canManageCliTokens === true,
              workspaceAvailable: new Set(integrations?.availableIntegrations ?? []),
              slackWorkspaceInstalled: user.slackWorkspaceInstalled === true,
            });
            return (
              <>
                <Section
                  id="get-started-optional"
                  title="Optional setup"
                  open={optionalOverride ?? true}
                  onToggle={() => setOptionalOverride((prev) => !(prev ?? true))}
                >
                  <ul className="grid gap-3">
                    {optional.map((nextStep) => (
                      <NextStepCard key={nextStep.key} step={nextStep} />
                    ))}
                  </ul>
                </Section>

                <Section
                  id="get-started-ways"
                  title="Try these ways to use Cycloid"
                  open={waysOverride ?? true}
                  onToggle={() => setWaysOverride((prev) => !(prev ?? true))}
                >
                  <ul className="grid gap-3">
                    {waysToUse.map((nextStep) => (
                      <NextStepCard key={nextStep.key} step={nextStep} />
                    ))}
                  </ul>
                </Section>
              </>
            );
          })()}
        </div>
      ) : !error ? (
        <div className="grid gap-3" aria-busy>
          {STEP_SLOTS.map((slot) => (
            <div key={slot.id} className="h-[112px] motion-safe:animate-pulse border border-border bg-surface-1" />
          ))}
        </div>
      ) : null}
    </div>
  );
}
