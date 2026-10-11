import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("@sentry/cloudflare", () => ({
  instrumentDurableObjectWithSentry: (_optionsCallback: unknown, DurableObjectClass: unknown) => DurableObjectClass,
  withSentry: (_optionsCallback: unknown, handler: unknown) => handler,
  setTag: () => {},
  setUser: () => {},
  captureException: () => {},
}));

const mockGetUserSettingsIfExists = vi.fn();
// The create-if-missing WRITER variant. The manual-review resolver must never call it (a gate check that
// wrote a settings row would be a write-on-read). Spied so the read-only assertion can prove it.
const mockGetUserSettings = vi.fn();
const mockGetUserPrReviewBotSettings = vi.fn();
const mockGetInstallationByOwner = vi.fn();
const mockUpdateInstallationPermissions = vi.fn();
const mockGetAppInstallationCapabilities = vi.fn();

vi.mock("../../apps/control-plane-worker/src/settings/db", () => ({
  getUserSettingsIfExists: (...args: unknown[]) => mockGetUserSettingsIfExists(...args),
  getUserSettings: (...args: unknown[]) => mockGetUserSettings(...args),
  getUserPrReviewBotSettings: (...args: unknown[]) => mockGetUserPrReviewBotSettings(...args),
}));

vi.mock("../../apps/control-plane-worker/src/github/installations-db", () => ({
  getInstallationByOwner: (...args: unknown[]) => mockGetInstallationByOwner(...args),
  updateInstallationPermissions: (...args: unknown[]) => mockUpdateInstallationPermissions(...args),
}));

vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  getAppInstallationCapabilities: (...args: unknown[]) => mockGetAppInstallationCapabilities(...args),
}));

type ReviewLoopSettingsModule = typeof import("../../apps/control-plane-worker/src/services/review-loop-settings");

let mod: ReviewLoopSettingsModule;

// The production Cycloid GitHub App's actual event subscription (no `push` — the app does not
// subscribe to it and the webhook router no-ops it). Required-event additions must stay a subset
// of this list: event subscriptions are app-level, so an installation re-approval can never fix
// an event gap and a requirement outside this list fails every install.
const PROD_APP_SUBSCRIBED_EVENTS = [
  "check_run",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request_review_thread",
  "status",
];

const FULL_INSTALLATION = {
  installation_id: 7,
  owner_login: "acme",
  owner_id: 7,
  owner_type: "Organization",
  repository_selection: "all",
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
  created_at: 100,
  suspended_at: null,
};

class FakeD1 {
  prepare(_query: string) {
    return {
      bind: (..._args: unknown[]) => this,
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({ success: true }),
    };
  }
}

beforeEach(async () => {
  vi.resetModules();
  mockGetUserSettingsIfExists.mockReset();
  mockGetUserSettings.mockReset();
  // Manual review mode (ARC-1514): the review-arm gates now read `automatic_reviews_enabled` via
  // `resolveAutomaticReviewsEnabled`. Default the shared harness to automatic-ON so the existing
  // capability/checklist cases exercise the gate they were written for; manual-mode cases override.
  mockGetUserSettingsIfExists.mockResolvedValue({ automatic_reviews_enabled: 1 });
  mockGetUserPrReviewBotSettings.mockReset();
  mockGetInstallationByOwner.mockReset();
  mockUpdateInstallationPermissions.mockReset();
  mockGetAppInstallationCapabilities.mockReset();

  mod = (await import("../../apps/control-plane-worker/src/services/review-loop-settings")) as ReviewLoopSettingsModule;
});

describe("resolveReviewLoopHumanEligibility", () => {
  const db = new FakeD1() as unknown as D1Database;
  const env = {
    DB: db,
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "private-key",
    DD_API_KEY: undefined,
    WORKER_ENV: "test",
  };
  const input = { ownerUserId: 42, repoOwner: "acme", repoName: "repo" };

  it("is eligible regardless of the (removed) master auto-response toggle", async () => {
    // ARC-1288: the auto-response opt-out was removed, so a once-"off" setting no longer
    // blocks human-review eligibility; only installation capabilities gate it.
    mockGetUserSettingsIfExists.mockResolvedValue({ automatic_reviews_enabled: 1, pr_review_auto_response_enabled: 0 });
    mockGetInstallationByOwner.mockResolvedValue(FULL_INSTALLATION);

    const result = await mod.resolveReviewLoopHumanEligibility(env, input);

    expect(result).toEqual({ ok: true, ownerUserId: 42, installationId: 7 });
  });

  it("returns installation_capabilities_missing when no installation exists", async () => {
    mockGetUserSettingsIfExists.mockResolvedValue({ automatic_reviews_enabled: 1, pr_review_auto_response_enabled: 1 });
    mockGetInstallationByOwner.mockResolvedValue(null);

    const result = await mod.resolveReviewLoopHumanEligibility(env, input);

    expect(result).toEqual({ ok: false, reason: "installation_capabilities_missing" });
  });

  it("uses preloaded installation data without querying the installation DAO", async () => {
    const result = await mod.resolveReviewLoopHumanEligibility(env, {
      ...input,
      ownerSettingsByUserId: new Map([[42, { user_id: 42, pr_review_auto_response_enabled: 1 }]]) as never,
      installationByOwnerLogin: new Map([["acme", FULL_INSTALLATION]]) as never,
    });

    expect(result).toEqual({ ok: true, ownerUserId: 42, installationId: 7 });
    // The manual-review-mode gate (ARC-1514) reads user settings via getUserSettingsIfExists — there is
    // no preloaded-map bypass for it — so it IS consulted even on the preloaded-installation path.
    expect(mockGetUserSettingsIfExists).toHaveBeenCalledWith(db, 42);
    expect(mockGetInstallationByOwner).not.toHaveBeenCalled();
    expect(mockGetUserPrReviewBotSettings).not.toHaveBeenCalled();
  });

  it("returns installation_capabilities_missing when installation lacks required permissions/events", async () => {
    mockGetUserSettingsIfExists.mockResolvedValue({ automatic_reviews_enabled: 1, pr_review_auto_response_enabled: 1 });
    mockGetInstallationByOwner.mockResolvedValue({
      ...FULL_INSTALLATION,
      permissions_json: JSON.stringify({ contents: "write", metadata: "read", pull_requests: "read" }),
      events_json: JSON.stringify(["pull_request_review"]),
    });
    // GitHub confirms the cached gap, so the failure flows through the refresh path, not an error.
    mockGetAppInstallationCapabilities.mockResolvedValue({
      installationId: 7,
      ownerLogin: "acme",
      ownerId: 7,
      ownerType: "Organization",
      repositorySelection: "all",
      permissions: { contents: "write", metadata: "read", pull_requests: "read" },
      events: ["pull_request_review"],
    });

    const result = await mod.resolveReviewLoopHumanEligibility(env, input);

    expect(result).toMatchObject({
      ok: false,
      reason: "installation_capabilities_missing",
      reapproveUrl: "https://github.com/organizations/acme/settings/installations/7",
    });
    expect(mockGetAppInstallationCapabilities).toHaveBeenCalledTimes(1);
  });

  it("refreshes unknown cached capabilities from GitHub and backfills the installation cache", async () => {
    mockGetUserSettingsIfExists.mockResolvedValue({ automatic_reviews_enabled: 1, pr_review_auto_response_enabled: 1 });
    mockGetInstallationByOwner.mockResolvedValue({
      ...FULL_INSTALLATION,
      permissions_json: null,
      events_json: null,
    });
    mockGetAppInstallationCapabilities.mockResolvedValue({
      installationId: 7,
      ownerLogin: "acme",
      ownerId: 7,
      ownerType: "Organization",
      repositorySelection: "all",
      permissions: {
        checks: "read",
        contents: "write",
        metadata: "read",
        pull_requests: "write",
        statuses: "read",
      },
      events: [
        "check_run",
        "issue_comment",
        "pull_request",
        "pull_request_review",
        "pull_request_review_comment",
        "push",
        "status",
      ],
    });

    const result = await mod.resolveReviewLoopHumanEligibility(env, input);

    expect(result).toEqual({ ok: true, ownerUserId: 42, installationId: 7 });
    expect(mockGetAppInstallationCapabilities).toHaveBeenCalledWith(
      { GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "private-key" },
      7,
    );
    expect(mockUpdateInstallationPermissions).toHaveBeenCalledWith(db, {
      installationId: 7,
      ownerLogin: "acme",
      ownerId: 7,
      ownerType: "Organization",
      repositorySelection: "all",
      permissions: {
        checks: "read",
        contents: "write",
        metadata: "read",
        pull_requests: "write",
        statuses: "read",
      },
      events: [
        "check_run",
        "issue_comment",
        "pull_request",
        "pull_request_review",
        "pull_request_review_comment",
        "push",
        "status",
      ],
    });
  });

  it("preserves a cached User installation owner type when a capability refresh lacks account details", async () => {
    mockGetUserSettingsIfExists.mockResolvedValue({ automatic_reviews_enabled: 1, pr_review_auto_response_enabled: 1 });
    mockGetInstallationByOwner.mockResolvedValue({
      ...FULL_INSTALLATION,
      owner_login: "octocat",
      owner_id: 42,
      owner_type: "User",
      permissions_json: null,
      events_json: null,
    });
    mockGetAppInstallationCapabilities.mockResolvedValue({
      installationId: 7,
      ownerLogin: "",
      ownerId: 0,
      ownerType: "User",
      repositorySelection: "all",
      permissions: {
        checks: "read",
        contents: "write",
        metadata: "read",
        pull_requests: "write",
        statuses: "read",
      },
      events: PROD_APP_SUBSCRIBED_EVENTS,
    });

    const result = await mod.resolveReviewLoopHumanEligibility(env, input);

    expect(result).toEqual({ ok: true, ownerUserId: 42, installationId: 7 });
    expect(mockUpdateInstallationPermissions).toHaveBeenCalledWith(db, {
      installationId: 7,
      ownerLogin: "octocat",
      ownerId: 42,
      ownerType: "User",
      repositorySelection: "all",
      permissions: {
        checks: "read",
        contents: "write",
        metadata: "read",
        pull_requests: "write",
        statuses: "read",
      },
      events: PROD_APP_SUBSCRIBED_EVENTS,
    });
  });

  it("refreshes stale cached gaps from GitHub and passes when the live subscription is fine", async () => {
    mockGetUserSettingsIfExists.mockResolvedValue({ automatic_reviews_enabled: 1, pr_review_auto_response_enabled: 1 });
    // Cached row predates the app subscribing to `status`; GitHub sends no webhook for
    // event-subscription changes, so only a gap-triggered refresh can heal it.
    mockGetInstallationByOwner.mockResolvedValue({
      ...FULL_INSTALLATION,
      events_json: JSON.stringify(PROD_APP_SUBSCRIBED_EVENTS.filter((event) => event !== "status")),
    });
    mockGetAppInstallationCapabilities.mockResolvedValue({
      installationId: 7,
      ownerLogin: "acme",
      ownerId: 7,
      ownerType: "Organization",
      repositorySelection: "all",
      permissions: JSON.parse(FULL_INSTALLATION.permissions_json),
      events: PROD_APP_SUBSCRIBED_EVENTS,
    });

    const result = await mod.resolveReviewLoopHumanEligibility(env, input);

    expect(result).toEqual({ ok: true, ownerUserId: 42, installationId: 7 });
    expect(mockUpdateInstallationPermissions).toHaveBeenCalled();
  });

  it("updates a preloaded installation map after a successful capability refresh", async () => {
    const staleInstallation = {
      ...FULL_INSTALLATION,
      events_json: JSON.stringify(PROD_APP_SUBSCRIBED_EVENTS.filter((event) => event !== "status")),
    };
    const installationByOwnerLogin = new Map([["acme", staleInstallation]]);
    mockGetUserSettingsIfExists.mockResolvedValue({ automatic_reviews_enabled: 1, pr_review_auto_response_enabled: 1 });
    mockGetAppInstallationCapabilities.mockResolvedValue({
      installationId: 7,
      ownerLogin: "acme",
      ownerId: 7,
      ownerType: "Organization",
      repositorySelection: "all",
      permissions: JSON.parse(FULL_INSTALLATION.permissions_json),
      events: PROD_APP_SUBSCRIBED_EVENTS,
    });

    const result = await mod.resolveReviewLoopHumanEligibility(env, {
      ...input,
      installationByOwnerLogin,
    });

    expect(result).toEqual({ ok: true, ownerUserId: 42, installationId: 7 });
    expect(JSON.parse(installationByOwnerLogin.get("acme")!.events_json)).toEqual(PROD_APP_SUBSCRIBED_EVENTS);
  });

  it("does not throttle a healed refresh, so callers holding a stale row can refresh again", async () => {
    mockGetUserSettingsIfExists.mockResolvedValue({ automatic_reviews_enabled: 1, pr_review_auto_response_enabled: 1 });
    // Simulates webhook-ingest loops that preload one installation row for many sessions: the
    // row stays stale across calls even after the first refresh persisted the healed state.
    mockGetInstallationByOwner.mockResolvedValue({
      ...FULL_INSTALLATION,
      events_json: JSON.stringify(PROD_APP_SUBSCRIBED_EVENTS.filter((event) => event !== "status")),
    });
    mockGetAppInstallationCapabilities.mockResolvedValue({
      installationId: 7,
      ownerLogin: "acme",
      ownerId: 7,
      ownerType: "Organization",
      repositorySelection: "all",
      permissions: JSON.parse(FULL_INSTALLATION.permissions_json),
      events: PROD_APP_SUBSCRIBED_EVENTS,
    });

    const first = await mod.resolveReviewLoopHumanEligibility(env, input);
    const second = await mod.resolveReviewLoopHumanEligibility(env, input);

    expect(first).toEqual({ ok: true, ownerUserId: 42, installationId: 7 });
    expect(second).toEqual({ ok: true, ownerUserId: 42, installationId: 7 });
    expect(mockGetAppInstallationCapabilities).toHaveBeenCalledTimes(2);
  });

  it("throttles gap-triggered refreshes per installation and still fails closed", async () => {
    mockGetUserSettingsIfExists.mockResolvedValue({ automatic_reviews_enabled: 1, pr_review_auto_response_enabled: 1 });
    mockGetInstallationByOwner.mockResolvedValue({
      ...FULL_INSTALLATION,
      events_json: JSON.stringify(["pull_request_review"]),
    });
    // The live subscription is also missing required events, so the refresh cannot heal it.
    mockGetAppInstallationCapabilities.mockResolvedValue({
      installationId: 7,
      ownerLogin: "acme",
      ownerId: 7,
      ownerType: "Organization",
      repositorySelection: "all",
      permissions: JSON.parse(FULL_INSTALLATION.permissions_json),
      events: ["pull_request_review"],
    });

    const first = await mod.resolveReviewLoopHumanEligibility(env, input);
    const second = await mod.resolveReviewLoopHumanEligibility(env, input);

    expect(first).toMatchObject({ ok: false, reason: "installation_capabilities_missing" });
    expect(second).toMatchObject({ ok: false, reason: "installation_capabilities_missing" });
    expect(mockGetAppInstallationCapabilities).toHaveBeenCalledTimes(1);
  });

  it("throttles an unknown cache whose refresh keeps failing instead of refetching every check", async () => {
    mockGetUserSettingsIfExists.mockResolvedValue({ automatic_reviews_enabled: 1, pr_review_auto_response_enabled: 1 });
    // Unknown cache (NULL columns): a fresh/un-backfilled row with no capability data.
    mockGetInstallationByOwner.mockResolvedValue({
      ...FULL_INSTALLATION,
      permissions_json: null,
      events_json: null,
    });
    // GitHub keeps failing, so the refresh can never heal the unknown row.
    mockGetAppInstallationCapabilities.mockRejectedValue(new Error("github 503"));

    const first = await mod.resolveReviewLoopHumanEligibility(env, input);
    const second = await mod.resolveReviewLoopHumanEligibility(env, input);

    expect(first).toMatchObject({ ok: false, reason: "installation_capabilities_missing" });
    expect(second).toMatchObject({ ok: false, reason: "installation_capabilities_missing" });
    // The failed attempt arms the throttle, so the second check does not refetch from GitHub.
    expect(mockGetAppInstallationCapabilities).toHaveBeenCalledTimes(1);
  });

  it("passes for an installation with the production app's actual event subscription", async () => {
    mockGetUserSettingsIfExists.mockResolvedValue({ automatic_reviews_enabled: 1, pr_review_auto_response_enabled: 1 });
    mockGetInstallationByOwner.mockResolvedValue({
      ...FULL_INSTALLATION,
      events_json: JSON.stringify(PROD_APP_SUBSCRIBED_EVENTS),
    });

    const result = await mod.resolveReviewLoopHumanEligibility(env, input);

    expect(result).toEqual({ ok: true, ownerUserId: 42, installationId: 7 });
  });

  it("returns ok with ownerUserId and installationId when setting is on and capabilities are full (no expected_bots needed)", async () => {
    mockGetUserSettingsIfExists.mockResolvedValue({ automatic_reviews_enabled: 1, pr_review_auto_response_enabled: 1 });
    mockGetInstallationByOwner.mockResolvedValue(FULL_INSTALLATION);

    const result = await mod.resolveReviewLoopHumanEligibility(env, input);

    expect(result).toEqual({ ok: true, ownerUserId: 42, installationId: 7 });
  });
});

describe("resolveReviewLoopChecklist", () => {
  const db = new FakeD1() as unknown as D1Database;
  const input = { ownerUserId: 42, repoOwner: "acme", repoName: "repo" };
  const botSettings = {
    expectedBots: [{ type: "known", id: "cursor-bugbot" }],
    expectedBotsHash: "bots-hash",
    ciResponseEnabled: true,
  };

  it("returns the same checklist result from preloaded maps without single-row reads", async () => {
    mockGetUserSettingsIfExists.mockResolvedValue({
      user_id: 42,
      automatic_reviews_enabled: 1,
      pr_review_auto_response_enabled: 1,
    });
    mockGetInstallationByOwner.mockResolvedValue(FULL_INSTALLATION);
    mockGetUserPrReviewBotSettings.mockResolvedValue(botSettings);

    const direct = await mod.resolveReviewLoopChecklist({ DB: db }, input);

    mockGetUserSettingsIfExists.mockClear();
    mockGetInstallationByOwner.mockClear();
    mockGetUserPrReviewBotSettings.mockClear();

    const preloaded = await mod.resolveReviewLoopChecklist(
      { DB: db },
      {
        ...input,
        ownerSettingsByUserId: new Map([[42, { user_id: 42, pr_review_auto_response_enabled: 1 }]]) as never,
        installationByOwnerLogin: new Map([["acme", FULL_INSTALLATION]]) as never,
        botSettingsByOwnerRepo: new Map([["42:acme/repo", botSettings]]) as never,
      },
    );

    expect(preloaded).toEqual(direct);
    // The manual-review-mode gate (ARC-1514) reads user settings with no preloaded-map bypass, so the
    // checklist still consults getUserSettingsIfExists on the preloaded path (the installation/bot-settings
    // single-row reads remain skipped).
    expect(mockGetUserSettingsIfExists).toHaveBeenCalledWith(db, 42);
    expect(mockGetInstallationByOwner).not.toHaveBeenCalled();
    expect(mockGetUserPrReviewBotSettings).not.toHaveBeenCalled();
  });

  it("resolves ok:true with an empty expected-bot set for a zero-bot repo", async () => {
    // Walltime removal: a zero-bot repo is no longer an `empty_expected_bots` failure. The code-review
    // arm arms with an empty expected-bot set (nothing to wait for; epochs are immediately due), so a
    // capable installation resolves ok:true with expectedBots: [] and no fallbackAfterMs.
    mockGetUserSettingsIfExists.mockResolvedValue({
      user_id: 42,
      automatic_reviews_enabled: 1,
      pr_review_auto_response_enabled: 1,
    });
    mockGetInstallationByOwner.mockResolvedValue(FULL_INSTALLATION);
    mockGetUserPrReviewBotSettings.mockResolvedValue({
      expectedBots: [],
      expectedBotsHash: "empty",
      ciResponseEnabled: false,
    });

    const res = await mod.resolveReviewLoopChecklist({ DB: db }, input);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.expectedBots).toEqual([]);
      expect("fallbackAfterMs" in res).toBe(false);
    }
  });
});

describe("resolveReviewLoopCiEligibility", () => {
  const db = new FakeD1() as unknown as D1Database;
  const input = { ownerUserId: 42, repoOwner: "acme", repoName: "repo" };

  it("is eligible regardless of the (removed) per-repo CI-response opt-out", async () => {
    // ARC-1288: the CI-response opt-out was removed; a once-"off" ciResponseEnabled no longer
    // blocks CI eligibility — only installation capabilities gate it.
    mockGetUserPrReviewBotSettings.mockResolvedValue({
      expectedBots: [],
      expectedBotsHash: "empty",
      ciResponseEnabled: false,
    });
    mockGetInstallationByOwner.mockResolvedValue(FULL_INSTALLATION);

    const result = await mod.resolveReviewLoopCiEligibility({ DB: db }, input);

    expect(result).toEqual({ ok: true, ownerUserId: 42, installationId: 7 });
  });

  it("stays eligible when automatic review handling is OFF (manual mode) — CI-fix arm is not gated", async () => {
    // ARC-1514: manual mode suppresses the review arms but the CI-fix arm keeps running, so CI-green
    // still reaches MERGE_READY. resolveReviewLoopCiEligibility must NOT read automatic_reviews_enabled.
    mockGetUserSettingsIfExists.mockResolvedValue({ automatic_reviews_enabled: 0 });
    mockGetUserPrReviewBotSettings.mockResolvedValue({
      expectedBots: [],
      expectedBotsHash: "empty",
      ciResponseEnabled: false,
    });
    mockGetInstallationByOwner.mockResolvedValue(FULL_INSTALLATION);

    const result = await mod.resolveReviewLoopCiEligibility({ DB: db }, input);

    expect(result).toEqual({ ok: true, ownerUserId: 42, installationId: 7 });
    // The CI gate never consults the manual-review setting.
    expect(mockGetUserSettingsIfExists).not.toHaveBeenCalled();
  });
});

describe("resolveAutomaticReviewsEnabled (ARC-1514 manual review mode)", () => {
  const db = new FakeD1() as unknown as D1Database;

  it("is false by default when no settings row exists (manual is the default)", async () => {
    mockGetUserSettingsIfExists.mockResolvedValue(null);

    const result = await mod.resolveAutomaticReviewsEnabled({ db, ownerUserId: 42 });

    expect(result).toBe(false);
    expect(mockGetUserSettingsIfExists).toHaveBeenCalledWith(db, 42);
  });

  it("is true only when automatic_reviews_enabled === 1", async () => {
    mockGetUserSettingsIfExists.mockResolvedValue({ automatic_reviews_enabled: 1 });
    expect(await mod.resolveAutomaticReviewsEnabled({ db, ownerUserId: 42 })).toBe(true);

    mockGetUserSettingsIfExists.mockResolvedValue({ automatic_reviews_enabled: 0 });
    expect(await mod.resolveAutomaticReviewsEnabled({ db, ownerUserId: 42 })).toBe(false);
  });

  it("does NOT write a settings row when none exists (read-only via getUserSettingsIfExists)", async () => {
    mockGetUserSettingsIfExists.mockResolvedValue(null);

    await mod.resolveAutomaticReviewsEnabled({ db, ownerUserId: 42 });

    // The create-if-missing writer must never fire on a gate check (write-on-read guard).
    expect(mockGetUserSettings).not.toHaveBeenCalled();
  });
});

describe("manual review mode suppresses the review arms (ARC-1514)", () => {
  const db = new FakeD1() as unknown as D1Database;
  const env = {
    DB: db,
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "private-key",
    DD_API_KEY: undefined,
    WORKER_ENV: "test",
  };
  const input = { ownerUserId: 42, repoOwner: "acme", repoName: "repo" };

  it("resolveReviewLoopChecklist returns review_handling_disabled BEFORE any capability/bot work", async () => {
    mockGetUserSettingsIfExists.mockResolvedValue({ automatic_reviews_enabled: 0 });

    const result = await mod.resolveReviewLoopChecklist(env, input);

    expect(result).toEqual({ ok: false, reason: "review_handling_disabled" });
    // Short-circuits before the installation/bot-settings reads.
    expect(mockGetInstallationByOwner).not.toHaveBeenCalled();
    expect(mockGetUserPrReviewBotSettings).not.toHaveBeenCalled();
  });

  it("resolveReviewLoopHumanEligibility returns review_handling_disabled and skips the capability check", async () => {
    mockGetUserSettingsIfExists.mockResolvedValue({ automatic_reviews_enabled: 0 });

    const result = await mod.resolveReviewLoopHumanEligibility(env, input);

    expect(result).toEqual({ ok: false, reason: "review_handling_disabled" });
    expect(mockGetInstallationByOwner).not.toHaveBeenCalled();
  });

  it("verification epoch stays eligible in manual mode (QA independent of automatic_reviews_enabled)", async () => {
    // QA verification lives on the separate auto_verify axis, so a verification epoch must dispatch even
    // when manual review mode is on (automatic_reviews_enabled=0). The gate is skipped and the capability
    // check runs like any other eligible epoch.
    mockGetUserSettingsIfExists.mockResolvedValue({ automatic_reviews_enabled: 0 });
    mockGetInstallationByOwner.mockResolvedValue(FULL_INSTALLATION);

    const result = await mod.resolveReviewLoopHumanEligibility(env, { ...input, sourceKind: "verification" });

    expect(result).toEqual({ ok: true, ownerUserId: 42, installationId: 7 });
    // The gate is bypassed for verification, so the capability check IS exercised.
    expect(mockGetInstallationByOwner).toHaveBeenCalled();
  });

  it("human epoch stays gated in manual mode even when sourceKind is passed explicitly", async () => {
    // Genuine reviewer epochs (human/mixed) must remain suppressed under manual review mode.
    mockGetUserSettingsIfExists.mockResolvedValue({ automatic_reviews_enabled: 0 });

    const result = await mod.resolveReviewLoopHumanEligibility(env, { ...input, sourceKind: "human" });

    expect(result).toEqual({ ok: false, reason: "review_handling_disabled" });
    expect(mockGetInstallationByOwner).not.toHaveBeenCalled();
  });

  it("resolveReviewLoopMergeConflictEligibility returns review_handling_disabled and skips bot/capability work", async () => {
    mockGetUserSettingsIfExists.mockResolvedValue({ automatic_reviews_enabled: 0 });

    const result = await mod.resolveReviewLoopMergeConflictEligibility(env, input);

    expect(result).toEqual({ ok: false, reason: "review_handling_disabled" });
    expect(mockGetInstallationByOwner).not.toHaveBeenCalled();
    expect(mockGetUserPrReviewBotSettings).not.toHaveBeenCalled();
  });

  it("isCodeReviewArmOnlyChecklistFailure classifies review_handling_disabled as arm-only (CI keeps running)", () => {
    expect(mod.isCodeReviewArmOnlyChecklistFailure("review_handling_disabled")).toBe(true);
  });
});
