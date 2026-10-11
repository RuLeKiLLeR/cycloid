import { afterEach, describe, expect, it, vi } from "vitest";

import {
  emitPrCreatedMetric,
  emitReviewLoopArmedMetric,
  emitReviewLoopDispatchDeferredMetric,
  emitReviewLoopInstallationCapabilitiesMissingMetric,
  emitReviewLoopTriageMetric,
} from "../../apps/control-plane-worker/src/observability/pr-metrics";

describe("emitPrCreatedMetric", () => {
  afterEach(() => vi.restoreAllMocks());

  it("POSTs a us5 count metric arcanist.pr.created tagged draft:true for draft PRs", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }));
    await emitPrCreatedMetric({ DD_API_KEY: "key-123", WORKER_ENV: "production" } as never, {
      repo: "acme/repo",
      ownerUserId: 101,
      draft: true,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://api.us5.datadoghq.com/api/v2/series");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.series[0].metric).toBe("arcanist.pr.created");
    expect(body.series[0].type).toBe(1); // COUNT
    expect(body.series[0].points[0].value).toBe(1);
    expect(body.series[0].tags).toEqual(
      expect.arrayContaining([
        "service:cycloid-control-plane",
        "worker:control-plane",
        "repo:acme/repo",
        "draft:true",
        "env:production",
      ]),
    );
  });

  it("sends an abort signal so a slow us5 endpoint can't stall indefinitely", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }));
    await emitPrCreatedMetric({ DD_API_KEY: "key-123", WORKER_ENV: "production" } as never, {
      repo: "acme/repo",
      ownerUserId: 101,
      draft: true,
    });
    expect((fetchSpy.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("does not tag owner_user_id on the per-PR metric", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }));
    await emitPrCreatedMetric({ DD_API_KEY: "key-123", WORKER_ENV: "production" } as never, {
      repo: "acme/repo",
      ownerUserId: 101,
      draft: true,
    });
    const tags = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string).series[0].tags as string[];
    expect(tags.some((t) => t.startsWith("owner_user_id:"))).toBe(false);
    // The count still lands with its other tags.
    expect(tags).toEqual(expect.arrayContaining(["repo:acme/repo", "draft:true"]));
  });

  it("does not tag session_id (would be unbounded cardinality on a per-PR metric)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }));
    await emitPrCreatedMetric({ DD_API_KEY: "key-123", WORKER_ENV: "production" } as never, {
      repo: "acme/repo",
      ownerUserId: 101,
      draft: true,
    });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect((body.series[0].tags as string[]).some((t) => t.startsWith("session_id:"))).toBe(false);
  });

  it("tags draft:false for ready (green) PRs", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }));
    await emitPrCreatedMetric({ DD_API_KEY: "key-123", WORKER_ENV: "production" } as never, {
      repo: "acme/repo",
      ownerUserId: 101,
      draft: false,
    });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.series[0].tags).toEqual(expect.arrayContaining(["draft:false"]));
    expect(body.series[0].tags).not.toEqual(expect.arrayContaining(["draft:true"]));
  });

  it("defaults env to production when WORKER_ENV is unset", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }));
    await emitPrCreatedMetric({ DD_API_KEY: "key-123" } as never, {
      repo: "acme/repo",
      ownerUserId: 101,
      draft: false,
    });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.series[0].tags).toEqual(expect.arrayContaining(["env:production"]));
  });

  it("no-ops without an API key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await emitPrCreatedMetric({} as never, { repo: "acme/repo", ownerUserId: 101, draft: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("emitReviewLoopArmedMetric", () => {
  afterEach(() => vi.restoreAllMocks());

  it("POSTs a us5 count metric arcanist.review_loop.armed tagged draft:true for draft PRs", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }));
    await emitReviewLoopArmedMetric({ DD_API_KEY: "key-123", WORKER_ENV: "production" } as never, {
      repo: "acme/repo",
      ownerUserId: 101,
      draft: true,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://api.us5.datadoghq.com/api/v2/series");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.series[0].metric).toBe("arcanist.review_loop.armed");
    expect(body.series[0].type).toBe(1); // COUNT
    expect(body.series[0].points[0].value).toBe(1);
    expect(body.series[0].tags).toEqual(
      expect.arrayContaining([
        "service:cycloid-control-plane",
        "worker:control-plane",
        "repo:acme/repo",
        "draft:true",
        "env:production",
      ]),
    );
  });

  it("tags draft:false for ready (green) PRs entering the loop", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }));
    await emitReviewLoopArmedMetric({ DD_API_KEY: "key-123", WORKER_ENV: "production" } as never, {
      repo: "acme/repo",
      ownerUserId: 101,
      draft: false,
    });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.series[0].tags).toEqual(expect.arrayContaining(["draft:false"]));
    expect(body.series[0].tags).not.toEqual(expect.arrayContaining(["draft:true"]));
  });

  it("sends an abort signal so a slow us5 endpoint can't stall indefinitely", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }));
    await emitReviewLoopArmedMetric({ DD_API_KEY: "key-123", WORKER_ENV: "production" } as never, {
      repo: "acme/repo",
      ownerUserId: 101,
      draft: true,
    });
    expect((fetchSpy.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("does not tag owner_user_id on the review-loop arming metric", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }));
    await emitReviewLoopArmedMetric({ DD_API_KEY: "key-123", WORKER_ENV: "production" } as never, {
      repo: "acme/repo",
      ownerUserId: 101,
      draft: true,
    });
    const tags = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string).series[0].tags as string[];
    expect(tags.some((t) => t.startsWith("owner_user_id:"))).toBe(false);
    expect(tags).toEqual(expect.arrayContaining(["repo:acme/repo", "draft:true"]));
  });

  it("does not tag session_id (would be unbounded cardinality on a per-arming metric)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }));
    await emitReviewLoopArmedMetric({ DD_API_KEY: "key-123", WORKER_ENV: "production" } as never, {
      repo: "acme/repo",
      ownerUserId: 101,
      draft: false,
    });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect((body.series[0].tags as string[]).some((t) => t.startsWith("session_id:"))).toBe(false);
  });

  it("no-ops without an API key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await emitReviewLoopArmedMetric({} as never, { repo: "acme/repo", ownerUserId: 101, draft: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("RLA v2 review-loop counters", () => {
  afterEach(() => vi.restoreAllMocks());

  it("counts missing installation capabilities without owner_user_id", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }));
    await emitReviewLoopInstallationCapabilitiesMissingMetric(
      { DD_API_KEY: "key-123", WORKER_ENV: "production" },
      {
        repo: "acme/repo",
        owner: "acme",
        ownerUserId: 101,
        installationId: 12345,
        missingPermissions: ["checks"],
        missingEvents: ["check_run"],
      },
    );
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.series[0].metric).toBe("arcanist.review_loop.installation_capabilities_missing");
    expect(body.series[0].tags).toEqual(
      expect.arrayContaining([
        "repo:acme/repo",
        "owner:acme",
        "installation_id:12345",
        "missing_permissions:checks",
        "missing_events:check_run",
      ]),
    );
    expect(body.series[0].tags).not.toEqual(expect.arrayContaining(["owner_user_id:101"]));
  });

  it("counts dispatch deferrals tagged with the deferral reason", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }));
    await emitReviewLoopDispatchDeferredMetric(
      { DD_API_KEY: "key-123", WORKER_ENV: "production" },
      { repo: "acme/repo", ownerUserId: 101, reason: "verification_in_progress" },
    );
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.series[0].metric).toBe("arcanist.review_loop.dispatch_deferred");
    expect(body.series[0].tags).toEqual(expect.arrayContaining(["repo:acme/repo", "reason:verification_in_progress"]));
    expect(body.series[0].tags).not.toEqual(expect.arrayContaining(["owner_user_id:101"]));
  });

  it("counts triage outcomes and emits dropped/discarded/conflict counts as separate series", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }));
    await emitReviewLoopTriageMetric(
      { DD_API_KEY: "key-123", WORKER_ENV: "production" },
      {
        repo: "acme/repo",
        ownerUserId: 101,
        outcome: "used",
        reason: null,
        category: null,
        droppedItemCount: 3,
        conflictCount: 2,
        conflictDroppedCount: 5,
        discardedActionItemCount: 1,
      },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(5);
    const bodies = fetchSpy.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string));
    expect(bodies[0].series[0].metric).toBe("arcanist.review_loop.triage");
    expect(bodies[0].series[0].tags).toEqual(expect.arrayContaining(["outcome:used", "reason:none", "category:none"]));
    expect(bodies[1].series[0].metric).toBe("arcanist.review_loop.triage_dropped_items");
    expect(bodies[1].series[0].points[0].value).toBe(3);
    expect(bodies[2].series[0].metric).toBe("arcanist.review_loop.triage_discarded_action_items");
    expect(bodies[2].series[0].points[0].value).toBe(1);
    expect(bodies[3].series[0].metric).toBe("arcanist.review_loop.triage_conflicts");
    expect(bodies[3].series[0].points[0].value).toBe(2);
    // Proposed-but-pruned conflicts get their own series so under-firing vs over-pruning is visible.
    expect(bodies[4].series[0].metric).toBe("arcanist.review_loop.triage_conflicts_dropped");
    expect(bodies[4].series[0].points[0].value).toBe(5);
  });

  it("omits the conflicts series when no conflicts were detected", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }));
    await emitReviewLoopTriageMetric(
      { DD_API_KEY: "key-123", WORKER_ENV: "production" },
      {
        repo: "acme/repo",
        ownerUserId: 101,
        outcome: "used",
        reason: null,
        category: null,
        droppedItemCount: 0,
        conflictCount: 0,
        conflictDroppedCount: 0,
        discardedActionItemCount: 0,
      },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const metrics = fetchSpy.mock.calls.map(
      (call) => JSON.parse((call[1] as RequestInit).body as string).series[0].metric,
    );
    expect(metrics).not.toContain("arcanist.review_loop.triage_conflicts");
    expect(metrics).not.toContain("arcanist.review_loop.triage_conflicts_dropped");
  });

  it("emits only the conflicts-dropped series when all proposed conflicts were pruned", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }));
    await emitReviewLoopTriageMetric(
      { DD_API_KEY: "key-123", WORKER_ENV: "production" },
      {
        repo: "acme/repo",
        ownerUserId: 101,
        outcome: "used",
        reason: null,
        category: null,
        droppedItemCount: 0,
        conflictCount: 0,
        conflictDroppedCount: 2,
        discardedActionItemCount: 0,
      },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const metrics = fetchSpy.mock.calls.map(
      (call) => JSON.parse((call[1] as RequestInit).body as string).series[0].metric,
    );
    expect(metrics).toContain("arcanist.review_loop.triage_conflicts_dropped");
    expect(metrics).not.toContain("arcanist.review_loop.triage_conflicts");
  });

  it("counts a triage fallback with its reason and no count series", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }));
    await emitReviewLoopTriageMetric(
      { DD_API_KEY: "key-123", WORKER_ENV: "production" },
      {
        repo: "acme/repo",
        ownerUserId: 101,
        outcome: "fallback",
        reason: "llm_unavailable",
        category: "provider_error_nonretryable",
        droppedItemCount: 0,
        conflictCount: 0,
        conflictDroppedCount: 0,
        discardedActionItemCount: 0,
      },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.series[0].tags).toEqual(
      expect.arrayContaining(["outcome:fallback", "reason:llm_unavailable", "category:provider_error_nonretryable"]),
    );
  });
});
