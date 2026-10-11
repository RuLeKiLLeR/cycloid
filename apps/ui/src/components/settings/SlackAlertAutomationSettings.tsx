import { useId, useMemo, useRef, useState } from "react";

import { SLACK_ALERT_AUTOMATION_DEFAULT_PROMPTS } from "../../../../../shared/constants/slack-alert-prompts";
import type {
  SlackAlertAutomationProvider,
  SlackAlertAutomationRule,
  SlackAlertSenderCandidate,
} from "../../api/automation-alerts";
import {
  deleteSlackAlertAutomationRule,
  detectSlackAlertSenders,
  fetchSlackAlertAutomationRules,
  saveSlackAlertAutomationRule,
  updateSlackAlertAutomationRule,
} from "../../api/automation-alerts";
import type { SlackWorkspaceMemoryChannel, SlackWorkspaceMemoryInstall } from "../../api/company-memory";
import { fetchSlackChannelMemorySettings, fetchSlackWorkspaceMemoryChannels } from "../../api/company-memory";
import { useSyncEffect } from "../../hooks/useEffects";
import type { Provider } from "../../types";
import { useConfirm } from "../ConfirmDialog";
import { RefreshIcon } from "../icons";
import { useLayoutContext } from "../Layout";
import { Button, Input, Select, Textarea } from "../ui";
import { SettingsField, SettingsScopeBadge, SettingsSection, SettingsSkeleton } from "./SettingsLayout";
import { channelLabel, workspaceLabel } from "./slackMemoryShared";
import { parseRepoFullName } from "./workspaceSettingsShared";

type FormState = {
  teamId: string;
  channelId: string;
  provider: SlackAlertAutomationProvider;
  senderKey: string;
  repoFullName: string;
  modelId: string;
  promptTemplate: string;
};

const DEFAULT_PROMPTS: Record<SlackAlertAutomationProvider, string> = SLACK_ALERT_AUTOMATION_DEFAULT_PROMPTS;

const EMPTY_FORM: FormState = {
  teamId: "",
  channelId: "",
  provider: "datadog",
  senderKey: "",
  repoFullName: "",
  modelId: "",
  promptTemplate: DEFAULT_PROMPTS.datadog,
};

function candidateKey(candidate: Pick<SlackAlertSenderCandidate, "appId" | "botId">): string {
  return `${candidate.appId ?? ""}:${candidate.botId ?? ""}`;
}

function candidateLabel(candidate: SlackAlertSenderCandidate): string {
  const name = candidate.botName?.trim() || "Detected sender";
  return `${name} (${candidate.messageCount}) - ${senderIdTitle(candidate)}`;
}

function senderIdTitle(candidate: Pick<SlackAlertSenderCandidate, "appId" | "botId">): string {
  const app = candidate.appId ? `app ${candidate.appId}` : "no app id";
  const bot = candidate.botId ? `bot ${candidate.botId}` : "no bot id";
  return `${app}; ${bot}`;
}

function repoOptions(repos: Array<{ fullName: string }>, current: string): string[] {
  const values = new Set<string>();
  if (current) values.add(current);
  for (const repo of repos) values.add(repo.fullName);
  return [...values];
}

function ruleKey(rule: SlackAlertAutomationRule): string {
  return rule.id;
}

function ruleProviderLabel(provider: SlackAlertAutomationProvider): string {
  return provider === "datadog" ? "Datadog" : "Sentry";
}

function isBasetenProvider(provider: Provider): boolean {
  return provider.id.toLowerCase() === "baseten" || provider.name.toLowerCase().includes("baseten");
}

function chooseDefaultModelId(providers: Provider[]): string {
  const basetenModel = providers.find(isBasetenProvider)?.models[0]?.id;
  if (basetenModel) return basetenModel;
  return providers.find((provider) => provider.hasApiKey !== false && provider.models.length > 0)?.models[0]?.id ?? "";
}

function findProviderForModel(providers: Provider[], modelId: string): Provider | null {
  return providers.find((provider) => provider.models.some((model) => model.id === modelId)) ?? null;
}

export function SlackAlertAutomationSettings({
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
  const { models: layoutModels } = useLayoutContext();
  const models = layoutModels ?? [];
  const confirm = useConfirm();
  const modelSelectId = useId();
  const [rules, setRules] = useState<SlackAlertAutomationRule[]>([]);
  const [workspaces, setWorkspaces] = useState<SlackWorkspaceMemoryInstall[]>([]);
  const [channels, setChannels] = useState<SlackWorkspaceMemoryChannel[]>([]);
  const [candidates, setCandidates] = useState<SlackAlertSenderCandidate[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [channelLoadState, setChannelLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [detectState, setDetectState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [saving, setSaving] = useState(false);
  const [deletingRuleId, setDeletingRuleId] = useState<string | null>(null);
  const [updatingRuleId, setUpdatingRuleId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Channel names for rule rows, keyed `${teamId}:${channelId}`. The form's
  // channel list only covers the currently selected workspace and is cleared on
  // every team switch, so rule rows keep their own accumulated name map.
  const [ruleChannelNames, setRuleChannelNames] = useState<ReadonlyMap<string, string>>(new Map());
  const fetchedChannelTeamsRef = useRef<Set<string>>(new Set());

  function mergeChannelNames(teamId: string, teamChannels: SlackWorkspaceMemoryChannel[]) {
    setRuleChannelNames((current) => {
      const next = new Map(current);
      for (const channel of teamChannels) next.set(`${teamId}:${channel.id}`, channel.name);
      return next;
    });
  }

  useSyncEffect(() => {
    let canceled = false;
    setLoadState("loading");
    Promise.all([fetchSlackChannelMemorySettings(businessId), fetchSlackAlertAutomationRules(businessId)])
      .then(([settings, automationRules]) => {
        if (canceled) return;
        const workspaceRows = Array.isArray(settings.workspaces) ? settings.workspaces : [];
        const preferredRepo =
          defaultRepo && repos.some((repo) => repo.fullName === defaultRepo) ? defaultRepo : (repos[0]?.fullName ?? "");
        setWorkspaces(workspaceRows);
        setRules(Array.isArray(automationRules) ? automationRules : []);
        setForm((current) => ({
          ...current,
          teamId: current.teamId || workspaceRows.find((workspace) => !workspace.uninstalledAt)?.teamId || "",
          repoFullName: current.repoFullName || preferredRepo,
          modelId: current.modelId || chooseDefaultModelId(models),
        }));
        setError(null);
        setLoadState("ready");
      })
      .catch((err) => {
        if (canceled) return;
        setError(err instanceof Error ? err.message : "Failed to load Slack alert automation settings");
        setLoadState("error");
      });
    return () => {
      canceled = true;
    };
  }, [businessId, defaultRepo, models, repos, reposLoaded]);

  useSyncEffect(() => {
    if (form.modelId) return;
    const defaultModelId = chooseDefaultModelId(models);
    if (defaultModelId) setForm((current) => ({ ...current, modelId: current.modelId || defaultModelId }));
  }, [form.modelId, models]);

  const activeWorkspaces = useMemo(
    () => workspaces.filter((workspace) => workspace.uninstalledAt === null),
    [workspaces],
  );
  const channelById = useMemo(() => new Map(channels.map((channel) => [channel.id, channel])), [channels]);
  const candidateByKey = useMemo(
    () => new Map(candidates.map((candidate) => [candidateKey(candidate), candidate])),
    [candidates],
  );
  const selectedCandidate = candidateByKey.get(form.senderKey) ?? null;
  const parsedRepo = parseRepoFullName(form.repoFullName);
  const repositoryOptions = repoOptions(repos, form.repoFullName);
  const selectedModelProvider = form.modelId ? findProviderForModel(models, form.modelId) : null;
  const selectedModelNeedsKey = selectedModelProvider?.hasApiKey === false;
  const selectedModelWarning =
    selectedModelProvider && selectedModelNeedsKey
      ? isBasetenProvider(selectedModelProvider)
        ? "Baseten API key required. Change model or add your Baseten key."
        : `${selectedModelProvider.name} API key required. Change model or add the API key.`
      : null;
  const canDetect = Boolean(form.teamId && form.channelId && detectState !== "loading");
  const canSave = Boolean(
    form.teamId &&
    form.channelId &&
    selectedCandidate &&
    parsedRepo &&
    form.modelId &&
    !selectedModelNeedsKey &&
    form.promptTemplate.trim() &&
    !saving &&
    detectState !== "loading",
  );

  useSyncEffect(() => {
    let canceled = false;
    const teamId = form.teamId.trim();
    setChannels([]);
    setCandidates([]);
    setForm((current) => ({ ...current, channelId: "", senderKey: "" }));
    if (!teamId || activeWorkspaces.length === 0) {
      setChannelLoadState("idle");
      return () => {
        canceled = true;
      };
    }
    setChannelLoadState("loading");
    fetchedChannelTeamsRef.current.add(teamId);
    fetchSlackWorkspaceMemoryChannels({ businessId, teamId })
      .then((result) => {
        if (canceled) return;
        setChannels(result);
        mergeChannelNames(teamId, result);
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

  // Resolve channel names for rule rows whose workspace is not the one selected
  // in the form (that fetch is handled above). Best-effort: a failed lookup
  // leaves the row on its raw channel ID.
  useSyncEffect(() => {
    const pendingTeamIds = [...new Set(rules.map((rule) => rule.slackTeamId))].filter(
      (teamId) => teamId && !fetchedChannelTeamsRef.current.has(teamId),
    );
    if (pendingTeamIds.length === 0) return;
    for (const teamId of pendingTeamIds) fetchedChannelTeamsRef.current.add(teamId);
    let canceled = false;
    for (const teamId of pendingTeamIds) {
      fetchSlackWorkspaceMemoryChannels({ businessId, teamId })
        .then((result) => {
          if (!canceled) mergeChannelNames(teamId, result);
        })
        .catch(() => {});
    }
    return () => {
      canceled = true;
    };
  }, [businessId, rules]);

  function updateProvider(provider: SlackAlertAutomationProvider) {
    setCandidates([]);
    setDetectState("idle");
    setForm((current) => ({
      ...current,
      provider,
      senderKey: "",
      promptTemplate:
        current.promptTemplate === DEFAULT_PROMPTS.datadog || current.promptTemplate === DEFAULT_PROMPTS.sentry
          ? DEFAULT_PROMPTS[provider]
          : current.promptTemplate,
    }));
  }

  async function handleDetect() {
    if (!canDetect) return;
    setDetectState("loading");
    setError(null);
    setCandidates([]);
    setForm((current) => ({ ...current, senderKey: "" }));
    try {
      const result = await detectSlackAlertSenders({
        businessId,
        teamId: form.teamId,
        channelId: form.channelId,
        provider: form.provider,
      });
      setCandidates(result);
      setForm((current) => ({ ...current, senderKey: result[0] ? candidateKey(result[0]) : "" }));
      setDetectState("ready");
    } catch (err) {
      setDetectState("error");
      setError(err instanceof Error ? err.message : "Failed to detect alert sender");
    }
  }

  async function handleSave() {
    if (!canSave || !selectedCandidate || !parsedRepo) return;
    setSaving(true);
    setError(null);
    try {
      const rule = await saveSlackAlertAutomationRule({
        businessId,
        teamId: form.teamId,
        channelId: form.channelId,
        provider: form.provider,
        appIds: selectedCandidate.appId ? [selectedCandidate.appId] : [],
        botIds: selectedCandidate.botId ? [selectedCandidate.botId] : [],
        repoOwner: parsedRepo.repoOwner,
        repoName: parsedRepo.repoName,
        modelId: form.modelId,
        promptTemplate: form.promptTemplate.trim(),
        name: `${ruleProviderLabel(form.provider)} alerts`,
      });
      setRules((current) => [rule, ...current.filter((item) => item.id !== rule.id)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save alert trigger");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(rule: SlackAlertAutomationRule) {
    if (
      !(await confirm({
        title: "Remove alert trigger?",
        message: `Remove the ${ruleProviderLabel(rule.triggerProvider)} alert trigger? Cycloid will stop starting sessions from these alerts.`,
        confirmLabel: "Remove",
        destructive: true,
      }))
    ) {
      return;
    }
    setDeletingRuleId(rule.id);
    setError(null);
    try {
      await deleteSlackAlertAutomationRule({ businessId, ruleId: rule.id });
      setRules((current) => current.filter((item) => item.id !== rule.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove alert trigger");
    } finally {
      setDeletingRuleId(null);
    }
  }

  async function handleToggle(rule: SlackAlertAutomationRule) {
    setUpdatingRuleId(rule.id);
    setError(null);
    try {
      const updated = await updateSlackAlertAutomationRule({
        businessId,
        ruleId: rule.id,
        enabled: !rule.enabled,
      });
      setRules((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update alert trigger");
    } finally {
      setUpdatingRuleId(null);
    }
  }

  return (
    <SettingsSection
      className="editorial-fade"
      title="Slack alert triggers"
      description="Start Cycloid sessions automatically from Datadog or Sentry alerts posted to Slack."
      meta={
        <span className="inline-flex items-center gap-2">
          <SettingsScopeBadge scope="workspace" />
          <span>
            <span className="numeral">{rules.length}</span> {rules.length === 1 ? "trigger" : "triggers"}
          </span>
        </span>
      }
    >
      <div className="space-y-5 py-5">
        {loadState === "loading" ? <SettingsSkeleton rows={3} showHeader={false} control={false} /> : null}
        {loadState === "error" ? <p className="text-base text-error">{error}</p> : null}
        {loadState !== "loading" ? (
          <div className="editorial-fade space-y-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <SettingsField
                label="Slack workspace"
                description={
                  activeWorkspaces.length === 0
                    ? "Install the Slack workspace app before configuring alert automation."
                    : undefined
                }
              >
                <Select
                  value={form.teamId}
                  onChange={(event) => setForm((current) => ({ ...current, teamId: event.target.value }))}
                  disabled={saving || activeWorkspaces.length === 0}
                >
                  {activeWorkspaces.length === 0 ? <option value="">No installed workspace</option> : null}
                  {activeWorkspaces.map((workspace) => (
                    <option key={workspace.teamId} value={workspace.teamId}>
                      {workspaceLabel(workspace)}
                    </option>
                  ))}
                </Select>
              </SettingsField>
              <SettingsField
                label="Alert channel"
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
                    setCandidates([]);
                    setDetectState("idle");
                    setForm((current) => ({ ...current, channelId: event.target.value, senderKey: "" }));
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
              <SettingsField label="Alert provider">
                <Select
                  value={form.provider}
                  onChange={(event) => updateProvider(event.target.value as SlackAlertAutomationProvider)}
                  disabled={saving}
                >
                  <option value="datadog">Datadog</option>
                  <option value="sentry">Sentry</option>
                </Select>
              </SettingsField>
              <SettingsField label="Repository">
                {repositoryOptions.length > 0 ? (
                  <Select
                    value={form.repoFullName}
                    onChange={(event) => setForm((current) => ({ ...current, repoFullName: event.target.value }))}
                    disabled={saving}
                  >
                    {repositoryOptions.map((repo) => (
                      <option key={repo} value={repo}>
                        {repo}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    value={form.repoFullName}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, repoFullName: event.currentTarget.value }))
                    }
                    placeholder="owner/repo"
                    disabled={saving}
                  />
                )}
              </SettingsField>
              <SettingsField label="Model" htmlFor={modelSelectId} error={selectedModelWarning ?? undefined}>
                <Select
                  id={modelSelectId}
                  value={form.modelId}
                  onChange={(event) => setForm((current) => ({ ...current, modelId: event.target.value }))}
                  disabled={saving || models.length === 0}
                >
                  {models.length === 0 ? <option value="">No models available</option> : null}
                  {models.flatMap((provider) =>
                    provider.models.map((model) => (
                      <option key={`${provider.id}:${model.id}`} value={model.id}>
                        {model.label}
                        {provider.hasApiKey === false ? " (API key required)" : ""}
                      </option>
                    )),
                  )}
                </Select>
              </SettingsField>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="secondary" onClick={() => void handleDetect()} disabled={!canDetect}>
                <RefreshIcon className="h-3.5 w-3.5" />
                {detectState === "loading" ? "Detecting" : "Detect sender"}
              </Button>
              <span className="text-sm text-text-muted">
                {detectState === "ready"
                  ? candidates.length === 0
                    ? "No recent bot alert senders found."
                    : `${candidates.length} sender${candidates.length === 1 ? "" : "s"} found.`
                  : "Post one alert first if no sender is detected."}
              </span>
            </div>
            <SettingsField label="Detected sender">
              <Select
                value={form.senderKey}
                onChange={(event) => setForm((current) => ({ ...current, senderKey: event.target.value }))}
                disabled={saving || candidates.length === 0}
              >
                <option value="">{candidates.length === 0 ? "No sender detected" : "Select a sender"}</option>
                {candidates.map((candidate) => (
                  <option
                    key={candidateKey(candidate)}
                    value={candidateKey(candidate)}
                    title={senderIdTitle(candidate)}
                  >
                    {candidateLabel(candidate)}
                  </option>
                ))}
              </Select>
            </SettingsField>
            <SettingsField
              label="Trigger instructions"
              description="Cycloid receives these instructions before the Slack alert context. Edit them to control when it should fix code, tune alerts, or only report findings."
            >
              <Textarea
                value={form.promptTemplate}
                onChange={(event) => setForm((current) => ({ ...current, promptTemplate: event.currentTarget.value }))}
                rows={3}
                disabled={saving}
              />
            </SettingsField>
            <div className="flex items-center justify-between gap-3">
              {error ? <p className="text-sm text-error">{error}</p> : <span />}
              <Button type="button" variant="primary" onClick={() => void handleSave()} disabled={!canSave}>
                {saving ? "Saving…" : "Save trigger"}
              </Button>
            </div>
            <div className="overflow-hidden border border-border">
              {rules.length === 0 ? (
                <p className="px-4 py-3 text-base text-text-muted">No alert triggers configured.</p>
              ) : (
                <div className="divide-y divide-border">
                  {rules.map((rule) => (
                    <AlertAutomationRuleRow
                      key={ruleKey(rule)}
                      rule={rule}
                      channelName={
                        ruleChannelNames.get(`${rule.slackTeamId}:${rule.slackChannelId}`) ??
                        channelById.get(rule.slackChannelId)?.name ??
                        null
                      }
                      deleting={deletingRuleId === rule.id}
                      updating={updatingRuleId === rule.id}
                      onToggle={handleToggle}
                      onDelete={handleDelete}
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

// No pause/resume affordance yet: the only write endpoint upserts by an id
// derived from the rule identity, which would duplicate rules seeded with
// custom ids (migration 0193) instead of updating them. Add it once a
// PATCH-by-id endpoint exists on the control plane.
function AlertAutomationRuleRow({
  rule,
  channelName,
  deleting,
  updating,
  onToggle,
  onDelete,
}: {
  rule: SlackAlertAutomationRule;
  channelName: string | null;
  deleting: boolean;
  updating: boolean;
  onToggle: (rule: SlackAlertAutomationRule) => void;
  onDelete: (rule: SlackAlertAutomationRule) => void;
}) {
  const appIds = Array.isArray(rule.allowedSlackAppIds) ? rule.allowedSlackAppIds : [];
  const botIds = Array.isArray(rule.allowedSlackBotIds) ? rule.allowedSlackBotIds : [];
  const senderTitle = `apps ${appIds.length > 0 ? appIds.join(", ") : "none"}; bots ${
    botIds.length > 0 ? botIds.join(", ") : "none"
  }`;

  return (
    <div className="grid gap-3 px-4 py-3 text-base sm:grid-cols-[minmax(0,1fr)_minmax(0,180px)_minmax(0,220px)_auto]">
      <div className="min-w-0">
        <p className="font-medium text-text-primary">
          {/* Channel name where we could resolve it; the raw ID stays behind a
              title attr either way. */}
          {ruleProviderLabel(rule.triggerProvider)} alerts in{" "}
          <span title={rule.slackChannelId}>{channelName ? `#${channelName}` : rule.slackChannelId}</span>
        </p>
        <p className="mt-1 truncate text-text-muted" title={senderTitle}>
          Triggers on one detected sender.
        </p>
      </div>
      <div>
        <p className="eyebrow">Status</p>
        <p className="mt-1">{rule.enabled ? "Active" : "Paused"}</p>
      </div>
      <div>
        <p className="eyebrow">Repository</p>
        <p className="mt-1 text-text-primary">
          {rule.repoOwner}/{rule.repoName}
        </p>
        <p className="mt-1 truncate text-text-muted" title={rule.modelId ?? undefined}>
          {rule.modelId ? "Custom model" : "Default model"}
        </p>
      </div>
      <div className="flex gap-2 self-start">
        <Button type="button" variant="secondary" size="sm" onClick={() => void onToggle(rule)} disabled={updating}>
          {updating ? "Updating…" : rule.enabled ? "Pause" : "Resume"}
        </Button>
        <Button type="button" variant="danger" size="sm" onClick={() => void onDelete(rule)} disabled={deleting}>
          {deleting ? "Removing…" : "Remove"}
        </Button>
      </div>
    </div>
  );
}
