import { describe, expect, it } from "vitest";

import { ARCANIST_SCHEDULED_LABEL, E2E_TESTED_LABEL } from "../../apps/control-plane-worker/src/constants/pr-labels";
import { InitiationMode } from "../../apps/control-plane-worker/src/enums/initiation-mode";
import { ensureRepoLabel } from "../../apps/control-plane-worker/src/github/pr";
import { appendScheduledRunFooter } from "../../apps/control-plane-worker/src/session/pr-body";

describe("appendScheduledRunFooter", () => {
  const baseBody = "## Changes\nUpdated the workflow\n\n🤖 Generated with [Cycloid](https://trycycloid.com)";

  it("is a no-op for user-initiated sessions", () => {
    const body = appendScheduledRunFooter(
      baseBody,
      {
        initiationMode: InitiationMode.USER,
        ruleNameSnapshot: "Nightly tidy",
        cronSnapshot: "0 14 * * 1-5",
      },
      "2026-05-22T14:00:00Z",
    );
    expect(body).toBe(baseBody);
  });

  it("is a no-op when initiationMode is automation but the cron snapshot is missing", () => {
    const body = appendScheduledRunFooter(
      baseBody,
      { initiationMode: InitiationMode.AUTOMATION, ruleNameSnapshot: "Nightly tidy", cronSnapshot: null },
      "2026-05-22T14:00:00Z",
    );
    expect(body).toBe(baseBody);
  });

  it("renders the footer from the immutable snapshots and the fired timestamp", () => {
    const body = appendScheduledRunFooter(
      baseBody,
      {
        initiationMode: InitiationMode.AUTOMATION,
        ruleNameSnapshot: "Nightly tidy",
        cronSnapshot: "0 14 * * 1-5",
      },
      "2026-05-22T14:00:00Z",
    );
    expect(
      body.endsWith(`🤖 Scheduled run · rule "Nightly tidy" · cron \`0 14 * * 1-5\` · fired 2026-05-22T14:00:00Z`),
    ).toBe(true);
    // base content survives
    expect(body).toContain("🤖 Generated with [Cycloid](https://trycycloid.com)");
  });

  it("omits the rule name segment when no name snapshot is set", () => {
    const body = appendScheduledRunFooter(
      baseBody,
      { initiationMode: InitiationMode.AUTOMATION, ruleNameSnapshot: null, cronSnapshot: "0 14 * * 1-5" },
      "2026-05-22T14:00:00Z",
    );
    expect(body).toContain(`🤖 Scheduled run · cron \`0 14 * * 1-5\` · fired 2026-05-22T14:00:00Z`);
    expect(body).not.toContain(`rule "`);
  });

  it("regenerates the footer on PR-update without duplicating it", () => {
    const firstPass = appendScheduledRunFooter(
      baseBody,
      {
        initiationMode: InitiationMode.AUTOMATION,
        ruleNameSnapshot: "Nightly tidy",
        cronSnapshot: "0 14 * * 1-5",
      },
      "2026-05-22T14:00:00Z",
    );
    // Composer is invoked again on PR-update; previous body is reused as input.
    const secondPass = appendScheduledRunFooter(
      firstPass,
      {
        initiationMode: InitiationMode.AUTOMATION,
        ruleNameSnapshot: "Nightly tidy",
        cronSnapshot: "0 14 * * 1-5",
      },
      "2026-05-22T14:00:00Z",
    );
    const matches = secondPass.match(/🤖 Scheduled run/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("re-reads snapshots from session metadata (not from any live rule lookup)", () => {
    // Simulate a rule rename or delete after the session was enqueued: the
    // composer must keep using the per-session snapshot frozen at enqueue time.
    const enqueueSnapshot = {
      initiationMode: InitiationMode.AUTOMATION,
      ruleNameSnapshot: "Original name",
      cronSnapshot: "0 14 * * 1-5",
    };
    const original = appendScheduledRunFooter(baseBody, enqueueSnapshot, "2026-05-22T14:00:00Z");
    // A later composition with the same snapshot still renders the same name,
    // even though the live rule may have been renamed or deleted in the DB.
    const reRendered = appendScheduledRunFooter(original, enqueueSnapshot, "2026-05-22T14:00:00Z");
    expect(reRendered).toContain('rule "Original name"');
    expect(reRendered).not.toContain("Renamed by user");
  });

  it("removes a stale scheduled footer when the session is no longer automation", () => {
    const scheduled = appendScheduledRunFooter(
      baseBody,
      {
        initiationMode: InitiationMode.AUTOMATION,
        ruleNameSnapshot: "Nightly tidy",
        cronSnapshot: "0 14 * * 1-5",
      },
      "2026-05-22T14:00:00Z",
    );
    // Defensive: even though promotion from automation -> user is not a real
    // workflow, the strip-then-append path must not leak the footer.
    const reverted = appendScheduledRunFooter(
      scheduled,
      { initiationMode: InitiationMode.USER, ruleNameSnapshot: null, cronSnapshot: null },
      null,
    );
    expect(reverted).not.toContain("Scheduled run");
  });
});

type FetchInit = { method?: string; headers?: HeadersInit; body?: BodyInit | null };
type Recorded = { url: string; method: string; headers: Record<string, string>; body: unknown };
type Responder = (req: Recorded) => Response | Promise<Response>;

function withMockFetch(responder: Responder, run: (calls: Recorded[]) => Promise<void>): Promise<void> {
  const calls: Recorded[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: FetchInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const headersInit = init?.headers ?? {};
    const headers: Record<string, string> = {};
    if (headersInit instanceof Headers) headersInit.forEach((v, k) => (headers[k] = v));
    else if (Array.isArray(headersInit)) for (const [k, v] of headersInit) headers[k] = v;
    else for (const [k, v] of Object.entries(headersInit)) headers[k] = String(v);
    const body =
      typeof init?.body === "string" ? safeJsonParse(init.body as string) : init?.body ? String(init.body) : null;
    const record: Recorded = { url, method, headers, body };
    calls.push(record);
    return responder(record);
  }) as typeof globalThis.fetch;
  return run(calls).finally(() => {
    globalThis.fetch = original;
  });
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

describe("ensureRepoLabel", () => {
  it("returns created:false without mutation when the label already matches (GET 200)", async () => {
    await withMockFetch(
      () =>
        new Response(JSON.stringify({ name: ARCANIST_SCHEDULED_LABEL, color: "5319e7", description: "desc" }), {
          status: 200,
        }),
      async (calls) => {
        const result = await ensureRepoLabel("token", "acme", "webapp", ARCANIST_SCHEDULED_LABEL, "5319e7", "desc");
        expect(result).toEqual({ ok: true, created: false });
        // Only the lookup call, no metadata update when the label already matches.
        expect(calls).toHaveLength(1);
        expect(calls[0].method).toBe("GET");
      },
    );
  });

  it("updates an existing label when its metadata is stale", async () => {
    await withMockFetch(
      (req) => {
        if (req.method === "GET") {
          return new Response(JSON.stringify({ name: "verification-stopped", color: "ededed" }), { status: 200 });
        }
        return new Response(JSON.stringify({ name: "verification-stopped", color: "d73a4a" }), { status: 200 });
      },
      async (calls) => {
        const result = await ensureRepoLabel(
          "token",
          "acme",
          "webapp",
          "verification-stopped",
          "d73a4a",
          "Cycloid QA testing stopped before completion",
        );

        expect(result).toEqual({ ok: true, created: false });
        expect(calls).toHaveLength(2);
        expect(calls[1].url).toBe("https://api.github.com/repos/acme/webapp/labels/verification-stopped");
        expect(calls[1].method).toBe("PATCH");
        expect(calls[1].body).toMatchObject({
          color: "d73a4a",
          description: "Cycloid QA testing stopped before completion",
        });
      },
    );
  });

  it("does not update metadata drift when configured for create-only ensure", async () => {
    await withMockFetch(
      () =>
        new Response(JSON.stringify({ name: E2E_TESTED_LABEL, color: "abcdef", description: "Customer label" }), {
          status: 200,
        }),
      async (calls) => {
        const result = await ensureRepoLabel(
          "token",
          "acme",
          "webapp",
          E2E_TESTED_LABEL,
          "0e8a16",
          "End-to-end tested",
          { updateOnDrift: false },
        );

        expect(result).toEqual({ ok: true, created: false });
        expect(calls).toHaveLength(1);
        expect(calls[0].method).toBe("GET");
      },
    );
  });

  it("includes an explicit empty description when updating label metadata", async () => {
    await withMockFetch(
      (req) => {
        if (req.method === "GET") {
          return new Response(JSON.stringify({ name: ARCANIST_SCHEDULED_LABEL, color: "ededed", description: "old" }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ name: ARCANIST_SCHEDULED_LABEL, color: "5319e7", description: "" }), {
          status: 200,
        });
      },
      async (calls) => {
        const result = await ensureRepoLabel("token", "acme", "webapp", ARCANIST_SCHEDULED_LABEL, "5319e7", "");

        expect(result).toEqual({ ok: true, created: false });
        expect(calls).toHaveLength(2);
        expect(calls[1].method).toBe("PATCH");
        expect(calls[1].body).toMatchObject({ color: "5319e7", description: "" });
      },
    );
  });

  it("creates the label when missing and returns created:true", async () => {
    await withMockFetch(
      (req) => {
        if (req.method === "GET") return new Response("not found", { status: 404 });
        return new Response(JSON.stringify({ name: ARCANIST_SCHEDULED_LABEL }), { status: 201 });
      },
      async (calls) => {
        const result = await ensureRepoLabel("token", "acme", "webapp", ARCANIST_SCHEDULED_LABEL, "5319e7", "desc");
        expect(result).toEqual({ ok: true, created: true });
        const createCall = calls.find((c) => c.method === "POST");
        expect(createCall).toBeDefined();
        expect(createCall?.body).toMatchObject({
          name: ARCANIST_SCHEDULED_LABEL,
          color: "5319e7",
          description: "desc",
        });
      },
    );
  });

  it("treats 422 on POST as a benign race (concurrent writer created the label)", async () => {
    await withMockFetch(
      (req) => {
        if (req.method === "GET") return new Response("not found", { status: 404 });
        return new Response("validation failed", { status: 422 });
      },
      async () => {
        const result = await ensureRepoLabel("token", "acme", "webapp", ARCANIST_SCHEDULED_LABEL, "5319e7", "desc");
        expect(result).toEqual({ ok: true, created: false });
      },
    );
  });

  it("returns permission_denied when GET label lookup is 403", async () => {
    await withMockFetch(
      () => new Response("forbidden", { status: 403 }),
      async () => {
        const result = await ensureRepoLabel("token", "acme", "webapp", ARCANIST_SCHEDULED_LABEL, "5319e7", "desc");
        expect(result).toEqual({ ok: false, reason: "permission_denied", status: 403, detail: "forbidden" });
      },
    );
  });

  it("returns permission_denied when label creation is denied by repo settings", async () => {
    await withMockFetch(
      (req) => {
        if (req.method === "GET") return new Response("not found", { status: 404 });
        return new Response("forbidden", { status: 403 });
      },
      async () => {
        const result = await ensureRepoLabel("token", "acme", "webapp", ARCANIST_SCHEDULED_LABEL, "5319e7", "desc");
        expect(result).toEqual({ ok: false, reason: "permission_denied", status: 403, detail: "forbidden" });
      },
    );
  });
});
