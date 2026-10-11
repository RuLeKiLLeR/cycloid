import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlanModeSetting } from "../../../../shared/plan-mode";

const clientMocks = vi.hoisted(() => ({
  requestJson: vi.fn(),
}));

vi.mock("./client", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    code?: string;
    data?: unknown;

    constructor(message: string, status: number, code?: string, data?: unknown) {
      super(message);
      this.status = status;
      this.code = code;
      this.data = data;
    }
  },
  captureApiError: vi.fn(),
  JSON_HEADERS: { "Content-Type": "application/json" },
  requestJson: clientMocks.requestJson,
  requestVoid: vi.fn(),
  trackApiAction: vi.fn(),
}));

import { ApiError } from "./client";
import { approveSessionPlan, createSessionAndSend, fetchSessionPlan, updateSessionPlan } from "./sessions";

const PROMPT = "Build the feature";
const REPO = { url: "https://github.com/trycycloid/cycloid" };

async function createWithPlanMode(planMode?: PlanModeSetting) {
  const result = await createSessionAndSend(
    PROMPT,
    REPO,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    planMode === undefined ? undefined : { planMode },
  );

  const [url, init] = clientMocks.requestJson.mock.calls[0] as [string, RequestInit];
  return { body: JSON.parse(String(init.body)) as Record<string, unknown>, result, url };
}

describe("createSessionAndSend plan mode", () => {
  beforeEach(() => {
    clientMocks.requestJson.mockReset();
    clientMocks.requestJson.mockResolvedValue({
      sessionId: "session-1",
      promptAlreadyEnqueued: true,
    });
  });

  it.each(["off", "auto", "on"] as const)("includes planMode %s in the create body", async (planMode) => {
    const { body, result, url } = await createWithPlanMode(planMode);

    expect(url).toBe("/api/sessions");
    expect(body).toEqual({
      prompt: PROMPT,
      planMode,
      context: { repoUrl: REPO.url },
    });
    expect(result).toEqual({ sessionId: "session-1", promptId: null, promptAlreadyEnqueued: true });
    expect(clientMocks.requestJson).toHaveBeenCalledOnce();
  });

  it("omits planMode from the create body when the capability is unavailable", async () => {
    const { body } = await createWithPlanMode();

    expect(body).toEqual({
      prompt: PROMPT,
      context: { repoUrl: REPO.url },
    });
    expect(body).not.toHaveProperty("planMode");
    expect(clientMocks.requestJson).toHaveBeenCalledOnce();
  });

  it("sends explicit update-pr continuation fields", async () => {
    await createSessionAndSend(
      "Finish the PR",
      REPO,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { takeoverPrUrl: "https://github.com/trycycloid/cycloid/pull/42" },
    );

    const [, init] = clientMocks.requestJson.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      continuePrUrl: "https://github.com/trycycloid/cycloid/pull/42",
      continueMode: "update-pr",
    });
  });
});

describe("session plan API", () => {
  beforeEach(() => {
    clientMocks.requestJson.mockReset();
  });

  it("fetches the latest plan without allowing an HTTP cache hit", async () => {
    const plan = {
      status: "pending",
      revision: 4,
      markdown: "# Plan",
      userEdited: false,
      updatedAt: "2026-07-09T12:00:00.000Z",
      planPromptId: "p-4",
    };
    clientMocks.requestJson.mockResolvedValueOnce(plan);

    await expect(fetchSessionPlan("session-1")).resolves.toBe(plan);
    expect(clientMocks.requestJson).toHaveBeenCalledWith(
      "/api/sessions/session-1/plan",
      { cache: "no-store" },
      "Failed to load the plan",
      { schema: expect.anything() },
    );
  });

  it("validates the plan payload with a schema that mirrors the wire shape", async () => {
    clientMocks.requestJson.mockResolvedValueOnce({});
    await fetchSessionPlan("session-1");
    const validate = clientMocks.requestJson.mock.calls[0]?.[3] as {
      schema: { safeParse: (v: unknown) => { success: boolean } };
    };

    // Current DO payload: six fields, no valid/missingReason.
    expect(
      validate.schema.safeParse({
        status: "pending",
        revision: 4,
        markdown: "# Plan",
        userEdited: false,
        updatedAt: "2026-07-09T12:00:00.000Z",
        planPromptId: "p-4",
      }).success,
    ).toBe(true);
    // Additive wire fields from newer deployments still parse.
    expect(
      validate.schema.safeParse({
        status: "pending",
        revision: 4,
        markdown: null,
        userEdited: true,
        updatedAt: "2026-07-09T12:00:00.000Z",
        planPromptId: "p-4",
        valid: true,
        missingReason: null,
      }).success,
    ).toBe(true);
    // A malformed payload (missing revision) fails closed.
    expect(validate.schema.safeParse({ status: "pending", markdown: "# Plan" }).success).toBe(false);
  });

  it("sends revision-bound approve and edit requests", async () => {
    clientMocks.requestJson
      .mockResolvedValueOnce({ ok: true, revision: 4, implementationPromptId: "p-5", idempotent: false })
      .mockResolvedValueOnce({ ok: true, planApprovalPending: true, revision: 5, status: "pending" });

    await approveSessionPlan("session-1", 4);
    await updateSessionPlan("session-1", 4, "# Plan\n\nEdited");

    expect(clientMocks.requestJson).toHaveBeenNthCalledWith(
      1,
      "/api/sessions/session-1/plan/approve",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: 4 }),
      },
      "Failed to accept the plan",
      { schema: expect.anything() },
    );
    expect(clientMocks.requestJson).toHaveBeenNthCalledWith(
      2,
      "/api/sessions/session-1/plan",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: 4, markdown: "# Plan\n\nEdited" }),
      },
      "Failed to save the plan",
      { schema: expect.anything() },
    );

    const approveValidate = clientMocks.requestJson.mock.calls[0]?.[3] as {
      schema: { safeParse: (v: unknown) => { success: boolean } };
    };
    const editValidate = clientMocks.requestJson.mock.calls[1]?.[3] as {
      schema: { safeParse: (v: unknown) => { success: boolean } };
    };
    expect(
      approveValidate.schema.safeParse({ ok: true, revision: 4, implementationPromptId: "p-5", idempotent: false })
        .success,
    ).toBe(true);
    expect(approveValidate.schema.safeParse({ ok: true, revision: 4 }).success).toBe(false);
    expect(
      editValidate.schema.safeParse({ ok: true, planApprovalPending: true, revision: 5, status: "pending" }).success,
    ).toBe(true);
    expect(
      editValidate.schema.safeParse({ ok: true, planApprovalPending: false, revision: 5, status: "pending" }).success,
    ).toBe(false);
  });

  it("types stale and wrong-state 409 responses", async () => {
    clientMocks.requestJson
      .mockRejectedValueOnce(new ApiError("stale_revision", 409, undefined, { error: "stale_revision" }))
      .mockRejectedValueOnce(new ApiError("Plan is not pending approval", 409));

    await expect(approveSessionPlan("session-1", 4)).rejects.toMatchObject({
      kind: "stale",
    });
    await expect(updateSessionPlan("session-1", 4, "# Plan")).rejects.toMatchObject({
      kind: "state",
    });
  });
});
