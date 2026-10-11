import { useId, useState } from "react";

import { createScheduledRule, type ScheduledRule, updateScheduledRule } from "../../api/automation-schedules";
import { ApiError } from "../../api/client";
import { buildCronFromPreset, HOUR_OPTIONS, MINUTE_OPTIONS, type SchedulePreset } from "../../constants/scheduleCron";
import { useSyncEffect } from "../../hooks/useEffects";
import type { Repo } from "../../types";
// Reuse the settings component's client-side cron shape check rather than
// re-deriving it, so the two create paths validate identically.
import { preValidateCron } from "../settings/AutomationSchedulesSettings";
import { Button, Input, Modal, Select, Textarea } from "../ui";
import { humanizeCron } from "./format";

/** Seed values passed from the NL builder, a template card, or a blank "new" action. */
export type AutomationDraft = {
  prompt: string;
  name: string;
  preset: SchedulePreset;
  hour: number;
  minute: number;
};

export const BLANK_DRAFT: AutomationDraft = {
  prompt: "",
  name: "",
  preset: "weekday",
  hour: 9,
  minute: 0,
};

// UI copy only (label mapping), not business logic — the cron itself is built by
// the shared `buildCronFromPreset` helper.
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

function parseRepoInput(fullName: string): { owner: string; name: string } | null {
  const segments = fullName.trim().split("/").filter(Boolean);
  if (segments.length < 2) return null;
  return { owner: segments[0], name: segments[1] };
}

type CreateAutomationModalProps = {
  open: boolean;
  draft: AutomationDraft;
  repos: Repo[];
  reposLoaded: boolean;
  editingRule?: ScheduledRule | null;
  onClose: () => void;
  onSaved: (rule: ScheduledRule) => void;
};

export function CreateAutomationModal({
  open,
  draft,
  repos,
  reposLoaded,
  editingRule = null,
  onClose,
  onSaved,
}: CreateAutomationModalProps) {
  const [repoFullName, setRepoFullName] = useState("");
  const [preset, setPreset] = useState<SchedulePreset>(draft.preset);
  const [hour, setHour] = useState(draft.hour);
  const [minute, setMinute] = useState(draft.minute);
  const [cron, setCron] = useState("");
  const [prompt, setPrompt] = useState(draft.prompt);
  const [name, setName] = useState(draft.name);
  const [slackChannelId, setSlackChannelId] = useState("");
  const [slackTeamId, setSlackTeamId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const repoFieldId = useId();
  const presetFieldId = useId();
  const hourFieldId = useId();
  const minuteFieldId = useId();
  const cronFieldId = useId();
  const promptFieldId = useId();
  const nameFieldId = useId();
  const slackChannelFieldId = useId();
  const slackTeamFieldId = useId();

  // Re-seed the form each time the modal is opened with a fresh draft (NL text,
  // a template, or blank). Runs on the open→ transition, including mount.
  useSyncEffect(() => {
    if (!open) return;
    setRepoFullName(editingRule ? `${editingRule.repoOwner}/${editingRule.repoName}` : "");
    setPreset(editingRule ? "custom" : draft.preset);
    setHour(draft.hour);
    setMinute(draft.minute);
    setCron(editingRule?.cron ?? "");
    setPrompt(editingRule?.promptTemplate ?? draft.prompt);
    setName(editingRule?.name ?? draft.name);
    setSlackChannelId(editingRule?.slackChannelId ?? "");
    setSlackTeamId(editingRule?.slackTeamId ?? "");
    setSubmitting(false);
    setError(null);
    // Seeds from the current `draft`; re-seeding is keyed on the open transition.
  }, [open]);

  const repoParsed = parseRepoInput(repoFullName);
  const effectiveCron = preset === "custom" ? cron : buildCronFromPreset(preset, hour, minute);
  const cronInlineError = preset === "custom" && cron.length > 0 ? preValidateCron(cron) : null;

  const slackChannelTrimmed = slackChannelId.trim();
  const slackTeamTrimmed = slackTeamId.trim();
  const slackDeliveryPartial = slackChannelTrimmed.length > 0 !== slackTeamTrimmed.length > 0;
  const slackInlineError = slackDeliveryPartial
    ? "Enter both a channel ID and a workspace ID, or leave both blank."
    : null;

  const canSubmit =
    !submitting &&
    repoParsed !== null &&
    effectiveCron.trim().length > 0 &&
    !cronInlineError &&
    !slackInlineError &&
    prompt.trim().length > 0;

  async function handleSubmit() {
    if (!canSubmit || !repoParsed) return;
    setSubmitting(true);
    setError(null);
    try {
      const values = {
        cron: effectiveCron.trim(),
        prompt: prompt.trim(),
        name: name.trim() ? name.trim() : null,
        slackTeamId: slackTeamTrimmed || null,
        slackChannelId: slackChannelTrimmed || null,
      };
      const saved = editingRule
        ? await updateScheduledRule(editingRule.id, values)
        : await createScheduledRule({ repoOwner: repoParsed.owner, repoName: repoParsed.name, ...values });
      onSaved(saved);
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught.message);
      else
        setError(
          caught instanceof Error ? caught.message : `Failed to ${editingRule ? "update" : "create"} automation`,
        );
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editingRule ? "Edit automation" : "New automation"}
      className="max-w-lg"
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" size="md" onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? (editingRule ? "Saving…" : "Creating…") : editingRule ? "Save changes" : "Create automation"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-text-muted">
          Each run opens a PR, or does nothing when there is no change to make. Runs in UTC.
        </p>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={repoFieldId} className="text-base text-text-primary">
            Repository
          </label>
          <Select
            id={repoFieldId}
            value={repoFullName}
            disabled={!reposLoaded || editingRule !== null}
            onChange={(event) => setRepoFullName(event.target.value)}
          >
            <option value="">{reposLoaded ? "Select a repository" : "Loading repositories…"}</option>
            {repos.map((repo) => (
              <option key={repo.fullName} value={repo.fullName}>
                {repo.fullName}
              </option>
            ))}
          </Select>
        </div>

        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={presetFieldId} className="text-base text-text-primary">
              Repeats
            </label>
            <Select
              id={presetFieldId}
              value={preset}
              onChange={(event) => setPreset(event.target.value as SchedulePreset)}
            >
              {SCHEDULE_PRESET_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>

          {preset !== "hourly" && preset !== "custom" ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={hourFieldId} className="text-base text-text-primary">
                At (UTC)
              </label>
              <div className="flex items-center gap-2">
                <Select
                  id={hourFieldId}
                  value={hour}
                  onChange={(event) => setHour(Number(event.target.value))}
                  wrapperClassName="w-20"
                  className="font-mono-tabular tabular-nums"
                >
                  {HOUR_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {String(option).padStart(2, "0")}
                    </option>
                  ))}
                </Select>
                <span className="text-text-muted">:</span>
                <Select
                  id={minuteFieldId}
                  value={minute}
                  onChange={(event) => setMinute(Number(event.target.value))}
                  wrapperClassName="w-20"
                  className="font-mono-tabular tabular-nums"
                >
                  {MINUTE_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {String(option).padStart(2, "0")}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          ) : null}
        </div>

        {preset === "custom" ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={cronFieldId} className="text-base text-text-primary">
              Cron expression
            </label>
            <Input
              id={cronFieldId}
              type="text"
              value={cron}
              onChange={(event) => setCron(event.target.value)}
              placeholder="0 14 * * 1-5"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
            {cronInlineError ? (
              <p className="text-xs text-error" role="alert">
                {cronInlineError}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="flex items-baseline justify-between gap-3 border border-border bg-surface-1 px-3.5 py-2.5 text-base">
          <span className="text-text-muted">Schedule</span>
          <span className="font-mono-tabular text-text-primary tabular-nums">
            {effectiveCron.trim() ? humanizeCron(effectiveCron) : "—"}
          </span>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={promptFieldId} className="text-base text-text-primary">
            Prompt
          </label>
          <Textarea
            id={promptFieldId}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={5}
            placeholder="Review low-risk failing tests in this repository. If you can make a safe fix, implement it, test it, and open a PR."
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={nameFieldId} className="text-base text-text-primary">
            Name (optional)
          </label>
          <Input
            id={nameFieldId}
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            placeholder="Weekday flake sweep"
            autoComplete="off"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-base text-text-primary">Deliver to Slack (optional)</span>
          <p className="text-xs text-text-muted">
            Post each run's result to a Slack channel. Invite the Cycloid bot to the channel first.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              id={slackChannelFieldId}
              type="text"
              value={slackChannelId}
              onChange={(event) => setSlackChannelId(event.target.value)}
              placeholder="Channel ID (e.g. C0123ABC)"
              aria-label="Slack channel ID"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
            <Input
              id={slackTeamFieldId}
              type="text"
              value={slackTeamId}
              onChange={(event) => setSlackTeamId(event.target.value)}
              placeholder="Workspace ID (e.g. T0123ABC)"
              aria-label="Slack workspace ID"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
          </div>
          <p className="text-xs text-text-muted">
            Find the channel ID in Slack: open the channel, click its name, and copy the ID from the bottom of the About
            tab. The workspace ID is the T… value in your Slack URL (app.slack.com/client/T…).
          </p>
          {slackInlineError ? (
            <p className="text-xs text-error" role="alert">
              {slackInlineError}
            </p>
          ) : null}
        </div>

        {error ? (
          <p className="editorial-fade text-xs text-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
