import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

import { ARCANIST_BUSINESS_ID } from "../../apps/control-plane-worker/src/constants/auth";

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

import { createWorkerEnv, sessionTokenHeaders, workerFetch, type WorkerModule } from "./helpers";

describe("smoke: session debug summary endpoint", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    const workerModulePath = "../../apps/control-plane-worker/src/index.js";
    workerModule = (await import(workerModulePath)) as WorkerModule;
  });

  it("returns expanded redacted debug-summary payload through the worker route", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    const userId = db.addBusinessUser(42162445, "internal-user", ARCANIST_BUSINESS_ID, null);
    db.setBusinessMembership(userId, ARCANIST_BUSINESS_ID, "admin");
    db.setAuthToken("debug-summary-session-token", {
      user_id: userId,
      id: userId,
      login: "internal-user",
      name: null,
      email: null,
      business_id: ARCANIST_BUSINESS_ID,
      expires_at: Date.now() + 60_000,
    });

    const sessionId = "s-debug-summary-runtime";
    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: sessionTokenHeaders("debug-summary-session-token"),
      body: JSON.stringify({ sessionId, repoUrl: "https://github.com/acme/widgets" }),
    });
    expect(createRes.status).toBe(201);

    const sessionNs = env.SESSION as {
      _getState(id: string): {
        storage: {
          sql: { exec(query: string, ...params: unknown[]): unknown };
          put: (key: string, value: unknown) => Promise<void>;
        };
      };
    };
    const state = sessionNs._getState(sessionId);
    if (!state) throw new Error("Session DO state was not initialized");

    const now = Date.now();
    state.storage.sql.exec(
      "UPDATE session SET publish_status = ?, publish_stage = ?, publish_error = ?, pr_url = ?, pr_draft = ?, pr_manual_review_reason = ?, spawn_duration_ms = ? WHERE session_id = ?",
      "failed",
      "verifying",
      "GitHub token leaked at /workspace/repo/.git/config",
      null,
      0,
      "needs review",
      1234,
      sessionId,
    );
    state.storage.sql.exec("UPDATE sandbox_state SET status = ? WHERE session_id = ?", "ready", sessionId);
    state.storage.sql.exec(
      "INSERT INTO prompts (prompt_id, session_id, prompt_text, actor_user_id, status, created_at, started_at, completed_at, updated_at, error, queue_position, has_pending_question) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      "p-debug-1",
      sessionId,
      "Trigger a pre-bridge failure",
      String(userId),
      "failed",
      now,
      null,
      now + 1000,
      now + 1000,
      "spawn failed",
      0,
      0,
    );
    state.storage.sql.exec(
      "INSERT INTO events (event_id, session_id, prompt_id, type, created_at, data_json, delivery_class) VALUES (?, ?, ?, ?, ?, ?, ?)",
      "evt-debug-1",
      sessionId,
      "p-debug-1",
      "prompt_enqueued",
      now,
      JSON.stringify({ promptId: "p-debug-1" }),
      "canonical",
    );
    await state.storage.put("verification", {
      verified: false,
      verdict: "INCONCLUSIVE",
      status: "manual_review_required",
      publishMode: "draft",
      explanation: "Runtime endpoint smoke observed the debug fields.",
      manualReviewReason: "manual check requested",
      caveats: ["No browser evidence needed for backend endpoint smoke."],
    });
    await state.storage.put("runtime_provenance", {
      runtime: {
        provider: "e2b",
        sandboxId: "sandbox-debug",
        templateId: "template-debug",
        reportedAt: now,
      },
      bootMode: "fresh_clone",
      sandboxImageVersion: "image-debug",
      updatedAt: now,
    });

    db.promptRuns.set("run-debug-1", {
      id: "run-debug-1",
      session_id: sessionId,
      prompt_id: "p-debug-1",
      owner_user_id: String(userId),
      business_id: ARCANIST_BUSINESS_ID,
      repo: "acme/widgets",
      model: "gpt-5.4",
      agent: "default",
      source: "runtime-smoke",
      outcome: "failed",
      error_code: "spawn_deadline_no_bridge",
      error_details_json: JSON.stringify({
        message: "Bridge failed before startup",
        stack: "Error: boom\n    at /workspace/repo/apps/control-plane-worker/src/session.ts:12:3",
        raw: "Authorization: Bearer secret-token",
      }),
      dd_trace_id: null,
      bt_span_id: null,
      created_at: now,
      completed_at: now + 1000,
    });

    const response = await workerFetch(workerModule, env, `/api/sessions/${sessionId}/debug-summary`, {
      headers: sessionTokenHeaders("debug-summary-session-token"),
    });
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload.session.publish).toEqual({
      status: "failed",
      stage: "verifying",
      error: "[redacted]",
    });
    expect(payload.session.pullRequest).toEqual({
      url: null,
      state: null,
      manualReviewReason: "needs review",
    });
    expect(payload.session.verification.verdict).toBe("INCONCLUSIVE");
    expect(payload.session.taskOutcome).toEqual({ outcome: null, badSessionReason: null });
    expect(payload.prompts[0].traces.btSpanMissingReason).toBe("pre_bridge_failure");
    expect(payload.prompts[0].errorDetails).toEqual({ message: "Bridge failed before startup", redacted: true });
    const serialized = JSON.stringify(payload, null, 2);
    expect(serialized).not.toContain("/workspace/repo");
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("GitHub token");

    if (process.env.ARCANIST_EVIDENCE_DIR) {
      await mkdir(process.env.ARCANIST_EVIDENCE_DIR, { recursive: true });
      await writeFile(join(process.env.ARCANIST_EVIDENCE_DIR, "debug-summary-response.json"), `${serialized}\n`);
    }
  });
});
