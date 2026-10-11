import { useId, useRef, useState } from "react";

import {
  createScheduledRule,
  deleteScheduledRule,
  fetchScheduledRules,
  type ScheduledRule,
} from "../../api/automation-schedules";
import { ApiError } from "../../api/client";
import { SCHEDULED_AUTOMATION_TEMPLATES, type ScheduledAutomationTemplate } from "../../constants/automationTemplates";
import { buildCronFromPreset, HOUR_OPTIONS, MINUTE_OPTIONS, type SchedulePreset } from "../../constants/scheduleCron";
import { useMountEffect } from "../../hooks/useEffects";
import { useConfirm } from "../ConfirmDialog";
import { CheckIcon } from "../icons";
import { useLayoutContext } from "../Layout";
import { Badge, Button, Input, Select, Textarea } from "../ui";
import { SettingsField, SettingsScopeBadge, SettingsSection, SettingsSkeleton } from "./SettingsLayout";

const CRON_ALIASES = new Set(["@hourly", "@daily", "@midnight", "@weekly", "@monthly", "@yearly", "@annually"]);

/**
 * Lightweight client-side cron check. Catches the obvious shape errors
 * (wrong field count, empty string) so the user sees inline feedback
 * without a server roundtrip. Full validation — sub-5-minute cadence,
 * range bounds, aliases, normalized form — is done server-side and the
 * structured error code is surfaced on submit.
 */
export function preValidateCron(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return "Cron is required";
  if (trimmed.startsWith("@")) {
    return CRON_ALIASES.has(trimmed.toLowerCase()) ? null : "Unknown cron alias";
  }
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return "Cron must have 5 space-separated fields (minute hour day month weekday)";
  return null;
}

type RepoInput = { owner: string; name: string };

function parseRepoInput(value: string): RepoInput | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
  const segments = cleaned.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  return { owner: segments[0], name: segments[1] };
}

function formatRelativeMs(ms: number | null): string {
  // Strict null-check: `!ms` would also swallow a legitimate epoch-zero
  // timestamp, rendering it as "—" instead of the Jan 1 1970 fallback.
  if (ms == null) return "—";
  const date = new Date(ms);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

const SCHEDULE_PRESET_OPTIONS: { value: SchedulePreset; label: string }[] = [
  { value: "hourly", label: "Every hour" },
  { value: "daily", label: "Every day" },
  { value: "weekday", label: "Every weekday (Mon–Fri)" },
  { value: "weekly-1", label: "Every Monday" },
  { value: "weekly-2", label: "Every Tuesday" },
  { value: "weekly-3", label: "Every Wednesday" },
  { value: "weekly-4", label: "Every Thursday" },
  { value: "weekly-5", label: "Every Friday" },
  { value: "weekly-6", label: "Every Saturday" },
  { value: "weekly-0", label: "Every Sunday" },
  { value: "monthly", label: "On the 1st of every month" },
  { value: "custom", label: "Custom cron…" },
];

function computeNextRunForPreset(preset: SchedulePreset, hour: number, minute: number, from: Date): Date | null {
  if (preset === "custom") return null;

  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hour, minute, 0, 0));
  switch (preset) {
    case "hourly": {
      const fromMs = from.getTime();
      const candidate = new Date(
        Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), from.getUTCHours(), 0, 0, 0),
      );
      if (candidate.getTime() <= fromMs) candidate.setUTCHours(candidate.getUTCHours() + 1);
      return candidate;
    }
    case "daily":
      if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 1);
      return next;
    case "weekday": {
      let candidate = new Date(next.getTime());
      if (candidate.getTime() <= from.getTime()) candidate.setUTCDate(candidate.getUTCDate() + 1);
      while (candidate.getUTCDay() === 0 || candidate.getUTCDay() === 6) {
        candidate.setUTCDate(candidate.getUTCDate() + 1);
      }
      return candidate;
    }
    case "weekly-0":
    case "weekly-1":
    case "weekly-2":
    case "weekly-3":
    case "weekly-4":
    case "weekly-5":
    case "weekly-6": {
      const targetDay = Number(preset.slice(-1));
      let candidate = new Date(next.getTime());
      if (candidate.getTime() <= from.getTime()) candidate.setUTCDate(candidate.getUTCDate() + 1);
      while (candidate.getUTCDay() !== targetDay) {
        candidate.setUTCDate(candidate.getUTCDate() + 1);
      }
      return candidate;
    }
    case "monthly": {
      const candidate = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1, hour, minute, 0, 0));
      if (candidate.getTime() <= from.getTime()) candidate.setUTCMonth(candidate.getUTCMonth() + 1);
      return candidate;
    }
  }
}

function formatNextRun(date: Date): string {
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

function parseNumberField(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : null;
}

function computeNextRunForCustomCron(raw: string, from: Date): Date | null {
  if (preValidateCron(raw) !== null) return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "@hourly") return computeNextRunForPreset("hourly", 0, 0, from);
  if (trimmed === "@daily" || trimmed === "@midnight") return computeNextRunForPreset("daily", 0, 0, from);
  if (trimmed === "@weekly") return computeNextRunForPreset("weekly-0", 0, 0, from);
  if (trimmed === "@monthly") return computeNextRunForPreset("monthly", 0, 0, from);

  const [minuteRaw, hourRaw, dayRaw, monthRaw, weekdayRaw] = trimmed.split(/\s+/);
  const minute = parseNumberField(minuteRaw, 0, 59);
  const hour = parseNumberField(hourRaw, 0, 23);
  if (minute == null || hour == null || monthRaw !== "*") return null;

  if (dayRaw === "*" && weekdayRaw === "*") return computeNextRunForPreset("daily", hour, minute, from);
  if (dayRaw === "*" && weekdayRaw === "1-5") return computeNextRunForPreset("weekday", hour, minute, from);
  if (dayRaw === "*" && /^[0-6]$/.test(weekdayRaw)) {
    return computeNextRunForPreset(`weekly-${weekdayRaw}` as SchedulePreset, hour, minute, from);
  }
  if (dayRaw === "1" && weekdayRaw === "*") return computeNextRunForPreset("monthly", hour, minute, from);
  return null;
}

function getNextRunPreview({
  cron,
  hour,
  minute,
  preset,
  from,
}: {
  cron: string;
  hour: number;
  minute: number;
  preset: SchedulePreset;
  from: Date;
}): string {
  const nextRun =
    preset === "custom" ? computeNextRunForCustomCron(cron, from) : computeNextRunForPreset(preset, hour, minute, from);
  if (nextRun) return formatNextRun(nextRun);
  return preset === "custom" ? "Preview available after save" : "—";
}

export function AutomationSchedulesSettings() {
  const { repos, reposLoaded } = useLayoutContext();
  const confirm = useConfirm();
  const [rules, setRules] = useState<ScheduledRule[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteSuccess, setDeleteSuccess] = useState<string | null>(null);

  const [repoFullName, setRepoFullName] = useState("");
  const [schedulePreset, setSchedulePreset] = useState<SchedulePreset>("weekday");
  const [scheduleHour, setScheduleHour] = useState(9);
  const [scheduleMinute, setScheduleMinute] = useState(0);
  const [cron, setCron] = useState("");
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [slackTeamId, setSlackTeamId] = useState("");
  const [slackChannelId, setSlackChannelId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);
  // Dedicated status for the "loaded a template" hint so it never collides with
  // a create success/error message.
  const [templateStatus, setTemplateStatus] = useState<string | null>(null);

  const newRunSectionRef = useRef<HTMLDivElement>(null);

  const repoFieldId = useId();
  const presetFieldId = useId();
  const hourFieldId = useId();
  const minuteFieldId = useId();
  const cronFieldId = useId();
  const promptFieldId = useId();
  const nameFieldId = useId();
  const slackTeamFieldId = useId();
  const slackChannelFieldId = useId();

  const effectiveCron =
    schedulePreset === "custom" ? cron : buildCronFromPreset(schedulePreset, scheduleHour, scheduleMinute);
  const nextRunPreview = getNextRunPreview({
    cron,
    hour: scheduleHour,
    minute: scheduleMinute,
    preset: schedulePreset,
    from: new Date(),
  });

  async function loadInitial() {
    setLoading(true);
    setLoadError(null);
    try {
      const page = await fetchScheduledRules();
      setRules(page.items);
      setNextCursor(page.nextCursor);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Failed to load scheduled rules");
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
      // Use a separate error state so a paging failure does not blow away the
      // rules the user has already loaded.
      setLoadMoreError(error instanceof Error ? error.message : "Failed to load more scheduled rules");
    } finally {
      setLoadingMore(false);
    }
  }

  useMountEffect(() => {
    loadInitial();
  });

  const repoParsed = parseRepoInput(repoFullName);
  const cronInlineError = schedulePreset === "custom" && cron.length > 0 ? preValidateCron(cron) : null;
  const promptInlineError =
    prompt.length > 0 && prompt.trim().length === 0 ? "Prompt cannot be only whitespace." : null;
  const slackTeamTrimmed = slackTeamId.trim();
  const slackChannelTrimmed = slackChannelId.trim();
  // Both-or-neither: delivery needs a workspace AND a channel. Server verifies
  // the bot is actually a member of the channel (fails closed) on submit.
  const slackDeliveryPartial = slackTeamTrimmed.length > 0 !== slackChannelTrimmed.length > 0;
  const slackInlineError = slackDeliveryPartial
    ? "Enter both a workspace ID and a channel ID to deliver to Slack, or leave both blank."
    : null;
  const canSubmit =
    !submitting &&
    repoParsed !== null &&
    effectiveCron.trim().length > 0 &&
    !cronInlineError &&
    !slackInlineError &&
    prompt.trim().length > 0;

  async function handleConfirmDelete(rule: ScheduledRule) {
    setDeletingId(rule.id);
    setDeleteError(null);
    setDeleteSuccess(null);
    // Keep the row visible while the request is in flight: the button row
    // renders "Deleting…" and the disabled state is actually observable.
    // Avoids the stale-snapshot rollback bug — if the user loads more or
    // creates a rule mid-flight, we never replace the whole `rules` slice.
    try {
      await deleteScheduledRule(rule.id);
      setRules((current) => current.filter((r) => r.id !== rule.id));
      setDeleteSuccess(`Deleted "${rule.name ?? `${rule.repoOwner}/${rule.repoName} @ ${rule.cron}`}".`);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Failed to delete scheduled rule");
    } finally {
      setDeletingId(null);
    }
  }

  // Only scheduled templates can prefill this form; roadmap (event-trigger)
  // templates carry no schedule or prompt fields and never reach this surface.
  function handleUseTemplate(template: ScheduledAutomationTemplate) {
    setName(template.name);
    setSchedulePreset(template.preset);
    setScheduleHour(template.hour);
    setScheduleMinute(template.minute);
    setPrompt(template.prompt);
    // Templates are weekly presets, so any leftover custom cron is irrelevant.
    setCron("");
    // Clear stale create feedback so it does not conflict with the new hint.
    setFormError(null);
    setFormSuccess(null);
    // Leave the selected repository untouched: repo is required and not part of a template.
    setTemplateStatus(`Loaded "${template.name}" — pick a repository, then create.`);
    newRunSectionRef.current?.scrollIntoView({ behavior: "smooth" });
  }

  // Once the user touches any form field the "loaded a template" hint is stale,
  // so drop it. No-ops when already cleared to avoid a redundant render.
  function dismissTemplateStatus() {
    setTemplateStatus((current) => (current === null ? current : null));
  }

  async function handleSubmit(event?: React.FormEvent | React.MouseEvent) {
    event?.preventDefault();
    if (!canSubmit || !repoParsed) return;

    setSubmitting(true);
    setFormError(null);
    setFormSuccess(null);
    try {
      const created = await createScheduledRule({
        repoOwner: repoParsed.owner,
        repoName: repoParsed.name,
        cron: effectiveCron.trim(),
        prompt: prompt.trim(),
        name: name.trim() ? name.trim() : null,
        slackTeamId: slackTeamTrimmed || null,
        slackChannelId: slackChannelTrimmed || null,
      });
      setRules((prev) => [created, ...prev]);
      setFormSuccess(`Created "${created.name ?? `${created.repoOwner}/${created.repoName} @ ${created.cron}`}".`);
      setRepoFullName("");
      setSchedulePreset("weekday");
      setScheduleHour(9);
      setScheduleMinute(0);
      setCron("");
      setPrompt("");
      setName("");
      setSlackTeamId("");
      setSlackChannelId("");
      setTemplateStatus(null);
    } catch (error) {
      if (error instanceof ApiError) {
        setFormError(error.message);
      } else {
        setFormError(error instanceof Error ? error.message : "Failed to create scheduled rule");
      }
    } finally {
      setSubmitting(false);
    }
  }

  // Load and delete messages are lifted out of `Existing schedules` so they
  // still render when the section is hidden after deleting the last rule.
  // Form messages stay in-situ next to the submit button so feedback is
  // visible on small viewports without scrolling back to the top.
  const listStatusMessages: { kind: "error" | "success"; text: string }[] = [];
  if (loadError) listStatusMessages.push({ kind: "error", text: loadError });
  if (deleteError) listStatusMessages.push({ kind: "error", text: deleteError });
  if (deleteSuccess) listStatusMessages.push({ kind: "success", text: deleteSuccess });

  // Keep the section visible when `nextCursor` is set even if the loaded page
  // is empty (e.g. user deleted every rule on the current page), otherwise
  // remaining rules become unreachable from the UI.
  const showExistingSection = loading || rules.length > 0 || nextCursor !== null;

  return (
    <div className="space-y-6">
      <SettingsSection
        title="Recurring runs"
        description="Have Cycloid run a prompt on a repo on a recurring schedule — for example, every weekday morning."
        meta={<SettingsScopeBadge scope="workspace" />}
      >
        {listStatusMessages.length > 0 ? (
          <div className="editorial-fade space-y-1 pt-4">
            {listStatusMessages.map((message, index) =>
              message.kind === "error" ? (
                <p key={`${message.kind}-${index}`} className="text-xs text-error" role="alert">
                  {message.text}
                </p>
              ) : (
                <Badge key={`${message.kind}-${index}`} tone="success" role="status">
                  <CheckIcon className="size-3" />
                  {message.text}
                </Badge>
              ),
            )}
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Suggested automations">
        <p className="mt-2 max-w-[60ch] text-base leading-relaxed text-text-secondary">
          Repo-agnostic scheduled tasks. Pick one to pre-fill the form below; each run opens a PR, or does nothing when
          there is no change to make.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {SCHEDULED_AUTOMATION_TEMPLATES.map((template) => (
            <div key={template.id} className="flex flex-col gap-2 border border-border bg-surface-1 p-3.5">
              <h4 className="text-sm font-medium text-text-primary">{template.title}</h4>
              <p className="flex-1 text-sm text-text-secondary">{template.outcome}</p>
              <Button
                type="button"
                onClick={() => handleUseTemplate(template)}
                variant="secondary"
                size="sm"
                className="self-start"
              >
                Use this
              </Button>
            </div>
          ))}
        </div>
        {templateStatus ? (
          <Badge tone="success" role="status" className="editorial-fade mt-3">
            <CheckIcon className="size-3" />
            {templateStatus}
          </Badge>
        ) : null}
      </SettingsSection>

      <div ref={newRunSectionRef}>
        <SettingsSection title="New scheduled run">
          {/*
           * `<form>` is kept for semantics and Enter-to-submit, but onSubmit
           * is intentionally not wired here: the submit button's onClick is
           * the single source of truth and calls preventDefault, so the form
           * never double-fires (#3373 Greptile P2).
           */}
          <form className="space-y-4">
            <SettingsField
              label="Repository"
              htmlFor={repoFieldId}
              description="The repository this schedule runs against."
            >
              <Select
                id={repoFieldId}
                value={repoFullName}
                disabled={!reposLoaded}
                onChange={(event) => {
                  setRepoFullName(event.target.value);
                  dismissTemplateStatus();
                }}
                className="w-full"
              >
                <option value="">{reposLoaded ? "Select a repository" : "Loading repositories…"}</option>
                {repos.map((repo) => (
                  <option key={repo.fullName} value={repo.fullName}>
                    {repo.fullName}
                  </option>
                ))}
              </Select>
            </SettingsField>

            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                <SettingsField label="Repeats" htmlFor={presetFieldId}>
                  <Select
                    id={presetFieldId}
                    value={schedulePreset}
                    onChange={(event) => {
                      setSchedulePreset(event.target.value as SchedulePreset);
                      dismissTemplateStatus();
                    }}
                  >
                    {SCHEDULE_PRESET_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </SettingsField>

                {schedulePreset !== "hourly" && schedulePreset !== "custom" ? (
                  <SettingsField label="At (UTC)" htmlFor={hourFieldId}>
                    <div className="flex items-center gap-2">
                      <Select
                        id={hourFieldId}
                        value={scheduleHour}
                        onChange={(event) => {
                          setScheduleHour(Number(event.target.value));
                          dismissTemplateStatus();
                        }}
                        wrapperClassName="w-20"
                        className="font-mono-tabular tabular-nums"
                      >
                        {HOUR_OPTIONS.map((h) => (
                          <option key={h} value={h}>
                            {String(h).padStart(2, "0")}
                          </option>
                        ))}
                      </Select>
                      <span className="text-text-muted">:</span>
                      <Select
                        id={minuteFieldId}
                        value={scheduleMinute}
                        onChange={(event) => {
                          setScheduleMinute(Number(event.target.value));
                          dismissTemplateStatus();
                        }}
                        wrapperClassName="w-20"
                        className="font-mono-tabular tabular-nums"
                      >
                        {MINUTE_OPTIONS.map((m) => (
                          <option key={m} value={m}>
                            {String(m).padStart(2, "0")}
                          </option>
                        ))}
                      </Select>
                    </div>
                  </SettingsField>
                ) : null}
              </div>

              {schedulePreset === "custom" ? (
                <SettingsField
                  label="Cron expression"
                  htmlFor={cronFieldId}
                  description="5 fields: minute hour day month weekday. Aliases like @daily work."
                  error={cronInlineError ?? undefined}
                >
                  <Input
                    id={cronFieldId}
                    type="text"
                    value={cron}
                    onChange={(event) => {
                      setCron(event.target.value);
                      dismissTemplateStatus();
                    }}
                    placeholder="0 14 * * 1-5"
                    autoComplete="off"
                    spellCheck={false}
                    className="w-full font-mono"
                  />
                </SettingsField>
              ) : null}

              <div className="flex items-baseline justify-between gap-3 border border-border bg-surface-1 px-3.5 py-2.5 text-base">
                <span className="text-text-muted">Next run</span>
                <span className="font-mono-tabular text-text-primary tabular-nums">{nextRunPreview}</span>
              </div>
            </div>

            <SettingsField label="Prompt" htmlFor={promptFieldId} error={promptInlineError ?? undefined}>
              <Textarea
                id={promptFieldId}
                value={prompt}
                onChange={(event) => {
                  setPrompt(event.target.value);
                  dismissTemplateStatus();
                }}
                rows={4}
                placeholder="Review low-risk failing tests in this repository. If you can make a safe fix, implement it, test it, and open a PR."
                className="w-full"
              />
            </SettingsField>

            <SettingsField label="Name (optional)" htmlFor={nameFieldId} description="Up to 80 chars.">
              <Input
                id={nameFieldId}
                type="text"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  dismissTemplateStatus();
                }}
                maxLength={80}
                placeholder="Weekday flake sweep"
                autoComplete="off"
                className="w-full"
              />
            </SettingsField>

            <SettingsField
              label="Deliver to Slack (optional)"
              htmlFor={slackChannelFieldId}
              description="Post each run's result to a Slack channel. Invite the Cycloid bot to the channel first."
              error={slackInlineError ?? undefined}
            >
              <div className="grid gap-2 sm:grid-cols-2">
                <Input
                  id={slackChannelFieldId}
                  type="text"
                  value={slackChannelId}
                  onChange={(event) => {
                    setSlackChannelId(event.target.value);
                    dismissTemplateStatus();
                  }}
                  placeholder="Channel ID (e.g. C0123ABC)"
                  aria-label="Slack channel ID"
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full font-mono"
                />
                <Input
                  id={slackTeamFieldId}
                  type="text"
                  value={slackTeamId}
                  onChange={(event) => {
                    setSlackTeamId(event.target.value);
                    dismissTemplateStatus();
                  }}
                  placeholder="Workspace ID (e.g. T0123ABC)"
                  aria-label="Slack workspace ID"
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full font-mono"
                />
              </div>
            </SettingsField>

            <div className="flex items-center justify-end pt-1">
              <Button type="submit" disabled={!canSubmit} onClick={handleSubmit} variant="primary" size="md">
                {submitting ? "Creating…" : "Create schedule"}
              </Button>
            </div>

            {formError ? (
              <p className="text-xs text-error" role="alert">
                {formError}
              </p>
            ) : null}
            {formSuccess ? (
              <Badge tone="success" role="status" className="editorial-fade">
                <CheckIcon className="size-3" />
                {formSuccess}
              </Badge>
            ) : null}
          </form>
        </SettingsSection>
      </div>

      {showExistingSection ? (
        <SettingsSection title="Existing schedules">
          {loading ? (
            <SettingsSkeleton rows={2} showHeader={false} />
          ) : (
            <ul className="editorial-fade divide-y divide-border">
              {rules.map((rule) => {
                const isDeleting = deletingId === rule.id;
                return (
                  <li key={rule.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-sm text-text-primary">
                        {rule.name ?? `${rule.repoOwner}/${rule.repoName} @ ${rule.cron}`}
                      </span>
                      <span className="text-xs text-text-muted">next fire {formatRelativeMs(rule.nextFireAt)}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
                      <span className="font-mono">
                        {rule.repoOwner}/{rule.repoName}
                      </span>
                      <span aria-hidden>·</span>
                      <span className="font-mono">{rule.cron}</span>
                      {rule.enabled ? null : (
                        <>
                          <span aria-hidden>·</span>
                          <span className="text-warning">disabled</span>
                        </>
                      )}
                    </div>
                    <p className="line-clamp-2 text-xs text-text-muted">{rule.promptTemplate}</p>
                    {rule.slackChannelId ? (
                      <p className="text-xs" role="status">
                        {rule.lastDeliveryError ? (
                          <span className="text-error">Slack delivery failed: {rule.lastDeliveryError}</span>
                        ) : rule.lastDeliveredAt != null ? (
                          <span className="text-success">
                            Delivered to Slack {formatRelativeMs(rule.lastDeliveredAt)}
                          </span>
                        ) : (
                          <span className="text-text-muted">Delivers to Slack · no run yet</span>
                        )}
                      </p>
                    ) : null}
                    <div className="flex items-center justify-end gap-2 pt-1">
                      {rule.canDelete ? (
                        <Button
                          type="button"
                          onClick={async () => {
                            setDeleteError(null);
                            setDeleteSuccess(null);
                            if (
                              !(await confirm({
                                title: "Delete scheduled run?",
                                message: `Delete "${rule.name ?? `${rule.repoOwner}/${rule.repoName} @ ${rule.cron}`}"? Already-running sessions will finish, but no new runs will start.`,
                                confirmLabel: "Delete",
                                destructive: true,
                              }))
                            ) {
                              return;
                            }
                            void handleConfirmDelete(rule);
                          }}
                          disabled={isDeleting}
                          variant="danger"
                          size="sm"
                        >
                          {isDeleting ? "Deleting…" : "Delete"}
                        </Button>
                      ) : (
                        <span className="text-xs text-text-muted">Only the creator or an admin can delete this</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {nextCursor ? (
            <div className="space-y-2 pt-3">
              <Button type="button" onClick={loadMore} disabled={loadingMore} variant="ghost" size="sm">
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
              {loadMoreError ? (
                <p className="text-xs text-error" role="alert">
                  {loadMoreError}
                </p>
              ) : null}
            </div>
          ) : null}
        </SettingsSection>
      ) : null}
    </div>
  );
}
