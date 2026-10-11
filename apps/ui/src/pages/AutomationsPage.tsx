import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router";

import { type AutomationRunHistoryItem, fetchAutomationRuns } from "../api/automation-runs";
import {
  deleteScheduledRule,
  duplicateScheduledRule,
  fetchScheduledRules,
  runScheduledRuleNow,
  type ScheduledRule,
  setScheduledRuleEnabled,
} from "../api/automation-schedules";
import { type ConnectedTrigger, fetchConnectedTriggers } from "../api/automation-triggers";
import {
  fetchGithubCheckAutomations,
  type GithubCheckAutomationRule,
  patchGithubCheckAutomation,
} from "../api/github-check-automations";
import { AutomationRuns } from "../components/automations/AutomationRuns";
import { ConnectedTriggers } from "../components/automations/ConnectedTriggers";
import {
  type AutomationDraft,
  BLANK_DRAFT,
  CreateAutomationModal,
} from "../components/automations/CreateAutomationModal";
import { humanizeCron } from "../components/automations/format";
import { GithubCheckAutomationModal } from "../components/automations/GithubCheckAutomationModal";
import { InstalledAutomations } from "../components/automations/InstalledAutomations";
import { TemplateGallery } from "../components/automations/TemplateGallery";
import { useConfirm } from "../components/ConfirmDialog";
import { useLayoutContext } from "../components/Layout";
import { SlackAlertAutomationSettings } from "../components/settings/SlackAlertAutomationSettings";
import { AdminOnlyNotice, useWorkspaceAdminAccess } from "../components/settings/workspaceSettingsShared";
import { Button, EmptyState, Input, PageHeader } from "../components/ui";
import type { ScheduledAutomationTemplate } from "../constants/automationTemplates";
import { useMountEffect } from "../hooks/useEffects";

export function AutomationsPage() {
  const { repos, reposLoaded, settings, user } = useLayoutContext();
  const navigate = useNavigate();
  const adminAccess = useWorkspaceAdminAccess();
  const confirm = useConfirm();

  const [rules, setRules] = useState<ScheduledRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [connectedTriggers, setConnectedTriggers] = useState<ConnectedTrigger[]>([]);
  const [triggersLoading, setTriggersLoading] = useState(true);
  const [triggersError, setTriggersError] = useState<string | null>(null);
  const [automationRuns, setAutomationRuns] = useState<AutomationRunHistoryItem[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [runsNextCursor, setRunsNextCursor] = useState<string | null>(null);
  const [runsLoadingMore, setRunsLoadingMore] = useState(false);
  const [runsLoadMoreError, setRunsLoadMoreError] = useState<string | null>(null);
  const [githubCheckRules, setGithubCheckRules] = useState<GithubCheckAutomationRule[]>([]);
  const [githubCheckModalOpen, setGithubCheckModalOpen] = useState(false);
  const [busyGithubCheckRuleId, setBusyGithubCheckRuleId] = useState<string | null>(null);

  const [busyAction, setBusyAction] = useState<{
    ruleId: string;
    action: "toggle" | "run" | "duplicate" | "delete";
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);

  const [nlText, setNlText] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState<AutomationDraft>(BLANK_DRAFT);
  const [editingRule, setEditingRule] = useState<ScheduledRule | null>(null);

  useMountEffect(() => {
    void loadInitial();
    void loadTriggers();
    void loadRuns();
    void fetchGithubCheckAutomations()
      .then(setGithubCheckRules)
      .catch(() => undefined);
  });

  async function loadRuns() {
    try {
      const page = await fetchAutomationRuns();
      setAutomationRuns(page.items);
      setRunsNextCursor(page.nextCursor);
    } catch (error) {
      setRunsError(error instanceof Error ? error.message : "Failed to load automation runs");
    } finally {
      setRunsLoading(false);
    }
  }

  async function loadMoreRuns() {
    if (!runsNextCursor || runsLoadingMore) return;
    setRunsLoadingMore(true);
    setRunsLoadMoreError(null);
    try {
      const page = await fetchAutomationRuns(runsNextCursor);
      setAutomationRuns((current) => [...current, ...page.items]);
      setRunsNextCursor(page.nextCursor);
    } catch (error) {
      setRunsLoadMoreError(error instanceof Error ? error.message : "Failed to load older automation runs");
    } finally {
      setRunsLoadingMore(false);
    }
  }

  async function loadTriggers() {
    try {
      setConnectedTriggers(await fetchConnectedTriggers());
    } catch (error) {
      setTriggersError(error instanceof Error ? error.message : "Failed to load connected triggers");
    } finally {
      setTriggersLoading(false);
    }
  }

  async function loadInitial() {
    setLoading(true);
    setLoadError(null);
    try {
      const page = await fetchScheduledRules();
      setRules(page.items);
      setNextCursor(page.nextCursor);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Failed to load automations");
    } finally {
      setLoading(false);
    }
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await fetchScheduledRules(nextCursor);
      setRules((prev) => [...prev, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (error) {
      setLoadMoreError(error instanceof Error ? error.message : "Failed to load more automations");
    } finally {
      setLoadingMore(false);
    }
  }

  function openDraft(next: AutomationDraft) {
    setDraft(next);
    setEditingRule(null);
    setActionError(null);
    setActionStatus(null);
    setModalOpen(true);
  }

  function openEdit(rule: ScheduledRule) {
    setEditingRule(rule);
    setActionError(null);
    setActionStatus(null);
    setModalOpen(true);
  }

  function handleNlSubmit(event: FormEvent) {
    event.preventDefault();
    const text = nlText.trim();
    if (!text) return;
    // Honest: no NL-to-automation backend exists, so we seed the real create
    // form with the text as the prompt instead of faking generation.
    openDraft({ ...BLANK_DRAFT, prompt: text });
  }

  // Typed to the scheduled shape: roadmap templates have no prompt or schedule
  // fields, so they cannot reach this seed path.
  function handleUseTemplate(template: ScheduledAutomationTemplate) {
    openDraft({
      prompt: template.prompt,
      name: template.name,
      preset: template.preset,
      hour: template.hour,
      minute: template.minute,
    });
  }

  function handleSaved(rule: ScheduledRule) {
    setRules((prev) => (editingRule ? prev.map((item) => (item.id === rule.id ? rule : item)) : [rule, ...prev]));
    setModalOpen(false);
    setEditingRule(null);
    setNlText("");
  }

  function replaceRule(rule: ScheduledRule) {
    setRules((current) => current.map((item) => (item.id === rule.id ? rule : item)));
  }

  async function handleToggle(rule: ScheduledRule) {
    setBusyAction({ ruleId: rule.id, action: "toggle" });
    setActionError(null);
    setActionStatus(null);
    try {
      const updated = await setScheduledRuleEnabled(rule.id, !rule.enabled);
      replaceRule(updated);
      setActionStatus(
        `${updated.name ?? `${updated.repoOwner}/${updated.repoName}`} ${updated.enabled ? "resumed" : "paused"}.`,
      );
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : `Failed to ${rule.enabled ? "pause" : "resume"} automation`,
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRunNow(rule: ScheduledRule) {
    setBusyAction({ ruleId: rule.id, action: "run" });
    setActionError(null);
    setActionStatus(null);
    try {
      const run = await runScheduledRuleNow(rule.id);
      if (run.outcome === "failed") {
        setActionError(`Run failed${run.failureReason ? `: ${run.failureReason}` : "."}`);
      } else if (run.outcome === "skipped_overlap") {
        setActionStatus("Run skipped because this automation already has a session in progress.");
      } else if (run.outcome === "skipped_concurrency") {
        setActionStatus("Run skipped because the workspace automation limit is active.");
      } else if (run.outcome === "fired") {
        if (run.sessionId) navigate(`/sessions/${encodeURIComponent(run.sessionId)}`);
        else setActionStatus("Run started.");
      } else {
        setActionStatus("Run queued and will retry automatically.");
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to run automation");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleDuplicate(rule: ScheduledRule) {
    setBusyAction({ ruleId: rule.id, action: "duplicate" });
    setActionError(null);
    setActionStatus(null);
    try {
      const duplicate = await duplicateScheduledRule(rule.id);
      setRules((current) => [duplicate, ...current]);
      setActionStatus(
        `Created paused duplicate "${duplicate.name ?? `${duplicate.repoOwner}/${duplicate.repoName}`}".`,
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to duplicate automation");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleDelete(rule: ScheduledRule) {
    setActionError(null);
    setActionStatus(null);
    // Rule name (or repo fallback) plus the humanized schedule — never the raw cron.
    const label = `${rule.name ?? `${rule.repoOwner}/${rule.repoName}`} (${humanizeCron(rule.cron)})`;
    const confirmed = await confirm({
      title: "Delete automation?",
      message: `Delete "${label}"? Already-running sessions will finish, but no new runs will start.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!confirmed) return;

    setBusyAction({ ruleId: rule.id, action: "delete" });
    try {
      await deleteScheduledRule(rule.id);
      setRules((current) => current.filter((r) => r.id !== rule.id));
      setActionStatus(`Deleted "${label}".`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to delete automation");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleGithubCheckToggle(rule: GithubCheckAutomationRule) {
    if (busyGithubCheckRuleId) return;
    setBusyGithubCheckRuleId(rule.id);
    setActionError(null);
    setActionStatus(null);
    try {
      const updated = await patchGithubCheckAutomation(rule.id, { enabled: !rule.enabled });
      setGithubCheckRules((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setActionStatus(
        `${updated.name ?? `${updated.repoOwner}/${updated.repoName}`} ${updated.enabled ? "resumed" : "paused"}.`,
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to update GitHub check automation");
    } finally {
      setBusyGithubCheckRuleId(null);
    }
  }

  const isEmpty = !loading && rules.length === 0 && nextCursor === null;

  return (
    <div className="control-room-canvas control-room-page">
      <div className="control-room-content flex flex-col gap-5">
        <PageHeader
          eyebrow="Work"
          title="Automations"
          className="editorial-rise editorial-rise-1"
          actions={
            // Escape hatch to a blank builder. The describe composer below is
            // the primary entry; this matches the empty-state secondary idiom.
            // Hidden while the empty state is visible — it carries its own
            // "New from scratch" button, and two identical entry points on one
            // screen read as different actions.
            isEmpty ? undefined : (
              <Button variant="secondary" size="sm" onClick={() => openDraft(BLANK_DRAFT)}>
                New from scratch
              </Button>
            )
          }
        />

        <nav aria-label="Automation sections" className="flex gap-2 border-b border-border pb-3">
          <a href="#rules" className="text-sm font-medium text-text-primary">
            Rules
          </a>
          <a href="#connected-triggers" className="text-sm text-text-secondary">
            Connected triggers
          </a>
          <a href="#runs" className="text-sm text-text-secondary">
            Runs
          </a>
        </nav>

        {/* Primary create affordance — a single raised composer that reads as the
            page's center of gravity. surface-1 + resting shadow lifts it off the
            surface-0 canvas without a loud frame. */}
        <div
          id="rules"
          className="editorial-rise editorial-rise-2 flex flex-col gap-3 border border-border bg-surface-1 p-4 shadow-card"
        >
          <div className="flex flex-col gap-1">
            <h2 className="text-md font-medium text-text-primary">Describe what to automate</h2>
            <p className="text-sm text-text-muted">
              Write it in plain language. Cycloid opens the builder with your prompt filled in.
            </p>
          </div>
          <form onSubmit={handleNlSubmit} className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={nlText}
              onChange={(event) => setNlText(event.target.value)}
              placeholder="Describe what to automate…"
              aria-label="Describe what to automate"
              className="flex-1"
            />
            <Button type="submit" variant="primary" size="md" disabled={!nlText.trim()}>
              Draft scheduled automation
            </Button>
          </form>
        </div>

        <section className="flex flex-col gap-3">
          <div>
            <h2 className="text-md font-medium text-text-primary">Create by trigger</h2>
            <p className="text-sm text-text-muted">
              Choose one of the three configurable trigger types Cycloid supports.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <button
              type="button"
              className="border border-border bg-surface-1 p-4 text-left"
              onClick={() => openDraft(BLANK_DRAFT)}
            >
              <span className="font-medium text-text-primary">Schedule</span>
              <span className="mt-1 block text-sm text-text-muted">
                Run repository instructions on a recurring UTC schedule.
              </span>
            </button>
            <a href="#slack-alert-rules" className="border border-border bg-surface-1 p-4 text-left">
              <span className="font-medium text-text-primary">Datadog/Sentry alert in Slack</span>
              <span className="mt-1 block text-sm text-text-muted">
                Start a repository session when a supported alert bot posts.
              </span>
            </a>
            {adminAccess === "admin" ? (
              <button
                type="button"
                className="border border-border bg-surface-1 p-4 text-left"
                onClick={() => setGithubCheckModalOpen(true)}
              >
                <span className="font-medium text-text-primary">Failed GitHub check</span>
                <span className="mt-1 block text-sm text-text-muted">
                  Start one fresh session for a failing check on a non-Cycloid pull request head.
                </span>
              </button>
            ) : (
              <div className="border border-border bg-surface-1 p-4 text-left">
                <span className="font-medium text-text-primary">Failed GitHub check</span>
                <span className="mt-1 block text-sm text-text-muted">Workspace admins manage failed-check rules.</span>
              </div>
            )}
          </div>
        </section>

        {githubCheckRules.length ? (
          <section className="flex flex-col gap-2">
            <h2 className="text-md font-medium text-text-primary">GitHub check rules</h2>
            {githubCheckRules.map((rule) => (
              <div
                key={rule.id}
                className="flex items-center justify-between gap-3 border border-border bg-surface-1 p-4"
              >
                <div>
                  <p className="font-medium text-text-primary">{rule.name ?? `${rule.repoOwner}/${rule.repoName}`}</p>
                  <p className="text-xs text-text-muted">
                    Failed check · {rule.repoOwner}/{rule.repoName}
                    {rule.checkName ? ` · ${rule.checkName}` : " · any check"}
                  </p>
                </div>
                {adminAccess === "admin" ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busyGithubCheckRuleId !== null}
                    onClick={() => void handleGithubCheckToggle(rule)}
                  >
                    {busyGithubCheckRuleId === rule.id ? "Updating…" : rule.enabled ? "Pause" : "Resume"}
                  </Button>
                ) : (
                  <span className="text-xs text-text-muted">Admin managed</span>
                )}
              </div>
            ))}
          </section>
        ) : null}

        {/* Installed automations are the real content. No section title here: the
            page header already says "Automations", and the list below carries its
            own "Installed" label + count. */}
        <section className="editorial-rise editorial-rise-3 flex flex-col gap-2">
          {loadError ? (
            <p className="editorial-fade text-xs text-error" role="alert">
              {loadError}
            </p>
          ) : null}
          {actionError ? (
            <p className="editorial-fade text-xs text-error" role="alert">
              {actionError}
            </p>
          ) : null}
          {actionStatus ? (
            <p className="editorial-fade text-xs text-success" role="status">
              {actionStatus}
            </p>
          ) : null}

          {isEmpty ? (
            <EmptyState
              title="No automations yet"
              description="Describe one above, start from a template, or build one from scratch."
              action={
                <Button variant="secondary" size="sm" onClick={() => openDraft(BLANK_DRAFT)}>
                  New from scratch
                </Button>
              }
            />
          ) : (
            // Skeleton → content swap: the fade class lands when loading flips
            // false (the skeleton renders inside InstalledAutomations, so the
            // swap lives on this owned wrapper, once for the whole list).
            <div className={loading ? undefined : "editorial-fade"}>
              <InstalledAutomations
                rules={rules}
                loading={loading}
                busyAction={busyAction}
                onEdit={openEdit}
                onToggle={handleToggle}
                onRunNow={handleRunNow}
                onDuplicate={handleDuplicate}
                onDelete={handleDelete}
                nextCursor={nextCursor}
                loadingMore={loadingMore}
                loadMoreError={loadMoreError}
                onLoadMore={loadMore}
              />
            </div>
          )}
        </section>

        {/* Templates are a quiet supporting gallery, demoted below the real
            content. A single hairline marks the region shift. */}
        {/* Shares the -3 content beat so the page settles as one region. */}
        <section className="editorial-rise editorial-rise-3 flex flex-col gap-4">
          <div className="rule" />
          <TemplateGallery onUse={handleUseTemplate} />
        </section>

        <section id="slack-alert-rules" className="flex flex-col gap-3">
          {adminAccess === "admin" && user ? (
            <SlackAlertAutomationSettings
              businessId={user.businessId}
              repos={repos}
              reposLoaded={reposLoaded}
              defaultRepo={settings?.defaultRepo}
            />
          ) : (
            <div className="border border-border bg-surface-1 p-4">
              <h2 className="text-md font-medium text-text-primary">Slack alert rules</h2>
              <AdminOnlyNotice message="Workspace admins manage Datadog and Sentry alert rules." />
            </div>
          )}
        </section>

        <section id="connected-triggers" className="flex flex-col gap-1">
          <h2 className="text-md font-medium text-text-primary">Connected triggers</h2>
          <p className="text-sm text-text-muted">
            See fixed integration and lifecycle triggers already active for this workspace.
          </p>
          <ConnectedTriggers triggers={connectedTriggers} loading={triggersLoading} error={triggersError} />
        </section>

        <section id="runs" className="flex flex-col gap-1">
          <h2 className="text-md font-medium text-text-primary">Runs</h2>
          <p className="text-sm text-text-muted">
            Scheduled, alert, and failed-check run history appears here by source.
          </p>
          <AutomationRuns
            runs={automationRuns}
            loading={runsLoading}
            error={runsError}
            nextCursor={runsNextCursor}
            loadingMore={runsLoadingMore}
            loadMoreError={runsLoadMoreError}
            onLoadMore={loadMoreRuns}
          />
        </section>
      </div>

      <CreateAutomationModal
        open={modalOpen}
        draft={draft}
        editingRule={editingRule}
        repos={repos}
        reposLoaded={reposLoaded}
        onClose={() => setModalOpen(false)}
        onSaved={handleSaved}
      />
      <GithubCheckAutomationModal
        open={githubCheckModalOpen}
        repos={repos}
        reposLoaded={reposLoaded}
        onClose={() => setGithubCheckModalOpen(false)}
        onSaved={(rule) => {
          setGithubCheckRules((current) => [rule, ...current]);
          setGithubCheckModalOpen(false);
        }}
      />
    </div>
  );
}
