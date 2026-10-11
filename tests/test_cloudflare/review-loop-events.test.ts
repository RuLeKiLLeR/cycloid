import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyReviewLoopIngestIgnoredReason,
  classifyVerificationScheduleFailureReason,
  emitReviewListeningDormantCountEvent,
  emitReviewLoopEpochTerminalEvent,
  emitReviewLoopIngestOutcomeEvent,
  emitReviewLoopSettledEvent,
  emitVerificationRunCompletedEvent,
  emitVerificationScheduleFailedEvent,
  getPrReviewModelPairing,
  REVIEW_LOOP_INGEST_NO_SESSION_FOR_PR_REASON,
  type ReviewLoopEpochTerminalFields,
  VERIFICATION_SCHEDULE_FAILED_REASON,
} from "../../apps/control-plane-worker/src/observability/review-loop-events";

const ENV = { DD_API_KEY: "dd-api-key", WORKER_ENV: "test" } as const;
const LOGS_URL = "https://http-intake.logs.us5.datadoghq.com/api/v2/logs";

function mockFetch() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
}

/** Parses the single structured log entry POSTed to the Datadog logs intake. */
function postedEvent(fetchSpy: ReturnType<typeof mockFetch>): Record<string, unknown> {
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [url, init] = fetchSpy.mock.calls[0]!;
  expect(String(url)).toBe(LOGS_URL);
  const body = JSON.parse(String((init as RequestInit).body));
  expect(body).toHaveLength(1);
  return body[0];
}

/** Parses multiple one-entry structured log POSTs. */
function postedEvents(fetchSpy: ReturnType<typeof mockFetch>, count: number): Record<string, unknown>[] {
  expect(fetchSpy).toHaveBeenCalledTimes(count);
  return fetchSpy.mock.calls.map(([url, init]) => {
    expect(String(url)).toBe(LOGS_URL);
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toHaveLength(1);
    return body[0];
  });
}

const TERMINAL_EPOCH: ReviewLoopEpochTerminalFields = {
  status: "completed",
  sourceKind: "bot",
  blockedReason: null,
  attemptCount: 2,
  wave: 1,
  triggeringSourceIds: ["a", "b", "c"],
  promptedSourceIds: ["a", "b"],
  carriedForwardSourceIds: ["c"],
  createdAt: 1_000,
  updatedAt: 4_000,
  repoOwner: "acme",
  repoName: "widgets",
  ownerUserId: 101,
  sessionId: "sess-1",
  prUrl: "https://github.com/acme/widgets/pull/7",
};

describe("review-loop-events telemetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("no-ops every emitter when DD_API_KEY is absent", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await emitReviewLoopEpochTerminalEvent({ WORKER_ENV: "test" }, TERMINAL_EPOCH, { model: "gpt-5.4" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe("PR review model pairing", () => {
    it.each([
      ["codex", "codex", "same_backend"],
      ["codex", "claude_code", "cross_backend"],
      [null, "codex", "unknown"],
    ])("classifies %s author and %s reviewer as %s", (author, reviewer, pairing) => {
      expect(getPrReviewModelPairing(author as never, reviewer as never)).toBe(pairing);
    });
  });

  describe("review_loop.epoch.completed", () => {
    it("emits a completed epoch with derived numeric and enum fields", async () => {
      const fetchSpy = mockFetch();
      await emitReviewLoopEpochTerminalEvent(ENV, TERMINAL_EPOCH, { model: "gpt-5.4" });
      expect(postedEvent(fetchSpy)).toMatchObject({
        event: "review_loop.epoch.completed",
        terminal_status: "completed",
        source_kind: "bot",
        blocked_reason: "none",
        head_changed: false,
        model: "gpt-5.4",
        repo: "acme/widgets",
        owner_user_id: 101,
        attempt_count: 2,
        wave: 1,
        items_in: 3,
        items_addressed: 2,
        items_dropped: 1,
        duration_ms: 3_000,
        session_id: "sess-1",
      });
    });

    it("emits a blocked epoch and flags head_changed from the blocked reason", async () => {
      const fetchSpy = mockFetch();
      await emitReviewLoopEpochTerminalEvent(
        ENV,
        { ...TERMINAL_EPOCH, status: "blocked", blockedReason: "head_changed" },
        { model: null },
      );
      expect(postedEvent(fetchSpy)).toMatchObject({
        event: "review_loop.epoch.completed",
        terminal_status: "blocked",
        blocked_reason: "head_changed",
        head_changed: true,
        convergence_failure: false,
        model: "unknown",
      });
    });

    it("flags convergence_failure only for genuine cap reasons", async () => {
      const capSpy = mockFetch();
      await emitReviewLoopEpochTerminalEvent(
        ENV,
        { ...TERMINAL_EPOCH, status: "blocked", blockedReason: "ci_attempt_cap_reached" },
        { model: "gpt-5.4" },
      );
      expect(postedEvent(capSpy)).toMatchObject({
        terminal_status: "blocked",
        blocked_reason: "ci_attempt_cap_reached",
        convergence_failure: true,
        head_changed: false,
      });
      vi.restoreAllMocks();

      // A productive-park / operational block is blocked but NOT a convergence failure.
      const parkSpy = mockFetch();
      await emitReviewLoopEpochTerminalEvent(
        ENV,
        { ...TERMINAL_EPOCH, status: "blocked", blockedReason: "worklist_truncation_unresolved" },
        { model: "gpt-5.4" },
      );
      expect(postedEvent(parkSpy)).toMatchObject({
        terminal_status: "blocked",
        blocked_reason: "worklist_truncation_unresolved",
        convergence_failure: false,
      });
    });

    it("derives items_dropped from triggering minus prompted, not the budget-carry set", async () => {
      const fetchSpy = mockFetch();
      // Clean completed: carriedForward is [] (forced on completed settles), yet one triggering item
      // (c) was never prompted. Old logic (carriedForward.length) would report 0; correct is 2.
      await emitReviewLoopEpochTerminalEvent(
        ENV,
        {
          ...TERMINAL_EPOCH,
          triggeringSourceIds: ["a", "b", "c"],
          promptedSourceIds: ["a"],
          carriedForwardSourceIds: [],
        },
        { model: "gpt-5.4" },
      );
      expect(postedEvent(fetchSpy)).toMatchObject({
        event: "review_loop.epoch.completed",
        items_in: 3,
        items_addressed: 1,
        items_dropped: 2,
      });
    });

    it("does NOT emit when the status is non-terminal (carry-forward re-drive)", async () => {
      const fetchSpy = mockFetch();
      await emitReviewLoopEpochTerminalEvent(ENV, { ...TERMINAL_EPOCH, status: "ready" }, { model: "gpt-5.4" });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  it("classifies suspicious ignored ingest reasons only for dropped bot-review webhooks", () => {
    expect(
      classifyReviewLoopIngestIgnoredReason({ webhookKind: "review_submission", reason: "missing_head_sha" }),
    ).toBe("suspicious");
    expect(
      classifyReviewLoopIngestIgnoredReason({ webhookKind: "review_comment", reason: "no_review_listening_session" }),
    ).toBe("suspicious");
    expect(
      classifyReviewLoopIngestIgnoredReason({ webhookKind: "check_run", reason: "no_review_listening_session" }),
    ).toBe("expected");
    expect(classifyReviewLoopIngestIgnoredReason({ webhookKind: "commit_status", reason: "missing_head_sha" })).toBe(
      "expected",
    );
    expect(classifyReviewLoopIngestIgnoredReason({ webhookKind: "review_submission", reason: "stale_head" })).toBe(
      "expected",
    );
  });

  it("keeps bot reviews on PRs Cycloid never tracked out of the suspicious class", () => {
    // A human/third-party PR that a review bot commented on has no session webhook-ref, so the ingest
    // returns `no_session_for_pr`. Even on a content webhook this must classify as expected, otherwise
    // every human PR reviewed by a bot pages the suspicious-ingest monitor.
    for (const webhookKind of ["review_submission", "review_comment", "issue_comment"] as const) {
      expect(
        classifyReviewLoopIngestIgnoredReason({
          webhookKind,
          reason: REVIEW_LOOP_INGEST_NO_SESSION_FOR_PR_REASON,
        }),
      ).toBe("expected");
    }
  });

  it("emits review_loop.ingest.outcome with bounded bot and ignored-class fields", async () => {
    const fetchSpy = mockFetch();
    await emitReviewLoopIngestOutcomeEvent(ENV, {
      sourceKind: "bot",
      webhookKind: "review_submission",
      outcome: "ignored",
      reason: "missing_head_sha",
      repo: "acme/widgets",
      ownerUserId: null,
      sessionId: null,
      prUrl: "https://github.com/acme/widgets/pull/7",
      bot: "cursor-bugbot",
      ignoredClass: "suspicious",
    });
    expect(postedEvent(fetchSpy)).toMatchObject({
      event: "review_loop.ingest.outcome",
      source_kind: "bot",
      webhook_kind: "review_submission",
      outcome: "ignored",
      reason: "missing_head_sha",
      repo: "acme/widgets",
      bot: "cursor-bugbot",
      ignored_class: "suspicious",
    });
  });

  it("emits qa_tester.run.completed", async () => {
    const fetchSpy = mockFetch();
    await emitVerificationRunCompletedEvent(ENV, {
      verdict: "INCONCLUSIVE",
      result: "needs-work",
      needsWorkLabel: "verification-gap",
      needsAppRuntime: true,
      exhausted: false,
      model: "gpt-5.4",
      verifierBackend: "codex",
      parentModel: "claude-opus-4-8",
      parentBackend: "claude_code",
      repo: "acme/widgets",
      ownerUserId: 101,
      runIndex: 2,
      maxRuns: 3,
      evidenceCount: 4,
      blockerCount: 1,
      durationMs: 12_345,
      sessionId: "verif-1",
      prUrl: "https://github.com/acme/widgets/pull/7",
    });
    const [canonical] = postedEvents(fetchSpy, 1);
    expect(canonical).toMatchObject({
      event: "qa_tester.run.completed",
      verdict: "INCONCLUSIVE",
      result: "needs-work",
      needs_work_label: "verification-gap",
      needs_app_runtime: true,
      exhausted: false,
      model: "gpt-5.4",
      verifier_backend: "codex",
      parent_model: "claude-opus-4-8",
      parent_backend: "claude_code",
      run_index: 2,
      max_runs: 3,
      evidence_count: 4,
      blocker_count: 1,
      duration_ms: 12_345,
    });
  });

  it("defaults missing optional fields to safe sentinels on qa_tester.run.completed", async () => {
    const fetchSpy = mockFetch();
    await emitVerificationRunCompletedEvent(ENV, {
      verdict: "CONCLUSIVE",
      result: "merge-ready",
      needsWorkLabel: null,
      needsAppRuntime: false,
      exhausted: false,
      model: null,
      verifierBackend: null,
      parentModel: null,
      parentBackend: null,
      repo: null,
      ownerUserId: 101,
      runIndex: null,
      maxRuns: null,
      evidenceCount: 0,
      blockerCount: 0,
      durationMs: null,
      sessionId: "verif-2",
      prUrl: null,
    });
    const [canonical] = postedEvents(fetchSpy, 1);
    expect(canonical).toMatchObject({
      event: "qa_tester.run.completed",
      needs_work_label: "none",
      model: "unknown",
      verifier_backend: "unknown",
      parent_model: "unknown",
      parent_backend: "unknown",
      repo: "unknown",
    });
  });

  it("emits review_loop.settled with rollup counts and final state", async () => {
    const fetchSpy = mockFetch();
    await emitReviewLoopSettledEvent(ENV, {
      finalState: "verification-exhausted",
      scheduleReason: "verification_run_limit_reached",
      capBlocked: true,
      whichCap: "verification_run",
      model: "gpt-5.4",
      repo: "acme/widgets",
      ownerUserId: 101,
      totalEpochs: 5,
      totalVerificationRuns: 3,
      reviewListeningMs: 600_000,
      sessionId: "sess-1",
      prUrl: "https://github.com/acme/widgets/pull/7",
    });
    expect(postedEvent(fetchSpy)).toMatchObject({
      event: "review_loop.settled",
      final_state: "verification-exhausted",
      schedule_reason: "verification_run_limit_reached",
      cap_blocked: true,
      which_cap: "verification_run",
      total_epochs: 5,
      total_verification_runs: 3,
      review_listening_ms: 600_000,
    });
  });

  describe("classifyVerificationScheduleFailureReason", () => {
    it("maps the provider-credential gate error to provider_key_not_validated (by name and by message)", () => {
      const byName = Object.assign(new Error("some opaque message"), {
        name: "ProviderCredentialNotValidatedError",
      });
      expect(classifyVerificationScheduleFailureReason(byName)).toBe(
        VERIFICATION_SCHEDULE_FAILED_REASON.PROVIDER_KEY_NOT_VALIDATED,
      );
      // The 2026-06-23 stuck-loop signature — message match even if the name is lost across a boundary.
      expect(
        classifyVerificationScheduleFailureReason(
          new Error("No validated OpenAI key. Validate your key in Settings to use gpt-5.4."),
        ),
      ).toBe(VERIFICATION_SCHEDULE_FAILED_REASON.PROVIDER_KEY_NOT_VALIDATED);
      expect(
        classifyVerificationScheduleFailureReason(
          new Error("No validated Anthropic key. Validate your key in Settings to use claude-opus-4-8."),
        ),
      ).toBe(VERIFICATION_SCHEDULE_FAILED_REASON.PROVIDER_KEY_NOT_VALIDATED);
    });

    it("maps opencode access denial to a bounded reason code", () => {
      const byName = Object.assign(new Error("some opaque message"), {
        name: "OpencodeAccessDeniedError",
      });
      expect(classifyVerificationScheduleFailureReason(byName)).toBe(
        VERIFICATION_SCHEDULE_FAILED_REASON.OPENCODE_ACCESS_DENIED,
      );
      expect(
        classifyVerificationScheduleFailureReason(new Error("opencode is only available to Cycloid team members")),
      ).toBe(VERIFICATION_SCHEDULE_FAILED_REASON.OPENCODE_ACCESS_DENIED);
    });

    it("maps enqueue, session-create, and infra throw sites to their reason codes", () => {
      expect(
        classifyVerificationScheduleFailureReason(new Error("Verifier prompt enqueue failed with status 409")),
      ).toBe(VERIFICATION_SCHEDULE_FAILED_REASON.PROMPT_ENQUEUE_FAILED);
      expect(classifyVerificationScheduleFailureReason(new Error("Session DO initialize failed with status 500"))).toBe(
        VERIFICATION_SCHEDULE_FAILED_REASON.SESSION_CREATE_FAILED,
      );
      expect(
        classifyVerificationScheduleFailureReason(
          new Error("Cannot create session without business ownership for user 1"),
        ),
      ).toBe(VERIFICATION_SCHEDULE_FAILED_REASON.SESSION_CREATE_FAILED);
      expect(classifyVerificationScheduleFailureReason(new Error("verification lock acquire failed"))).toBe(
        VERIFICATION_SCHEDULE_FAILED_REASON.INFRA_ERROR,
      );
    });

    it("covers every INFRA_ERROR alternative, including the status 5xx branch with an embedded space", () => {
      // Each message matches ONLY its INFRA_ERROR alternative (no provider/enqueue/session-create
      // keyword), so this exercises claim/D1/database/timeout and the `status 5\d\d` branch — whose
      // closing word boundary sits after the final digit, not after "status".
      for (const message of [
        "claim row write conflict",
        "D1 batch write failed",
        "database is locked",
        "request timeout after 30s",
        "upstream responded with status 503",
      ]) {
        expect(classifyVerificationScheduleFailureReason(new Error(message))).toBe(
          VERIFICATION_SCHEDULE_FAILED_REASON.INFRA_ERROR,
        );
      }
    });

    it("falls back to unknown for unrecognized and non-Error inputs", () => {
      expect(classifyVerificationScheduleFailureReason(new Error("something unexpected"))).toBe(
        VERIFICATION_SCHEDULE_FAILED_REASON.UNKNOWN,
      );
      expect(classifyVerificationScheduleFailureReason("a bare string")).toBe(
        VERIFICATION_SCHEDULE_FAILED_REASON.UNKNOWN,
      );
    });
  });

  describe("qa_tester.schedule.failed", () => {
    it("emits the failure with reason_code and drill-down fields, capping the error", async () => {
      const fetchSpy = mockFetch();
      await emitVerificationScheduleFailedEvent(ENV, {
        reasonCode: VERIFICATION_SCHEDULE_FAILED_REASON.PROVIDER_KEY_NOT_VALIDATED,
        error: "x".repeat(900),
        repo: "acme/widgets",
        ownerUserId: 1,
        sessionId: "parent-1",
        verificationSessionId: "verif-1",
        prUrl: "https://github.com/acme/widgets/pull/7",
        headSha: "fb96b70",
      });
      const [canonical] = postedEvents(fetchSpy, 1);
      expect(canonical).toMatchObject({
        event: "qa_tester.schedule.failed",
        reason_code: "provider_key_not_validated",
        repo: "acme/widgets",
        owner_user_id: 1,
        session_id: "parent-1",
        verification_session_id: "verif-1",
        pr_url: "https://github.com/acme/widgets/pull/7",
        head_sha: "fb96b70",
      });
      expect((canonical.error as string).length).toBe(500);
    });

    it("defaults a null repo to unknown and passes null identifiers through", async () => {
      const fetchSpy = mockFetch();
      await emitVerificationScheduleFailedEvent(ENV, {
        reasonCode: VERIFICATION_SCHEDULE_FAILED_REASON.INFRA_ERROR,
        error: "boom",
        repo: null,
        ownerUserId: 14,
        sessionId: null,
        verificationSessionId: null,
        prUrl: null,
        headSha: null,
      });
      const [canonical] = postedEvents(fetchSpy, 1);
      expect(canonical).toMatchObject({
        event: "qa_tester.schedule.failed",
        reason_code: "infra_error",
        repo: "unknown",
        session_id: null,
        pr_url: null,
      });
    });

    it("no-ops without DD_API_KEY", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      await emitVerificationScheduleFailedEvent(
        { WORKER_ENV: "test" },
        {
          reasonCode: VERIFICATION_SCHEDULE_FAILED_REASON.UNKNOWN,
          error: "boom",
          repo: null,
          ownerUserId: 1,
          sessionId: null,
          verificationSessionId: null,
          prUrl: null,
          headSha: null,
        },
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("review_listening.dormant_count", () => {
    it("emits the snapshot dormant count as a structured event", async () => {
      const fetchSpy = mockFetch();
      await emitReviewListeningDormantCountEvent(ENV, { dormantCount: 4 });
      expect(postedEvent(fetchSpy)).toMatchObject({
        event: "review_listening.dormant_count",
        dormant_count: 4,
      });
    });

    it("emits zero count (emitter fires even when nothing is dormant)", async () => {
      const fetchSpy = mockFetch();
      await emitReviewListeningDormantCountEvent(ENV, { dormantCount: 0 });
      expect(postedEvent(fetchSpy)).toMatchObject({
        event: "review_listening.dormant_count",
        dormant_count: 0,
      });
    });

    it("no-ops without DD_API_KEY", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      await emitReviewListeningDormantCountEvent({ WORKER_ENV: "test" }, { dormantCount: 2 });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
