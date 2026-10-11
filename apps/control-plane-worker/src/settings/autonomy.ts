import type { PlanModeSetting } from "../../../../shared/plan-mode.js";
import type { UserSettingsRow } from "./db";

export const SETTINGS_PROFILES = ["manual", "autonomous", "custom"] as const;
export type SettingsProfile = (typeof SETTINGS_PROFILES)[number];

export type EffectiveAutonomySettings = {
  profile: SettingsProfile;
  planMode: PlanModeSetting;
  planApprovalRequired: boolean;
  automaticReviewsEnabled: boolean;
  autoVerifyEnabled: boolean;
  mergeConflictResolutionEnabled: boolean;
  defaultPrDraft: boolean;
};

const PRESET_VALUES: Record<Exclude<SettingsProfile, "custom">, Omit<EffectiveAutonomySettings, "profile">> = {
  manual: {
    planMode: "on",
    planApprovalRequired: true,
    automaticReviewsEnabled: false,
    autoVerifyEnabled: false,
    mergeConflictResolutionEnabled: false,
    defaultPrDraft: true,
  },
  autonomous: {
    planMode: "auto",
    planApprovalRequired: false,
    automaticReviewsEnabled: true,
    autoVerifyEnabled: true,
    mergeConflictResolutionEnabled: true,
    defaultPrDraft: false,
  },
};

export function normalizeSettingsProfile(value: unknown): SettingsProfile {
  return value === "manual" || value === "autonomous" || value === "custom" ? value : "custom";
}

export function resolveEffectiveAutonomySettings(settings: UserSettingsRow | null): EffectiveAutonomySettings {
  if (!settings) {
    return {
      profile: "custom",
      ...PRESET_VALUES.manual,
      planMode: "off",
      planApprovalRequired: false,
      defaultPrDraft: false,
    };
  }

  const profile = normalizeSettingsProfile(settings.settings_profile);
  if (profile !== "custom") return { profile, ...PRESET_VALUES[profile] };

  const planMode = settings.plan_mode_setting;
  return {
    profile,
    planMode,
    planApprovalRequired:
      settings.plan_approval_required == null ? planMode !== "off" : settings.plan_approval_required !== 0,
    automaticReviewsEnabled: settings.automatic_reviews_enabled === 1,
    autoVerifyEnabled: settings.auto_verify_enabled === 1,
    mergeConflictResolutionEnabled: false,
    defaultPrDraft: settings.default_pr_draft !== 0,
  };
}

export function resolveCustomMergeConflictResolution(settings: UserSettingsRow | null, storedValue: boolean): boolean {
  const profile = normalizeSettingsProfile(settings?.settings_profile);
  return profile === "custom" ? storedValue : resolveEffectiveAutonomySettings(settings).mergeConflictResolutionEnabled;
}
