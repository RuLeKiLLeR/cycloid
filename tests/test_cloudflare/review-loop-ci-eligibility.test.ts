import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUserSettingsIfExists = vi.fn();
const mockGetUserPrReviewBotSettings = vi.fn();
const mockGetInstallationByOwner = vi.fn();
const mockUpdateInstallationPermissions = vi.fn();
const mockGetAppInstallationCapabilities = vi.fn();

vi.mock("../../apps/control-plane-worker/src/settings/db", () => ({
  getUserSettingsIfExists: (...a: unknown[]) => mockGetUserSettingsIfExists(...a),
  getUserPrReviewBotSettings: (...a: unknown[]) => mockGetUserPrReviewBotSettings(...a),
}));
vi.mock("../../apps/control-plane-worker/src/github/installations-db", () => ({
  getInstallationByOwner: (...a: unknown[]) => mockGetInstallationByOwner(...a),
  updateInstallationPermissions: (...a: unknown[]) => mockUpdateInstallationPermissions(...a),
}));
vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  getAppInstallationCapabilities: (...a: unknown[]) => mockGetAppInstallationCapabilities(...a),
}));

import {
  isCodeReviewArmOnlyChecklistFailure,
  resolveReviewLoopCiEligibility,
} from "../../apps/control-plane-worker/src/services/review-loop-settings";

const CAPABLE_INSTALL = {
  installation_id: 42,
  suspended_at: null,
  permissions_json: JSON.stringify({
    checks: "read",
    contents: "write",
    metadata: "read",
    pull_requests: "write",
    statuses: "read",
  }),
  events_json: JSON.stringify([
    "check_run",
    "issue_comment",
    "pull_request",
    "pull_request_review",
    "pull_request_review_comment",
    "status",
  ]),
};

const env = { DB: {} } as never;
const input = { ownerUserId: 1, repoOwner: "acme", repoName: "web" };

describe("resolveReviewLoopCiEligibility", () => {
  beforeEach(() => {
    mockGetUserSettingsIfExists.mockReset().mockResolvedValue({ pr_review_auto_response_enabled: 1 });
    mockGetInstallationByOwner.mockReset().mockResolvedValue(CAPABLE_INSTALL);
    mockUpdateInstallationPermissions.mockReset().mockResolvedValue(undefined);
    mockGetAppInstallationCapabilities.mockReset();
    mockGetUserPrReviewBotSettings.mockReset().mockResolvedValue({ expectedBots: [], ciResponseEnabled: true });
  });

  it("is eligible with zero bots when CI is enabled", async () => {
    const result = await resolveReviewLoopCiEligibility(env, input);
    expect(result).toMatchObject({ ok: true, installationId: 42 });
  });

  it("is eligible regardless of the (removed) master auto-response toggle", async () => {
    // ARC-1288: the auto-response opt-out was removed; a once-"off" toggle no longer blocks arming.
    mockGetUserSettingsIfExists.mockResolvedValue({ pr_review_auto_response_enabled: 0 });
    const result = await resolveReviewLoopCiEligibility(env, input);
    expect(result).toMatchObject({ ok: true, installationId: 42 });
  });

  it("is eligible when the user has no settings row (default-on)", async () => {
    mockGetUserSettingsIfExists.mockResolvedValue(null);
    const result = await resolveReviewLoopCiEligibility(env, input);
    expect(result).toMatchObject({ ok: true, installationId: 42 });
  });

  it("is eligible regardless of the (removed) per-repo CI-response opt-out", async () => {
    // ARC-1288: the CI-response opt-out was removed; a once-"off" ciResponseEnabled no longer blocks arming.
    mockGetUserPrReviewBotSettings.mockResolvedValue({
      expectedBots: [],
      ciResponseEnabled: false,
    });
    const result = await resolveReviewLoopCiEligibility(env, input);
    expect(result).toMatchObject({ ok: true, installationId: 42 });
  });

  it("fails closed when installation capabilities are missing", async () => {
    mockGetInstallationByOwner.mockResolvedValue(null);
    const result = await resolveReviewLoopCiEligibility(env, input);
    expect(result).toMatchObject({ ok: false, reason: "installation_capabilities_missing" });
  });
});

describe("isCodeReviewArmOnlyChecklistFailure", () => {
  // Bot-set reasons disable ONLY the code-review arm — the always-on CI-fix + verification arm still
  // runs (the sweep falls through on these). The master toggle / capabilities reasons disable the
  // whole loop and must fail closed.
  it("classifies the bot-set reasons as code-review-arm-only", () => {
    // Walltime removal: `empty_expected_bots` is gone (a zero-bot repo now resolves ok:true).
    expect(isCodeReviewArmOnlyChecklistFailure("expected_bots_changed")).toBe(true);
  });

  it("classifies the capability reason as whole-loop (fail-closed)", () => {
    expect(isCodeReviewArmOnlyChecklistFailure("installation_capabilities_missing")).toBe(false);
  });
});
