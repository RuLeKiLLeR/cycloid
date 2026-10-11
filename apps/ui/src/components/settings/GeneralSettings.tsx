import { useId, useRef, useState } from "react";

import { fetchSettings, updateSettings } from "../../api/settings";
import { useSyncEffect } from "../../hooks/useEffects";
import type { PlanModeSetting, UserSettings, UserSettingsUpdate } from "../../types";
import { useLayoutContext } from "../Layout";
import { Toggle } from "../Toggle";
import { Select } from "../ui";
import { DisplaySettingsSection } from "./DisplaySettingsSection";
import {
  SettingsField,
  SettingsPageHeader,
  SettingsRow,
  SettingsScopeBadge,
  SettingsSection,
  SettingsSkeleton,
} from "./SettingsLayout";

export function GeneralSettings() {
  const {
    capabilities,
    models,
    onDefaultModelChange,
    repos,
    reposLoaded,
    settings,
    settingsLoaded,
    settingsError,
    setSettings,
  } = useLayoutContext();
  const [pendingSaveCount, setPendingSaveCount] = useState(0);
  const [repoError, setRepoError] = useState<string | null>(null);
  const saveRequestSequenceByField = useRef<Partial<Record<keyof UserSettings, number>>>({});
  const saveRequestSequence = useRef(0);
  const modelSelectId = useId();
  const repoSelectId = useId();
  const saving = pendingSaveCount > 0;

  useSyncEffect(() => {
    if (!settingsLoaded || settings) return;
    fetchSettings({ scope: "full" })
      .then((loaded) => setSettings(loaded))
      .catch(() => undefined);
  }, [settings, settingsLoaded, setSettings]);

  async function save(
    patch: UserSettingsUpdate,
    options?: { onSuccess?: () => void; onError?: (message: string) => void },
  ): Promise<boolean> {
    const patchKeys = Object.keys(patch) as Array<keyof UserSettings>;
    const requestSequence = ++saveRequestSequence.current;
    const patchSequences = Object.fromEntries(
      patchKeys.map((key) => {
        const nextSequence = (saveRequestSequenceByField.current[key] ?? 0) + 1;
        saveRequestSequenceByField.current[key] = nextSequence;
        return [key, nextSequence];
      }),
    ) as Partial<Record<keyof UserSettings, number>>;
    setPendingSaveCount((count) => count + 1);
    try {
      const updated = await updateSettings(patch);
      const isLatestForPatch = patchKeys.every(
        (key) => saveRequestSequenceByField.current[key] === patchSequences[key],
      );
      if (!isLatestForPatch) return false;
      const authoritativePatch = Object.fromEntries(patchKeys.map((key) => [key, updated[key]])) as UserSettingsUpdate;
      setSettings((current) =>
        current && requestSequence !== saveRequestSequence.current
          ? { ...current, ...authoritativePatch }
          : current
            ? { ...current, ...authoritativePatch, ...updated }
            : updated,
      );
      options?.onSuccess?.();
      return true;
    } catch (error) {
      const isLatestForPatch = patchKeys.every(
        (key) => saveRequestSequenceByField.current[key] === patchSequences[key],
      );
      if (!isLatestForPatch) return false;
      options?.onError?.(error instanceof Error ? error.message : "Failed to save");
      return false;
    } finally {
      setPendingSaveCount((count) => Math.max(0, count - 1));
    }
  }

  if (!settingsLoaded) {
    return <SettingsSkeleton rows={4} />;
  }

  if (!settings) {
    return <div className="text-sm text-error">{settingsError ?? "Failed to load settings."}</div>;
  }

  const currentSettings = settings;
  const currentPlanModeSetting: PlanModeSetting = currentSettings.planMode;
  const profileOptions = [
    {
      value: "manual" as const,
      title: "Manual",
      description: "Plan and pause for your approval before anything runs.",
    },
    {
      value: "autonomous" as const,
      title: "Autonomous",
      description: "Plan when useful and keep work moving unattended.",
    },
    { value: "custom" as const, title: "Custom", description: "Choose each stage yourself." },
  ];
  const autoDefaultModelLabel = models.flatMap((provider) => provider.models)[0]?.name;

  return (
    <div className="editorial-fade space-y-6">
      <SettingsPageHeader
        eyebrow="Preferences"
        title="Preferences"
        description="Your account preferences and session defaults."
      />

      <SettingsSection
        title="Session behavior"
        description="What context Cycloid may reuse, and how it follows up on your sessions."
        meta={<SettingsScopeBadge scope="user" />}
      >
        <div className="grid gap-3 md:grid-cols-3">
          {profileOptions.map((profile) => (
            <button
              key={profile.value}
              type="button"
              disabled={saving}
              onClick={() => void save({ settingsProfile: profile.value })}
              className={`rounded-lg border p-4 text-left transition-colors ${
                currentSettings.settingsProfile === profile.value
                  ? "border-accent bg-surface-secondary"
                  : "border-border hover:border-accent"
              }`}
            >
              <span className="block text-sm font-medium">{profile.title}</span>
              <span className="mt-1 block text-xs text-foreground-muted">{profile.description}</span>
            </button>
          ))}
        </div>
        <details
          className="mt-5 rounded-lg border border-border px-4"
          open={currentSettings.settingsProfile === "custom"}
        >
          <summary className="cursor-pointer py-3 text-sm font-medium">What runs unattended</summary>
          <div className="pb-2">
            <SettingsRow
              title="Open pull requests as drafts"
              control={
                <Toggle
                  checked={currentSettings.defaultPrDraft}
                  onChange={() => save({ defaultPrDraft: !currentSettings.defaultPrDraft })}
                  label="Open pull requests as drafts"
                  showLabel={false}
                  disabled={currentSettings.settingsProfile !== "custom"}
                />
              }
            />
            <SettingsRow
              title="QA-test my PRs at publish"
              description="Cycloid runs a QA test on your published PRs and DMs you the result."
              control={
                <Toggle
                  checked={currentSettings.autoVerifyEnabled}
                  onChange={() => save({ autoVerifyEnabled: !currentSettings.autoVerifyEnabled })}
                  label="QA-test my PRs at publish"
                  showLabel={false}
                  disabled={currentSettings.settingsProfile !== "custom"}
                />
              }
            />
            <SettingsRow
              title="Automatic review handling"
              description="Cycloid addresses reviewer comments and resolves merge conflicts on its PRs."
              control={
                <Toggle
                  checked={currentSettings.automaticReviewsEnabled}
                  onChange={() => save({ automaticReviewsEnabled: !currentSettings.automaticReviewsEnabled })}
                  label="Automatic review handling"
                  showLabel={false}
                  disabled={currentSettings.settingsProfile !== "custom"}
                />
              }
            />
            {capabilities?.planApproval === true && (
              <>
                <SettingsRow
                  title="Plan generation"
                  description="Choose whether Cycloid writes a plan before implementation."
                  control={
                    <fieldset role="radiogroup" className="flex items-center gap-3">
                      <legend className="sr-only">Plan generation</legend>
                      {["off", "auto", "on"].map((setting) => (
                        <label
                          key={setting}
                          className="control-sm inline-flex cursor-pointer items-center gap-1.5 text-xs"
                        >
                          <input
                            type="radio"
                            name="plan-mode-setting"
                            value={setting}
                            checked={currentPlanModeSetting === setting}
                            disabled={saving || currentSettings.settingsProfile !== "custom"}
                            onChange={() => void save({ planMode: setting as PlanModeSetting })}
                            className="size-4 cursor-pointer accent-accent disabled:cursor-not-allowed"
                          />
                          {setting === "off" ? "Off" : setting === "auto" ? "Auto" : "On"}
                        </label>
                      ))}
                    </fieldset>
                  }
                />
                <SettingsRow
                  title="Wait for plan approval"
                  description="When plan generation is off, this setting has no effect."
                  control={
                    <Toggle
                      checked={currentSettings.planApprovalRequired}
                      onChange={() => save({ planApprovalRequired: !currentSettings.planApprovalRequired })}
                      label="Wait for plan approval"
                      showLabel={false}
                      disabled={currentSettings.settingsProfile !== "custom" || currentPlanModeSetting === "off"}
                    />
                  }
                />
              </>
            )}
            <p className="border-t border-border py-3 text-xs text-foreground-muted">Merge is always your call.</p>
          </div>
        </details>
      </SettingsSection>

      <SettingsSection
        title="Session defaults"
        description="Used when Slack, Linear, or quick actions don't specify one."
        meta={<SettingsScopeBadge scope="user" />}
      >
        <div className="space-y-5">
          <SettingsField label="Default model" htmlFor={modelSelectId}>
            <Select
              id={modelSelectId}
              value={currentSettings.defaultModel ?? ""}
              onChange={(e) => {
                const value = e.target.value || null;
                save({ defaultModel: value });
                onDefaultModelChange?.(value);
              }}
            >
              <option value="">{autoDefaultModelLabel ? `Auto (${autoDefaultModelLabel})` : "Auto"}</option>
              {models.flatMap((p) =>
                p.models.map((m) => (
                  <option key={`${p.id}:${m.id}`} value={m.id} disabled={p.hasApiKey === false}>
                    {m.label}
                    {p.hasApiKey === false ? " (API key required)" : ""}
                  </option>
                )),
              )}
            </Select>
          </SettingsField>

          <SettingsField
            label="Default repository"
            htmlFor={repoSelectId}
            hint="Used for Slack and Linear when no repository is specified."
            error={repoError}
          >
            <Select
              id={repoSelectId}
              value={currentSettings.defaultRepo ?? ""}
              disabled={!reposLoaded}
              onChange={(e) => {
                const value = e.target.value || null;
                void save(
                  { defaultRepo: value },
                  {
                    onSuccess: () => setRepoError(null),
                    onError: (message) => setRepoError(message),
                  },
                );
              }}
            >
              <option value="">None</option>
              {repos.map((repo) => (
                <option key={repo.fullName} value={repo.fullName}>
                  {repo.fullName}
                </option>
              ))}
            </Select>
          </SettingsField>
        </div>
      </SettingsSection>

      <DisplaySettingsSection />

      {saving && (
        <p role="status" className="text-xs text-text-muted">
          Saving…
        </p>
      )}
    </div>
  );
}
