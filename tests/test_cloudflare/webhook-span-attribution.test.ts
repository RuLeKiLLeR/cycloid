import { describe, expect, it, vi } from "vitest";

// Static imports so handleGithubWebhook and the span context share ONE module
// instance (and therefore one AsyncLocalStorage). A dynamic import + vi.doMock
// harness would load a second copy of observability/context, detaching the
// span store and masking whether the tag actually lands on the root span.
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

import { drainSpans, endSpan, runInSpan, startSpan } from "../../apps/control-plane-worker/src/observability/context";
import type { Env } from "../../apps/control-plane-worker/src/types";
import { handleGithubWebhook } from "../../apps/control-plane-worker/src/webhooks/github";
import { makeSignedGithubRequest } from "./github-webhook-fixtures";

const WEBHOOK_SECRET = "test-webhook-secret";

describe("webhook span attribution (real router-style span)", () => {
  it("records github.event and github.action on the ended worker.fetch root span", async () => {
    // A `repository` event with an action hits the switch default (skipped), so
    // no DB/network is exercised — only signature verification, body parse, and
    // the span tagging. This mirrors router.ts: handler runs inside the
    // worker.fetch span, then endSpan + drainSpans inside the same ALS scope.
    const body = JSON.stringify({ action: "edited" });
    const request = await makeSignedGithubRequest(body, { eventType: "repository", secret: WEBHOOK_SECRET });
    const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET } as unknown as Env;

    const root = startSpan("worker.fetch", { "http.route": "/api/webhooks/github" });
    const spans = (await runInSpan(root, async () => {
      const res = await handleGithubWebhook(request, env);
      expect(res.status).toBe(200);
      endSpan(root, "ok", { "http.status_code": res.status });
      return drainSpans();
    })) as Array<{ name: string; attributes: Record<string, unknown> }>;

    const workerFetch = spans.find((span) => span.name === "worker.fetch");
    expect(workerFetch, "worker.fetch span recorded").toBeTruthy();
    expect(workerFetch!.attributes["github.event"]).toBe("repository");
    expect(workerFetch!.attributes["github.action"]).toBe("edited");
  });

  it("tags github.event even when the body has no action", async () => {
    const body = JSON.stringify({ zen: "Keep it simple." });
    const request = await makeSignedGithubRequest(body, { eventType: "ping", secret: WEBHOOK_SECRET });
    const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET } as unknown as Env;

    const root = startSpan("worker.fetch", {});
    const spans = (await runInSpan(root, async () => {
      await handleGithubWebhook(request, env);
      endSpan(root, "ok", {});
      return drainSpans();
    })) as Array<{ name: string; attributes: Record<string, unknown> }>;

    const workerFetch = spans.find((span) => span.name === "worker.fetch");
    expect(workerFetch!.attributes["github.event"]).toBe("ping");
    expect(workerFetch!.attributes["github.action"]).toBeUndefined();
  });
});
