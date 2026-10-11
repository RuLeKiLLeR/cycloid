import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListSessionIdsByWebhookRef = vi.fn();
const mockGetSessionLivenessRows = vi.fn();
const mockGetSessionState = vi.fn();
const mockGetInstallationByOwner = vi.fn();
const mockCreateInstallationToken = vi.fn();
const mockGetPrMergeStatus = vi.fn();
const mockGetVerificationRunCountForPrCoordination = vi.fn();
const mockCountStandaloneVerificationSessionsByGithubPrRef = vi.fn();
const mockPostStructuredEventToDd = vi.fn();

vi.mock("../../../apps/control-plane-worker/src/webhooks/db", () => ({
  SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR: "github_pr_url",
  countStandaloneVerificationSessionsByGithubPrRef: (...args: unknown[]) =>
    mockCountStandaloneVerificationSessionsByGithubPrRef(...args),
  listSessionIdsByWebhookRef: (...args: unknown[]) => mockListSessionIdsByWebhookRef(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/session/pr-coordination-db", () => ({
  getVerificationRunCountForPrCoordination: (...args: unknown[]) =>
    mockGetVerificationRunCountForPrCoordination(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/session/db", () => ({
  getSessionLivenessRows: (...args: unknown[]) => mockGetSessionLivenessRows(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/session/state", () => ({
  assertDatabase: (env: { DB?: D1Database }) => {
    if (!env.DB) throw new Error("D1 binding DB is not configured");
    return env.DB;
  },
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/github/installations-db", () => ({
  getInstallationByOwner: (...args: unknown[]) => mockGetInstallationByOwner(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: (...args: unknown[]) => mockCreateInstallationToken(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/github/pr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../apps/control-plane-worker/src/github/pr")>();
  return {
    ...actual,
    getPrMergeStatus: (...args: unknown[]) => mockGetPrMergeStatus(...args),
  };
});

vi.mock("../../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
}));

import type { Logger } from "../../../apps/control-plane-worker/src/logger";
import { underVerificationCap } from "../../../apps/control-plane-worker/src/session/fsm/guards";
import {
  checkVerificationConflict,
  checkVerificationRunLimit,
  findActiveVerificationSession,
  verificationRunLimitMessage,
} from "../../../apps/control-plane-worker/src/session/verification-gate";
import type { Env } from "../../../apps/control-plane-worker/src/types";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as unknown as Logger;

const env = { DB: {} as D1Database, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "test-key" } as Env;
const PR_URL = "https://github.com/acme/repo/pull/42";

interface CapAuthorityFixture {
  cohort: string;
  legacyLifetimeRuns: number;
  fsmVerificationRunCount: number;
  fsmAllows: boolean;
}

const CAP_AUTHORITY_FIXTURES: CapAuthorityFixture[] = [
  {
    cohort: "fresh PR: no verifier sessions yet",
    legacyLifetimeRuns: 0,
    fsmVerificationRunCount: 0,
    fsmAllows: true,
  },
  {
    cohort: "backfilled settled verdict: legacy lifetime exhausted, FSM count reset",
    legacyLifetimeRuns: 3,
    fsmVerificationRunCount: 0,
    fsmAllows: true,
  },
  {
    cohort: "retried still-failing PR below cap",
    legacyLifetimeRuns: 2,
    fsmVerificationRunCount: 2,
    fsmAllows: true,
  },
  {
    cohort: "retried still-failing PR at cap",
    legacyLifetimeRuns: 3,
    fsmVerificationRunCount: 3,
    fsmAllows: false,
  },
  {
    cohort: "pass-reset retried PR: fail, fail, pass, fail",
    legacyLifetimeRuns: 3,
    fsmVerificationRunCount: 1,
    fsmAllows: true,
  },
];

describe("findActiveVerificationSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPostStructuredEventToDd.mockResolvedValue(true);
  });

  it("returns null when no sessions reference the PR", async () => {
    mockListSessionIdsByWebhookRef.mockResolvedValue([]);

    await expect(findActiveVerificationSession(env, logger, PR_URL)).resolves.toBeNull();
    expect(mockGetSessionLivenessRows).not.toHaveBeenCalled();
    expect(mockGetSessionState).not.toHaveBeenCalled();
  });

  it("returns null when every referenced session is in a terminal phase", async () => {
    mockListSessionIdsByWebhookRef.mockResolvedValue(["s-done", "s-failed"]);
    mockGetSessionLivenessRows.mockResolvedValue([
      { session_id: "s-done", status: "active", rich_status: "completed" },
      { session_id: "s-failed", status: "active", rich_status: "failed" },
    ]);

    await expect(findActiveVerificationSession(env, logger, PR_URL)).resolves.toBeNull();
    expect(mockGetSessionState).not.toHaveBeenCalled();
  });

  it("ignores archived sessions regardless of rich_status", async () => {
    mockListSessionIdsByWebhookRef.mockResolvedValue(["s-archived"]);
    mockGetSessionLivenessRows.mockResolvedValue([
      { session_id: "s-archived", status: "archived", rich_status: "running" },
    ]);

    await expect(findActiveVerificationSession(env, logger, PR_URL)).resolves.toBeNull();
    expect(mockGetSessionState).not.toHaveBeenCalled();
  });

  it("skips live implementation sessions referencing the same PR", async () => {
    mockListSessionIdsByWebhookRef.mockResolvedValue(["s-impl"]);
    mockGetSessionLivenessRows.mockResolvedValue([{ session_id: "s-impl", status: "active", rich_status: "running" }]);
    mockGetSessionState.mockResolvedValue({
      sessionId: "s-impl",
      status: "active",
      agentRole: "implementation",
    });

    await expect(findActiveVerificationSession(env, logger, PR_URL)).resolves.toBeNull();
  });

  it("excludes projected non-verification sessions without a DO fetch", async () => {
    mockListSessionIdsByWebhookRef.mockResolvedValue(["s-impl", "s-verifier"]);
    mockGetSessionLivenessRows.mockResolvedValue([
      { session_id: "s-impl", status: "active", rich_status: "running", agent_role: "implementation" },
      { session_id: "s-verifier", status: "active", rich_status: "running", agent_role: "verification" },
    ]);
    mockGetSessionState.mockImplementation(async (_env: unknown, sessionId: string) => ({
      sessionId,
      status: "active",
      agentRole: "verification",
    }));

    await expect(findActiveVerificationSession(env, logger, PR_URL)).resolves.toEqual({ sessionId: "s-verifier" });
    expect(mockGetSessionState).toHaveBeenCalledTimes(1);
    expect(mockGetSessionState).toHaveBeenCalledWith(env, "s-verifier");
  });

  it("keeps rows with a null projected agent_role as DO-check candidates", async () => {
    mockListSessionIdsByWebhookRef.mockResolvedValue(["s-legacy"]);
    mockGetSessionLivenessRows.mockResolvedValue([
      { session_id: "s-legacy", status: "active", rich_status: "running", agent_role: null },
    ]);
    mockGetSessionState.mockResolvedValue({
      sessionId: "s-legacy",
      status: "active",
      agentRole: "verification",
    });

    await expect(findActiveVerificationSession(env, logger, PR_URL)).resolves.toEqual({ sessionId: "s-legacy" });
  });

  it("skips a failed DO read but still finds a verifier among the rest", async () => {
    mockListSessionIdsByWebhookRef.mockResolvedValue(["s-broken", "s-verifier"]);
    mockGetSessionLivenessRows.mockResolvedValue([
      { session_id: "s-broken", status: "active", rich_status: "running", agent_role: "verification" },
      { session_id: "s-verifier", status: "active", rich_status: "running", agent_role: "verification" },
    ]);
    mockGetSessionState.mockImplementation(async (_env: unknown, sessionId: string) => {
      if (sessionId === "s-broken") throw new Error("DO lookup failed");
      return { sessionId, status: "active", agentRole: "verification" };
    });

    await expect(findActiveVerificationSession(env, logger, PR_URL)).resolves.toEqual({ sessionId: "s-verifier" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s-broken" }),
      expect.stringContaining("Active-verifier DO state fetch failed"),
    );
  });

  it("returns the live verification session", async () => {
    mockListSessionIdsByWebhookRef.mockResolvedValue(["s-impl", "s-verifier"]);
    mockGetSessionLivenessRows.mockResolvedValue([
      { session_id: "s-impl", status: "active", rich_status: "review_listening" },
      { session_id: "s-verifier", status: "active", rich_status: "running" },
    ]);
    mockGetSessionState.mockImplementation(async (_env: unknown, sessionId: string) => ({
      sessionId,
      status: "active",
      agentRole: sessionId === "s-verifier" ? "verification" : "implementation",
    }));

    await expect(findActiveVerificationSession(env, logger, PR_URL)).resolves.toEqual({
      sessionId: "s-verifier",
    });
  });

  it("treats a ref with no session_index row yet as potentially live", async () => {
    mockListSessionIdsByWebhookRef.mockResolvedValue(["s-unprojected"]);
    mockGetSessionLivenessRows.mockResolvedValue([]);
    mockGetSessionState.mockResolvedValue({
      sessionId: "s-unprojected",
      status: "active",
      agentRole: "verification",
    });

    await expect(findActiveVerificationSession(env, logger, PR_URL)).resolves.toEqual({
      sessionId: "s-unprojected",
    });
  });

  it("treats a missing rich_status as live (idle)", async () => {
    mockListSessionIdsByWebhookRef.mockResolvedValue(["s-new"]);
    mockGetSessionLivenessRows.mockResolvedValue([{ session_id: "s-new", status: "active", rich_status: null }]);
    mockGetSessionState.mockResolvedValue({
      sessionId: "s-new",
      status: "active",
      agentRole: "verification",
    });

    await expect(findActiveVerificationSession(env, logger, PR_URL)).resolves.toEqual({ sessionId: "s-new" });
  });

  it("fails open and returns null when the lookup throws", async () => {
    mockListSessionIdsByWebhookRef.mockRejectedValue(new Error("D1 unavailable"));

    await expect(findActiveVerificationSession(env, logger, PR_URL)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ prUrl: PR_URL }),
      expect.stringContaining("Active-verifier lookup failed"),
    );
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        event: "verification_gate.fail_open",
        gate: "active_verifier",
        pr_url: PR_URL,
      }),
    );
  });

  it("fails open when a session state read throws mid-scan", async () => {
    mockListSessionIdsByWebhookRef.mockResolvedValue(["s-verifier"]);
    mockGetSessionLivenessRows.mockResolvedValue([
      { session_id: "s-verifier", status: "active", rich_status: "running" },
    ]);
    mockGetSessionState.mockRejectedValue(new Error("DO lookup failed"));

    await expect(findActiveVerificationSession(env, logger, PR_URL)).resolves.toBeNull();
  });
});

describe("checkVerificationRunLimit", () => {
  // W11-V7/D-51 KEEP note: the D-51 deletion removed the lock-wrapper cases (and the
  // `verification-lock-db` mock) from this file; `checkVerificationRunLimit` is the sole
  // surviving KEEP surface and these cases are its only coverage.
  beforeEach(() => {
    vi.clearAllMocks();
    mockPostStructuredEventToDd.mockResolvedValue(true);
    mockGetVerificationRunCountForPrCoordination.mockResolvedValue(0);
    mockCountStandaloneVerificationSessionsByGithubPrRef.mockResolvedValue(0);
  });

  it("allows verification below the per-PR run limit", async () => {
    mockGetVerificationRunCountForPrCoordination.mockResolvedValue(2);

    await expect(checkVerificationRunLimit(env, logger, PR_URL, { parentSessionId: "parent-1" })).resolves.toEqual({
      allowed: true,
      currentRuns: 2,
      maxRuns: 3,
    });
    expect(mockGetVerificationRunCountForPrCoordination).toHaveBeenCalledWith(env.DB, {
      prUrl: PR_URL,
      parentSessionId: "parent-1",
    });
  });

  it("blocks verification at the per-PR run limit", async () => {
    mockGetVerificationRunCountForPrCoordination.mockResolvedValue(3);

    await expect(checkVerificationRunLimit(env, logger, PR_URL)).resolves.toEqual({
      allowed: false,
      reason: "verification_run_limit_reached",
      currentRuns: 3,
      maxRuns: 3,
    });
    expect(verificationRunLimitMessage(3, 3)).toContain("3 times");
    expect(verificationRunLimitMessage(5, 3)).toContain("5 times");
    expect(verificationRunLimitMessage(5, 3)).toContain("limit 3");
  });

  it("fails open when the run-limit lookup throws", async () => {
    mockGetVerificationRunCountForPrCoordination.mockRejectedValue(new Error("D1 unavailable"));

    await expect(checkVerificationRunLimit(env, logger, PR_URL)).resolves.toEqual({
      allowed: true,
      currentRuns: null,
      maxRuns: 3,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ prUrl: PR_URL }),
      expect.stringContaining("Verification run-limit lookup failed"),
    );
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        event: "verification_gate.fail_open",
        gate: "run_limit",
        pr_url: PR_URL,
      }),
    );
  });

  it("allows reset FSM cohorts even when legacy lifetime verifier sessions would be exhausted", async () => {
    mockGetVerificationRunCountForPrCoordination.mockResolvedValue(0);
    mockCountStandaloneVerificationSessionsByGithubPrRef.mockResolvedValue(3);

    await expect(checkVerificationRunLimit(env, logger, PR_URL)).resolves.toEqual({
      allowed: true,
      currentRuns: 0,
      maxRuns: 3,
    });
    expect(mockCountStandaloneVerificationSessionsByGithubPrRef).not.toHaveBeenCalled();
    expect(mockListSessionIdsByWebhookRef).not.toHaveBeenCalled();
    expect(mockGetSessionState).not.toHaveBeenCalled();
  });

  it("counts standalone direct verifier sessions when direct QA opts into the fallback", async () => {
    mockGetVerificationRunCountForPrCoordination.mockResolvedValue(null);
    mockCountStandaloneVerificationSessionsByGithubPrRef.mockResolvedValue(2);

    await expect(
      checkVerificationRunLimit(env, logger, PR_URL, { includeStandaloneVerifierSessions: true }),
    ).resolves.toEqual({
      allowed: true,
      currentRuns: 2,
      maxRuns: 3,
    });
    expect(mockCountStandaloneVerificationSessionsByGithubPrRef).toHaveBeenCalledWith(env.DB, PR_URL);
  });

  it("emits fail-open telemetry when the standalone run-count fallback throws", async () => {
    mockGetVerificationRunCountForPrCoordination.mockResolvedValue(1);
    mockCountStandaloneVerificationSessionsByGithubPrRef.mockRejectedValue(new Error("standalone count unavailable"));

    await expect(
      checkVerificationRunLimit(env, logger, PR_URL, { includeStandaloneVerifierSessions: true }),
    ).resolves.toEqual({
      allowed: true,
      currentRuns: 1,
      maxRuns: 3,
    });
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        event: "verification_gate.fail_open",
        gate: "standalone_run_limit",
        pr_url: PR_URL,
      }),
    );
  });

  it("adds standalone direct verifier sessions to the FSM run count for direct QA", async () => {
    mockGetVerificationRunCountForPrCoordination.mockResolvedValue(2);
    mockCountStandaloneVerificationSessionsByGithubPrRef.mockResolvedValue(1);

    await expect(
      checkVerificationRunLimit(env, logger, PR_URL, {
        parentSessionId: "parent-1",
        includeStandaloneVerifierSessions: true,
      }),
    ).resolves.toEqual({
      allowed: false,
      reason: "verification_run_limit_reached",
      currentRuns: 3,
      maxRuns: 3,
    });
  });

  it.each(CAP_AUTHORITY_FIXTURES)(
    "uses pr_coordination verification_run_count for $cohort",
    async ({ legacyLifetimeRuns, fsmVerificationRunCount, fsmAllows }) => {
      mockGetVerificationRunCountForPrCoordination.mockResolvedValue(fsmVerificationRunCount);

      const runLimit = await checkVerificationRunLimit(env, logger, PR_URL, { parentSessionId: "parent-1" });
      const fsmLimitAllows = underVerificationCap(fsmVerificationRunCount);

      expect(runLimit.allowed).toBe(fsmAllows);
      expect(runLimit.currentRuns).toBe(fsmVerificationRunCount);
      expect(fsmLimitAllows).toBe(fsmAllows);

      // The former lifetime verifier-session count is intentionally not the decision input.
      if (legacyLifetimeRuns >= 3 && fsmVerificationRunCount < 3) {
        expect(runLimit.allowed).toBe(true);
      }
    },
  );
});

describe("checkVerificationConflict", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPostStructuredEventToDd.mockResolvedValue(true);
    mockGetInstallationByOwner.mockResolvedValue({ installation_id: 123, suspended_at: null });
    mockCreateInstallationToken.mockResolvedValue("ghs_test");
  });

  it("skips verification only for a confirmed dirty mergeable state", async () => {
    mockGetPrMergeStatus.mockResolvedValue({
      mergeable: false,
      mergeableState: "dirty",
    });

    await expect(
      checkVerificationConflict(env, logger, {
        prUrl: PR_URL,
        installationId: 123,
        repoOwner: "acme",
        repoName: "repo",
      }),
    ).resolves.toEqual({
      skip: true,
      reason: "merge_conflict",
    });
    expect(mockCreateInstallationToken).toHaveBeenCalledWith(env, 123);
    expect(mockGetPrMergeStatus).toHaveBeenCalledWith("ghs_test", "acme", "repo", 42);
  });

  it("does not skip for a known non-dirty mergeable state", async () => {
    mockGetPrMergeStatus.mockResolvedValue({
      mergeable: true,
      mergeableState: "clean",
    });

    await expect(
      checkVerificationConflict(env, logger, {
        prUrl: PR_URL,
        installationId: 123,
        repoOwner: "acme",
        repoName: "repo",
      }),
    ).resolves.toEqual({ skip: false });
  });

  it("does not skip when GitHub is still computing mergeability", async () => {
    mockGetPrMergeStatus.mockResolvedValue({
      mergeable: null,
      mergeableState: "unknown",
    });

    await expect(checkVerificationConflict(env, logger, { prUrl: PR_URL, installationId: 123 })).resolves.toEqual({
      skip: false,
    });
  });

  it("fails open when the merge-conflict lookup throws", async () => {
    mockGetPrMergeStatus.mockRejectedValue(new Error("GitHub unavailable"));

    await expect(checkVerificationConflict(env, logger, { prUrl: PR_URL, installationId: 123 })).resolves.toEqual({
      skip: false,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ prUrl: PR_URL }),
      expect.stringContaining("Verification merge-conflict lookup failed"),
    );
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        event: "verification_gate.fail_open",
        gate: "merge_conflict",
        pr_url: PR_URL,
      }),
    );
  });

  it("does not wait for fail-open telemetry before allowing verification", async () => {
    mockGetPrMergeStatus.mockRejectedValue(new Error("GitHub unavailable"));
    mockPostStructuredEventToDd.mockReturnValue(new Promise(() => {}));

    await expect(checkVerificationConflict(env, logger, { prUrl: PR_URL, installationId: 123 })).resolves.toEqual({
      skip: false,
    });
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        event: "verification_gate.fail_open",
        gate: "merge_conflict",
        pr_url: PR_URL,
      }),
    );
  });

  it("re-derives the installation from the PR URL and detects a dirty PR when repo hints mismatch", async () => {
    mockGetPrMergeStatus.mockResolvedValue({
      mergeable: false,
      mergeableState: "dirty",
    });

    await expect(
      checkVerificationConflict(env, logger, {
        prUrl: PR_URL,
        installationId: 999,
        repoOwner: "other",
        repoName: "fork",
      }),
    ).resolves.toEqual({
      skip: true,
      reason: "merge_conflict",
    });
    // The stale installationId hint (999) is dropped because the hints disagree with the PR URL;
    // the installation is re-derived from the PR URL owner ("acme") and the merge check runs
    // against the PR URL repo rather than being skipped.
    expect(mockGetInstallationByOwner).toHaveBeenCalledWith(env.DB, "acme");
    expect(mockCreateInstallationToken).toHaveBeenCalledWith(env, 123);
    expect(mockCreateInstallationToken).not.toHaveBeenCalledWith(env, 999);
    expect(mockGetPrMergeStatus).toHaveBeenCalledWith("ghs_test", "acme", "repo", 42);
  });

  it("runs the merge check rather than short-circuiting when repo hints mismatch a clean PR", async () => {
    mockGetPrMergeStatus.mockResolvedValue({
      mergeable: true,
      mergeableState: "clean",
    });

    await expect(
      checkVerificationConflict(env, logger, {
        prUrl: PR_URL,
        installationId: 999,
        repoOwner: "other",
        repoName: "fork",
      }),
    ).resolves.toEqual({ skip: false });
    // Regression guard for the removed early-return: on a hint mismatch the gate must actually
    // query GitHub (via the PR URL owner) instead of short-circuiting to { skip: false }.
    expect(mockGetInstallationByOwner).toHaveBeenCalledWith(env.DB, "acme");
    expect(mockGetPrMergeStatus).toHaveBeenCalledWith("ghs_test", "acme", "repo", 42);
  });
});
