import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSessionStub = vi.hoisted(() => vi.fn());
const mockPostCountMetricSeries = vi.hoisted(() => vi.fn(async () => undefined));
const mockPostStructuredEventToDd = vi.hoisted(() => vi.fn(async () => true));

vi.mock("../../apps/control-plane-worker/src/session/state", () => ({
  getSessionStub: (...args: unknown[]) => mockGetSessionStub(...args),
}));

vi.mock("../../apps/control-plane-worker/src/observability/pr-metrics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../apps/control-plane-worker/src/observability/pr-metrics")>();
  return {
    ...actual,
    postCountMetricSeries: (...args: unknown[]) => mockPostCountMetricSeries(...args),
  };
});

vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../apps/control-plane-worker/src/observability/events-exporter")>();
  return {
    ...actual,
    postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
  };
});

import type { Logger } from "../../apps/control-plane-worker/src/logger";
import {
  buildSessionIndexDriftEvent,
  fetchSessionIndexReconcilePage,
  isAlertingDrift,
  runSessionIndexReconcilerSweep,
} from "../../apps/control-plane-worker/src/services/session-index-reconciler";

type BoundStatement = {
  query: string;
  values: unknown[];
};

function createMockD1(options: {
  pageRows?: Array<{ session_id: string; updated_at: string | number }>;
  secondPageRows?: Array<{ session_id: string; updated_at: string | number }>;
}) {
  const statements: BoundStatement[] = [];
  let sessionPageCalls = 0;
  const db = {
    prepare(query: string) {
      const statement: BoundStatement = { query, values: [] };
      return {
        bind(...values: unknown[]) {
          statement.values = values;
          statements.push(statement);
          return this;
        },
        async first() {
          return null;
        },
        async all() {
          if (query.includes("FROM session_index")) {
            sessionPageCalls += 1;
            return {
              results: sessionPageCalls === 1 ? (options.pageRows ?? []) : (options.secondPageRows ?? []),
            };
          }
          return { results: [] };
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
    _statements: statements,
  };
  return db as unknown as D1Database & { _statements: BoundStatement[] };
}

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as unknown as Logger;

describe("session-index-reconciler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPostStructuredEventToDd.mockResolvedValue(true);
  });

  it("builds a session_index drift event without raw row values", () => {
    expect(
      buildSessionIndexDriftEvent({
        sessionId: "session-1",
        fieldsChanged: ["rich_status", "runtime_state"],
        outcome: "reprojected",
      }),
    ).toEqual({
      event: "session_index.drift",
      session_id: "session-1",
      fields_changed: ["rich_status", "runtime_state"],
      outcome: "reprojected",
    });
  });

  it("pages active session_index rows with an updated_at plus session_id cursor", async () => {
    const db = createMockD1({
      pageRows: [
        { session_id: "s-1", updated_at: "2026-06-29T10:00:00.000Z" },
        { session_id: "s-2", updated_at: "2026-06-29T10:00:00.000Z" },
      ],
    });

    const firstPage = await fetchSessionIndexReconcilePage(db, null, 50);
    const secondPage = await fetchSessionIndexReconcilePage(db, firstPage.nextCursor, 50);

    expect(firstPage.items).toEqual([
      { sessionId: "s-1", updatedAt: "2026-06-29T10:00:00.000Z" },
      { sessionId: "s-2", updatedAt: "2026-06-29T10:00:00.000Z" },
    ]);
    expect(JSON.parse(firstPage.nextCursor ?? "{}")).toEqual({
      updatedAt: "2026-06-29T10:00:00.000Z",
      sessionId: "s-2",
    });
    expect(db._statements[1].query).toContain("updated_at > ?");
    expect(db._statements[1].query).toContain("updated_at = ? AND session_id > ?");
    expect(db._statements[1].values).toEqual(["2026-06-29T10:00:00.000Z", "2026-06-29T10:00:00.000Z", "s-2", 50]);
    expect(secondPage.items).toEqual([]);
  });

  it("accepts numeric session_index cursors from persisted D1 rows", async () => {
    const db = createMockD1({ pageRows: [] });

    await fetchSessionIndexReconcilePage(db, JSON.stringify({ updatedAt: 1782748800000, sessionId: "s-2" }), 50);

    expect(db._statements[0].query).toContain("updated_at > ?");
    expect(db._statements[0].query).toContain("updated_at = ? AND session_id > ?");
    expect(db._statements[0].values).toEqual([1782748800000, 1782748800000, "s-2", 50]);
  });

  it("does not let a failed reproject route pin the cron sweep cursor", async () => {
    const db = createMockD1({
      pageRows: [{ session_id: "s-1", updated_at: "2026-06-29T10:00:00.000Z" }],
      secondPageRows: [],
    });
    mockGetSessionStub.mockReturnValue({
      fetch: vi.fn(
        async () => new Response(JSON.stringify({ ok: false, drift: false, reason: "missing_row" }), { status: 404 }),
      ),
    });

    const result = await runSessionIndexReconcilerSweep(
      {
        DB: db,
        DD_API_KEY: "dd-key",
        WORKER_ENV: "production",
        SANDBOX_RUNTIME_CLEANUP_SECRET: "secret",
        SESSION: {},
      } as never,
      { logger },
    );

    expect(result.failed).toBe(0);
    expect(result.processed).toBe(1);
    expect(mockPostCountMetricSeries).toHaveBeenCalledWith(
      "dd-key",
      [
        expect.objectContaining({
          metric: "arcanist.session_index.reprojected",
          tags: expect.arrayContaining(["drift:unknown", "outcome:http_404"]),
        }),
      ],
      "session-index-reconciler",
    );
    expect(db._statements.some((statement) => statement.query.includes("INSERT INTO cron_sweep_cursors"))).toBe(true);
  });

  it("emits bounded per-field drift metrics and a structured drift event for changed fields", async () => {
    const db = createMockD1({
      pageRows: [{ session_id: "s-drift", updated_at: "2026-06-29T10:00:00.000Z" }],
      secondPageRows: [],
    });
    mockGetSessionStub.mockReturnValue({
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              drift: true,
              fields_changed: ["rich_status", "runtime_backend"],
            }),
            { status: 200 },
          ),
      ),
    });

    const result = await runSessionIndexReconcilerSweep(
      {
        DB: db,
        DD_API_KEY: "dd-key",
        WORKER_ENV: "production",
        SANDBOX_RUNTIME_CLEANUP_SECRET: "secret",
        SESSION: {},
      } as never,
      { logger },
    );

    expect(result.failed).toBe(0);
    expect(mockPostCountMetricSeries).toHaveBeenCalledWith(
      "dd-key",
      [
        expect.objectContaining({
          metric: "arcanist.session_index.reprojected",
          tags: expect.arrayContaining(["drift:true", "outcome:reprojected", "env:production"]),
        }),
      ],
      "session-index-reconciler",
    );
    expect(mockPostCountMetricSeries).toHaveBeenCalledWith(
      "dd-key",
      [
        expect.objectContaining({
          metric: "arcanist.session_index.drift_field",
          tags: expect.arrayContaining(["field:rich_status", "drift:true", "outcome:reprojected", "env:production"]),
        }),
        expect.objectContaining({
          metric: "arcanist.session_index.drift_field",
          tags: expect.arrayContaining([
            "field:runtime_backend",
            "drift:true",
            "outcome:reprojected",
            "env:production",
          ]),
        }),
      ],
      "session-index-drift-field",
    );
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.objectContaining({ DD_API_KEY: "dd-key", WORKER_ENV: "production" }),
      {
        event: "session_index.drift",
        session_id: "s-drift",
        fields_changed: ["rich_status", "runtime_backend"],
        outcome: "reprojected",
      },
    );
  });

  it("does not emit drift attribution when the row is clean", async () => {
    const db = createMockD1({
      pageRows: [{ session_id: "s-clean", updated_at: "2026-06-29T10:00:00.000Z" }],
      secondPageRows: [],
    });
    mockGetSessionStub.mockReturnValue({
      fetch: vi.fn(
        async () => new Response(JSON.stringify({ ok: true, drift: false, fields_changed: [] }), { status: 200 }),
      ),
    });

    await runSessionIndexReconcilerSweep(
      {
        DB: db,
        DD_API_KEY: "dd-key",
        WORKER_ENV: "production",
        SANDBOX_RUNTIME_CLEANUP_SECRET: "secret",
        SESSION: {},
      } as never,
      { logger },
    );

    expect(mockPostCountMetricSeries).not.toHaveBeenCalledWith(
      "dd-key",
      expect.arrayContaining([expect.objectContaining({ metric: "arcanist.session_index.drift_field" })]),
      "session-index-drift-field",
    );
    expect(mockPostStructuredEventToDd).not.toHaveBeenCalled();
  });

  it("filters fields_changed against the bounded session_index column allowlist", async () => {
    const db = createMockD1({
      pageRows: [{ session_id: "s-filter", updated_at: "2026-06-29T10:00:00.000Z" }],
      secondPageRows: [],
    });
    mockGetSessionStub.mockReturnValue({
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              drift: true,
              fields_changed: ["runtime_state", "unknown_column", 123, "runtime_preview_url"],
            }),
            { status: 200 },
          ),
      ),
    });

    await runSessionIndexReconcilerSweep(
      {
        DB: db,
        DD_API_KEY: "dd-key",
        WORKER_ENV: "production",
        SANDBOX_RUNTIME_CLEANUP_SECRET: "secret",
        SESSION: {},
      } as never,
      { logger },
    );

    expect(mockPostCountMetricSeries).toHaveBeenCalledWith(
      "dd-key",
      [
        expect.objectContaining({
          tags: expect.arrayContaining(["field:runtime_state"]),
        }),
        expect.objectContaining({
          tags: expect.arrayContaining(["field:runtime_preview_url"]),
        }),
      ],
      "session-index-drift-field",
    );
    const allTags = mockPostCountMetricSeries.mock.calls.flatMap(([, series]) =>
      (series as Array<{ tags: string[] }>).flatMap((item) => item.tags),
    );
    expect(allTags).not.toContain("field:unknown_column");
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fields_changed: ["runtime_state", "runtime_preview_url"] }),
    );
  });

  it.each([[], undefined, "runtime_state"])(
    "does not emit drift field metrics when fields_changed is %s",
    async (fieldsChanged) => {
      const db = createMockD1({
        pageRows: [{ session_id: "s-empty", updated_at: "2026-06-29T10:00:00.000Z" }],
        secondPageRows: [],
      });
      mockGetSessionStub.mockReturnValue({
        fetch: vi.fn(
          async () =>
            new Response(JSON.stringify({ ok: true, drift: true, fields_changed: fieldsChanged }), { status: 200 }),
        ),
      });

      await runSessionIndexReconcilerSweep(
        {
          DB: db,
          DD_API_KEY: "dd-key",
          WORKER_ENV: "production",
          SANDBOX_RUNTIME_CLEANUP_SECRET: "secret",
          SESSION: {},
        } as never,
        { logger },
      );

      expect(mockPostCountMetricSeries).not.toHaveBeenCalledWith(
        "dd-key",
        expect.arrayContaining([expect.objectContaining({ metric: "arcanist.session_index.drift_field" })]),
        "session-index-drift-field",
      );
      expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ fields_changed: [] }),
      );
    },
  );

  it("no-ops drift attribution without a Datadog API key", async () => {
    const db = createMockD1({
      pageRows: [{ session_id: "s-no-dd", updated_at: "2026-06-29T10:00:00.000Z" }],
      secondPageRows: [],
    });
    mockGetSessionStub.mockReturnValue({
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, drift: true, fields_changed: ["rich_status"] }), { status: 200 }),
      ),
    });

    const result = await runSessionIndexReconcilerSweep(
      {
        DB: db,
        WORKER_ENV: "production",
        SANDBOX_RUNTIME_CLEANUP_SECRET: "secret",
        SESSION: {},
      } as never,
      { logger },
    );

    expect(result.failed).toBe(0);
    expect(mockPostCountMetricSeries).not.toHaveBeenCalled();
    expect(mockPostStructuredEventToDd).not.toHaveBeenCalled();
  });

  it("keeps a drift reproject successful when the structured event sink fails", async () => {
    const db = createMockD1({
      pageRows: [{ session_id: "s-event-fails", updated_at: "2026-06-29T10:00:00.000Z" }],
      secondPageRows: [],
    });
    mockPostStructuredEventToDd.mockRejectedValueOnce(new Error("logs intake unavailable"));
    mockGetSessionStub.mockReturnValue({
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, drift: true, fields_changed: ["rich_status"] }), { status: 200 }),
      ),
    });

    const result = await runSessionIndexReconcilerSweep(
      {
        DB: db,
        DD_API_KEY: "dd-key",
        WORKER_ENV: "production",
        SANDBOX_RUNTIME_CLEANUP_SECRET: "secret",
        SESSION: {},
      } as never,
      { logger },
    );

    expect(result.failed).toBe(0);
    expect(mockPostCountMetricSeries).toHaveBeenCalledWith(
      "dd-key",
      [
        expect.objectContaining({
          metric: "arcanist.session_index.reprojected",
          tags: expect.arrayContaining(["drift:true", "outcome:reprojected"]),
        }),
      ],
      "session-index-reconciler",
    );
    const allTags = mockPostCountMetricSeries.mock.calls.flatMap(([, series]) =>
      (series as Array<{ tags: string[] }>).flatMap((item) => item.tags),
    );
    expect(allTags).not.toContain("outcome:exception");
    expect(db._statements.some((statement) => statement.query.includes("INSERT INTO cron_sweep_cursors"))).toBe(true);
  });

  it.each([
    { fieldsChanged: [], alerting: true },
    { fieldsChanged: ["runtime_live_lease_expires_at"], alerting: false },
    { fieldsChanged: ["runtime_live_lease_expires_at", "runtime_state"], alerting: true },
    { fieldsChanged: ["rich_status"], alerting: true },
  ])("isAlertingDrift($fieldsChanged) === $alerting", ({ fieldsChanged, alerting }) => {
    expect(isAlertingDrift(fieldsChanged)).toBe(alerting);
  });

  it("reports a live-lease-only reprojection as non-alerting soft drift", async () => {
    const db = createMockD1({
      pageRows: [{ session_id: "s-lease", updated_at: "2026-06-29T10:00:00.000Z" }],
      secondPageRows: [],
    });
    mockGetSessionStub.mockReturnValue({
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, drift: true, fields_changed: ["runtime_live_lease_expires_at"] }), {
            status: 200,
          }),
      ),
    });

    await runSessionIndexReconcilerSweep(
      {
        DB: db,
        DD_API_KEY: "dd-key",
        WORKER_ENV: "production",
        SANDBOX_RUNTIME_CLEANUP_SECRET: "secret",
        SESSION: {},
      } as never,
      { logger },
    );

    // The drift monitor keys on drift:true, so a lease-only refresh must report drift:false.
    expect(mockPostCountMetricSeries).toHaveBeenCalledWith(
      "dd-key",
      [
        expect.objectContaining({
          metric: "arcanist.session_index.reprojected",
          tags: expect.arrayContaining(["drift:false", "outcome:reprojected_soft"]),
        }),
      ],
      "session-index-reconciler",
    );
    // Field-level observability is preserved, also tagged non-alerting.
    expect(mockPostCountMetricSeries).toHaveBeenCalledWith(
      "dd-key",
      [
        expect.objectContaining({
          metric: "arcanist.session_index.drift_field",
          tags: expect.arrayContaining([
            "field:runtime_live_lease_expires_at",
            "drift:false",
            "outcome:reprojected_soft",
          ]),
        }),
      ],
      "session-index-drift-field",
    );
    const allTags = mockPostCountMetricSeries.mock.calls.flatMap(([, series]) =>
      (series as Array<{ tags: string[] }>).flatMap((item) => item.tags),
    );
    expect(allTags).not.toContain("drift:true");
    // A benign lease refresh is not a drift incident: no structured event.
    expect(mockPostStructuredEventToDd).not.toHaveBeenCalled();
  });

  it("still alerts when a state field drifts alongside the live lease", async () => {
    const db = createMockD1({
      pageRows: [{ session_id: "s-mixed", updated_at: "2026-06-29T10:00:00.000Z" }],
      secondPageRows: [],
    });
    mockGetSessionStub.mockReturnValue({
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              drift: true,
              fields_changed: ["runtime_live_lease_expires_at", "runtime_state"],
            }),
            { status: 200 },
          ),
      ),
    });

    await runSessionIndexReconcilerSweep(
      {
        DB: db,
        DD_API_KEY: "dd-key",
        WORKER_ENV: "production",
        SANDBOX_RUNTIME_CLEANUP_SECRET: "secret",
        SESSION: {},
      } as never,
      { logger },
    );

    expect(mockPostCountMetricSeries).toHaveBeenCalledWith(
      "dd-key",
      [
        expect.objectContaining({
          metric: "arcanist.session_index.reprojected",
          tags: expect.arrayContaining(["drift:true", "outcome:reprojected"]),
        }),
      ],
      "session-index-reconciler",
    );
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        fields_changed: ["runtime_live_lease_expires_at", "runtime_state"],
        outcome: "reprojected",
      }),
    );
  });
});
