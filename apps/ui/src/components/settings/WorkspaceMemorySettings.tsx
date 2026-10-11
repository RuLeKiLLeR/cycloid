import { useMemo, useState } from "react";

import { MEMORY_FEATURE_DISABLED } from "../../../../../shared/constants/memory";
import type {
  SlackChannelMemoryIntake,
  SlackChannelMemoryScopeType,
  SlackWorkspaceMemoryChannel,
  SlackWorkspaceMemoryInstall,
} from "../../api/company-memory";
import { useSyncEffect } from "../../hooks/useEffects";
import { useConfirm } from "../ConfirmDialog";
import { useLayoutContext } from "../Layout";
import { Button, Input, Select } from "../ui";
import {
  SettingsField,
  SettingsPageHeader,
  SettingsScopeBadge,
  SettingsSection,
  SettingsSkeleton,
} from "./SettingsLayout";
import { channelLabel, workspaceLabel } from "./slackMemoryShared";
import { AdminOnlyNotice, useWorkspaceAdminAccess } from "./workspaceSettingsShared";

const SCOPE_OPTIONS: Array<{ value: SlackChannelMemoryScopeType; label: string }> = [
  { value: "generic", label: "General company knowledge" },
  { value: "customer", label: "A specific customer" },
  { value: "incident", label: "A specific incident" },
  { value: "support", label: "Support work" },
  { value: "sales", label: "Sales work" },
];

const SCOPE_LABELS: Record<SlackChannelMemoryScopeType, string> = {
  generic: "General company knowledge",
  customer: "Customer work",
  incident: "Incident response",
  support: "Support work",
  sales: "Sales work",
};

const SCOPE_TARGETS: Record<Exclude<SlackChannelMemoryScopeType, "generic">, { label: string; placeholder: string }> = {
  customer: { label: "Which customer?", placeholder: "acme" },
  incident: { label: "Which incident?", placeholder: "incident-42" },
  support: { label: "What support area?", placeholder: "enterprise-onboarding" },
  sales: { label: "What sales area?", placeholder: "strategic-accounts" },
};

type FormState = {
  teamId: string;
  channelId: string;
  scopeType: SlackChannelMemoryScopeType;
  scopeId: string;
};

const EMPTY_FORM: FormState = {
  teamId: "",
  channelId: "",
  scopeType: "generic",
  scopeId: "",
};

const TIMESTAMP_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms)) return "Unknown";
  return TIMESTAMP_FORMATTER.format(new Date(ms));
}

function ruleKey(row: Pick<SlackChannelMemoryIntake, "teamId" | "channelId">): string {
  return `${row.teamId}:${row.channelId}`;
}

function memoryDestination(row: Pick<SlackChannelMemoryIntake, "scopeType" | "scopeId">): string {
  if (row.scopeType === "generic") return "General company knowledge";
  const label = SCOPE_LABELS[row.scopeType];
  return row.scopeId ? `${label} · ${row.scopeId}` : label;
}

export function WorkspaceMemorySettings() {
  const { user } = useLayoutContext();
  const access = useWorkspaceAdminAccess();
  return (
    <div className="space-y-8">
      <SettingsPageHeader
        title="Slack memory"
        description="Cycloid learns from the Slack channels you choose in the background."
      />
      {access === "admin" && user ? (
        <SlackMemoryPanel businessId={user.businessId} />
      ) : access === "loading" ? (
        <SettingsSkeleton rows={3} />
      ) : (
        <AdminOnlyNotice message="Ask a workspace admin to manage Slack memory channels." />
      )}
    </div>
  );
}

function SlackMemoryPanel({ businessId }: { businessId: string }) {
  const confirm = useConfirm();
  const [intake, setIntake] = useState<SlackChannelMemoryIntake[]>([]);
  const [workspaces, setWorkspaces] = useState<SlackWorkspaceMemoryInstall[]>([]);
  const [channels, setChannels] = useState<SlackWorkspaceMemoryChannel[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [channelLoadState, setChannelLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [disablingKey, setDisablingKey] = useState<string | null>(null);

  useSyncEffect(() => {
    let canceled = false;
    setLoadState("loading");
    import("../../api/company-memory")
      .then(({ fetchSlackChannelMemorySettings }) => fetchSlackChannelMemorySettings(businessId))
      .then((settings) => {
        if (canceled) return;
        const intakeRows = Array.isArray(settings.intake) ? settings.intake : [];
        const workspaceRows = Array.isArray(settings.workspaces) ? settings.workspaces : [];
        setIntake(intakeRows);
        setWorkspaces(workspaceRows);
        setForm((current) => ({
          ...current,
          teamId: current.teamId || workspaceRows.find((workspace) => !workspace.uninstalledAt)?.teamId || "",
        }));
        setError(null);
        setLoadState("ready");
      })
      .catch((err) => {
        if (canceled) return;
        setError(err instanceof Error ? err.message : "Failed to load Slack channel memory settings");
        setLoadState("error");
      });
    return () => {
      canceled = true;
    };
  }, [businessId]);

  const activeWorkspaces = useMemo(
    () => workspaces.filter((workspace) => workspace.uninstalledAt === null),
    [workspaces],
  );
  const channelById = useMemo(() => new Map(channels.map((channel) => [channel.id, channel])), [channels]);
  const selectedScopeTarget = form.scopeType === "generic" ? null : SCOPE_TARGETS[form.scopeType];
  const canSave = Boolean(
    form.teamId.trim() && form.channelId.trim() && (form.scopeType === "generic" || form.scopeId.trim()) && !saving,
  );

  useSyncEffect(() => {
    let canceled = false;
    const teamId = form.teamId.trim();
    setChannels([]);
    setForm((current) => ({ ...current, channelId: "" }));
    if (!teamId || activeWorkspaces.length === 0) {
      setChannelLoadState("idle");
      return () => {
        canceled = true;
      };
    }
    setChannelLoadState("loading");
    import("../../api/company-memory")
      .then(({ fetchSlackWorkspaceMemoryChannels }) => fetchSlackWorkspaceMemoryChannels({ businessId, teamId }))
      .then((result) => {
        if (canceled) return;
        setChannels(result);
        setChannelLoadState("ready");
      })
      .catch((err) => {
        if (canceled) return;
        setChannelLoadState("error");
        setError(err instanceof Error ? err.message : "Failed to load Slack channels");
      });
    return () => {
      canceled = true;
    };
  }, [activeWorkspaces.length, businessId, form.teamId]);

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const { saveSlackChannelMemoryIntake } = await import("../../api/company-memory");
      const row = await saveSlackChannelMemoryIntake({
        businessId,
        teamId: form.teamId,
        channelId: form.channelId,
        scopeType: form.scopeType,
        scopeId: form.scopeType === "generic" ? null : form.scopeId.trim(),
      });
      setIntake((current) => [row, ...current.filter((item) => ruleKey(item) !== ruleKey(row))]);
      setForm((current) => ({ ...current, channelId: "", scopeId: "" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save Slack channel memory settings");
    } finally {
      setSaving(false);
    }
  }

  async function handleDisable(row: SlackChannelMemoryIntake) {
    const channel = channelById.get(row.channelId);
    const label = channel ? `#${channel.name}` : row.channelId;
    if (
      !(await confirm({
        title: "Stop tracking channel?",
        message: `Stop tracking ${label}? Cycloid will no longer learn from this channel in the background.`,
        confirmLabel: "Remove",
        destructive: true,
      }))
    ) {
      return;
    }
    const key = ruleKey(row);
    setDisablingKey(key);
    setError(null);
    try {
      const { disableSlackChannelMemoryIntake } = await import("../../api/company-memory");
      await disableSlackChannelMemoryIntake({ businessId, teamId: row.teamId, channelId: row.channelId });
      setIntake((current) => current.filter((item) => ruleKey(item) !== key));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disable Slack channel memory");
    } finally {
      setDisablingKey(null);
    }
  }

  return (
    <SettingsSection
      className="editorial-fade"
      title="Tracked channels"
      description="Choose the Slack channels Cycloid should learn from in the background."
      meta={
        <span className="inline-flex items-center gap-2">
          <SettingsScopeBadge scope="workspace" />
          <span>
            <span className="numeral">{intake.length}</span> {intake.length === 1 ? "channel" : "channels"}
          </span>
        </span>
      }
    >
      <div className="space-y-5 py-5">
        {loadState === "loading" ? <SettingsSkeleton rows={3} showHeader={false} control={false} /> : null}
        {loadState === "error" ? <p className="text-base text-error">{error}</p> : null}
        {loadState !== "loading" ? (
          <div className="editorial-fade space-y-5">
            {MEMORY_FEATURE_DISABLED ? (
              <p className="border border-warning-soft-border bg-warning-soft px-3 py-2 text-base text-warning">
                Channel choices are saved now. Prompt injection remains disabled until memory tools are enabled for
                sessions.
              </p>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
              <SettingsField
                label="Slack workspace"
                description={
                  activeWorkspaces.length === 0 ? "Install the Slack workspace app before adding channels." : undefined
                }
              >
                {activeWorkspaces.length > 0 ? (
                  <Select
                    value={form.teamId}
                    onChange={(event) => setForm((current) => ({ ...current, teamId: event.target.value }))}
                    disabled={saving}
                  >
                    {activeWorkspaces.map((workspace) => (
                      <option key={workspace.teamId} value={workspace.teamId}>
                        {workspaceLabel(workspace)}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    aria-label="Slack team ID"
                    value={form.teamId}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setForm((current) => ({ ...current, teamId: value }));
                    }}
                    placeholder="Slack team ID"
                    disabled={saving}
                  />
                )}
              </SettingsField>
              <SettingsField
                label="Channel"
                description={
                  channelLoadState === "loading"
                    ? "Loading channels from Slack…"
                    : channelLoadState === "error"
                      ? "Could not load channels from Slack."
                      : undefined
                }
              >
                <Select
                  value={form.channelId}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setForm((current) => ({ ...current, channelId: value }));
                  }}
                  disabled={saving || channelLoadState !== "ready" || channels.length === 0}
                >
                  <option value="">
                    {channelLoadState === "loading"
                      ? "Loading channels…"
                      : channels.length === 0
                        ? "No accessible channels"
                        : "Select a channel"}
                  </option>
                  {channels.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      {channelLabel(channel)}
                    </option>
                  ))}
                </Select>
              </SettingsField>
              <SettingsField label="What is this channel for?">
                <Select
                  value={form.scopeType}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      scopeType: event.target.value as SlackChannelMemoryScopeType,
                      scopeId: event.target.value === "generic" ? "" : current.scopeId,
                    }))
                  }
                  disabled={saving}
                >
                  {SCOPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </SettingsField>
              {selectedScopeTarget ? (
                <SettingsField label={selectedScopeTarget.label}>
                  <Input
                    aria-label={selectedScopeTarget.label}
                    value={form.scopeId}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setForm((current) => ({ ...current, scopeId: value }));
                    }}
                    placeholder={selectedScopeTarget.placeholder}
                    disabled={saving}
                  />
                </SettingsField>
              ) : null}
            </div>
            <div className="flex items-center justify-between gap-3">
              {error ? <p className="text-sm text-error">{error}</p> : <span />}
              <Button type="button" onClick={() => void handleSave()} disabled={!canSave} variant="primary">
                {saving ? "Saving…" : "Add channel"}
              </Button>
            </div>
            <div className="overflow-hidden border border-border">
              {intake.length === 0 ? (
                <p className="px-4 py-3 text-base text-text-muted">No ambient Slack channels are tracked.</p>
              ) : (
                <div className="divide-y divide-border">
                  {intake.map((row) => (
                    <TrackedChannelRow
                      key={ruleKey(row)}
                      row={row}
                      channel={channelById.get(row.channelId)}
                      disabling={disablingKey === ruleKey(row)}
                      onDisable={handleDisable}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
}

function TrackedChannelRow({
  row,
  channel,
  disabling,
  onDisable,
}: {
  row: SlackChannelMemoryIntake;
  channel: SlackWorkspaceMemoryChannel | undefined;
  disabling: boolean;
  onDisable: (row: SlackChannelMemoryIntake) => void;
}) {
  return (
    <div className="grid gap-3 px-4 py-3 text-base sm:grid-cols-[minmax(0,1fr)_minmax(0,220px)_150px_auto]">
      <div className="min-w-0">
        <p className="font-medium text-text-primary" title={row.channelId}>
          {channel ? `#${channel.name}` : row.channelId}
        </p>
        <p className="mt-1 truncate text-text-muted" title={`${row.teamId}:${row.channelId}`}>
          {channel ? `${channel.isPrivate ? "Private" : "Public"} channel` : "Channel details unavailable"}
        </p>
      </div>
      <div>
        <p className="eyebrow">Channel purpose</p>
        <p className="mt-1 text-text-primary">{memoryDestination(row)}</p>
      </div>
      <div>
        <p className="eyebrow">Tracking since</p>
        <p
          className="mt-1 text-text-primary"
          title={row.enabledByUserId ? `Enabled by user ${row.enabledByUserId}` : undefined}
        >
          {formatTimestamp(row.enabledAtMs)}
        </p>
      </div>
      <Button
        type="button"
        variant="danger"
        size="sm"
        onClick={() => void onDisable(row)}
        disabled={disabling}
        className="self-start"
      >
        {disabling ? "Removing…" : "Remove"}
      </Button>
    </div>
  );
}
