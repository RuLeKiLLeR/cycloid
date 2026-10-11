import { describe, expect, it } from "vitest";

import {
  resolveCustomMergeConflictResolution,
  resolveEffectiveAutonomySettings,
} from "../../apps/control-plane-worker/src/settings/autonomy";
import type { UserSettingsRow } from "../../apps/control-plane-worker/src/settings/db";

// Keep the profile resolver's effective-value contract covered independently from route wiring.

function settings(overrides: Partial<UserSettingsRow> = {}): UserSettingsRow {
  return {
    user_id: 1,
    default_pr_draft: 0,
    auto_verify_enabled: 0,
    automatic_reviews_enabled: 0,
    plan_mode_setting: "off",
    plan_approval_required: null,
    settings_profile: null,
    use_codex_subscription: 0,
    default_model: null,
    default_repo: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

describe("autonomy profile resolution", () => {
  it.each([
    [
      "manual",
      {
        planMode: "on",
        planApprovalRequired: true,
        automaticReviewsEnabled: false,
        autoVerifyEnabled: false,
        mergeConflictResolutionEnabled: false,
        defaultPrDraft: true,
      },
    ],
    [
      "autonomous",
      {
        planMode: "auto",
        planApprovalRequired: false,
        automaticReviewsEnabled: true,
        autoVerifyEnabled: true,
        mergeConflictResolutionEnabled: true,
        defaultPrDraft: false,
      },
    ],
  ] as const)("uses %s preset values regardless of stored knobs", (profile, expected) => {
    expect(
      resolveEffectiveAutonomySettings(
        settings({
          settings_profile: profile,
          plan_mode_setting: "off",
          plan_approval_required: 1,
          automatic_reviews_enabled: 0,
          auto_verify_enabled: 0,
          default_pr_draft: 1,
        }),
      ),
    ).toMatchObject({ profile, ...expected });
  });

  it("falls through to stored values for Custom and NULL", () => {
    expect(
      resolveEffectiveAutonomySettings(
        settings({
          plan_mode_setting: "on",
          plan_approval_required: 0,
          automatic_reviews_enabled: 1,
          auto_verify_enabled: 1,
          default_pr_draft: 1,
        }),
      ),
    ).toMatchObject({ profile: "custom", planMode: "on", planApprovalRequired: false, automaticReviewsEnabled: true });
  });

  it("fails closed when settings cannot be loaded", () => {
    expect(resolveEffectiveAutonomySettings(null)).toMatchObject({
      planMode: "off",
      planApprovalRequired: false,
      automaticReviewsEnabled: false,
      autoVerifyEnabled: false,
      mergeConflictResolutionEnabled: false,
      defaultPrDraft: false,
    });
  });

  it("lets presets control the merge-conflict arm before a missing-row default", () => {
    expect(resolveCustomMergeConflictResolution(settings({ settings_profile: "manual" }), true)).toBe(false);
    expect(resolveCustomMergeConflictResolution(settings({ settings_profile: "autonomous" }), false)).toBe(true);
    expect(resolveCustomMergeConflictResolution(settings(), true)).toBe(true);
  });
});
