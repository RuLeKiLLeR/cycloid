import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSession,
  createSessionDesktopViewTicket,
  fetchSessionDesktopActionPath,
  fetchSessionDesktopViewTicketStatus,
  fetchSessionView,
  heartbeatSessionDesktopViewTicket,
  revokeSessionDesktopViewTicket,
} from "../../apps/ui/src/api/sessions";

describe("session API", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    ["desktop action path", () => fetchSessionDesktopActionPath("s-1")],
    ["desktop view ticket creation", () => createSessionDesktopViewTicket("s-1")],
    ["desktop view ticket heartbeat", () => heartbeatSessionDesktopViewTicket("/heartbeat")],
    ["desktop view ticket revoke", () => revokeSessionDesktopViewTicket("/revoke")],
    ["desktop view ticket status", () => fetchSessionDesktopViewTicketStatus("/status")],
  ])("rejects malformed %s responses", async (_name, request) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(request()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("sends the model without backend on create; the server derives the agent runtime backend", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: "s-claude" }), { status: 200 }));

    const sessionId = await createSession(
      { providerID: "anthropic", modelID: "claude-opus-4-8" },
      { repoUrl: "https://github.com/trycycloid/cycloid" },
    );

    expect(sessionId).toBe("s-claude");
    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    expect(body.model).toBe("claude-opus-4-8");
    expect(body.agentRuntimeBackend).toBeUndefined();
  });

  it("maps the live-idle userStopped flag from the session view response", async () => {
    // The DO-served view carries the in-memory flag; toSessionViewResult must
    // thread it so the resilience poll / cold bootstrap keep the Stopped badge.
    const makeViewResponse = (userStopped: boolean | undefined) =>
      new Response(
        JSON.stringify({
          session: {
            sessionId: "s-1",
            phase: "idle",
            displayStatus: "stopped",
            title: "Stopped session",
            createdAt: 0,
            model: null,
            prUrl: null,
            prDraft: false,
            publishStatus: "not_started",
            queueLength: 0,
            repoUrl: "https://github.com/trycycloid/cycloid",
            lastBranch: null,
            baseBranch: "main",
            ...(userStopped !== undefined ? { userStopped } : {}),
          },
          prompts: { items: [], nextCursor: null, total: 0 },
          actions: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeViewResponse(true))
      .mockResolvedValueOnce(makeViewResponse(false))
      .mockResolvedValueOnce(makeViewResponse(undefined));

    expect((await fetchSessionView("s-1")).session.userStopped).toBe(true);
    expect((await fetchSessionView("s-1")).session.userStopped).toBe(false);
    expect((await fetchSessionView("s-1")).session.userStopped).toBeUndefined();
  });

  it("maps plan-approval metadata so resilience polling cannot close an active editor", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          session: {
            sessionId: "s-plan",
            phase: "waiting_for_input",
            displayStatus: "waiting_for_input",
            planApprovalPending: true,
            planRevision: 3,
            planStatus: "pending",
            title: "Pending plan",
            createdAt: 0,
            model: null,
            prUrl: null,
            prDraft: false,
            publishStatus: "not_started",
            queueLength: 0,
            repoUrl: "https://github.com/trycycloid/cycloid",
            lastBranch: null,
            baseBranch: "main",
          },
          prompts: { items: [], nextCursor: null, total: 0 },
          actions: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const { session } = await fetchSessionView("s-plan");

    expect(session.planApprovalPending).toBe(true);
    expect(session.planRevision).toBe(3);
    expect(session.planStatus).toBe("pending");
  });

  it("maps desktop action path availability from the session view response", async () => {
    const makeViewResponse = (desktopActionPathAvailable: boolean | undefined) =>
      new Response(
        JSON.stringify({
          session: {
            sessionId: "s-1",
            phase: "idle",
            displayStatus: "stopped",
            title: "Desktop session",
            createdAt: 0,
            model: null,
            prUrl: null,
            prDraft: false,
            publishStatus: "not_started",
            queueLength: 0,
            repoUrl: "https://github.com/trycycloid/cycloid",
            lastBranch: null,
            baseBranch: "main",
            ...(desktopActionPathAvailable !== undefined ? { desktopActionPathAvailable } : {}),
          },
          prompts: { items: [], nextCursor: null, total: 0 },
          actions: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeViewResponse(true))
      .mockResolvedValueOnce(makeViewResponse(false))
      .mockResolvedValueOnce(makeViewResponse(undefined));

    expect((await fetchSessionView("s-1")).session.desktopActionPathAvailable).toBe(true);
    expect((await fetchSessionView("s-1")).session.desktopActionPathAvailable).toBe(false);
    expect((await fetchSessionView("s-1")).session.desktopActionPathAvailable).toBe(false);
  });

  it("preserves uploaded attachment summaries from session view prompts", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          session: {
            sessionId: "s-1",
            phase: "completed",
            title: "Uploaded image",
            createdAt: 0,
            model: null,
            prUrl: null,
            prDraft: false,
            publishStatus: "not_started",
            queueLength: 0,
            repoUrl: "https://github.com/trycycloid/cycloid",
            startBranch: "wip/resume-me",
            lastBranch: null,
            baseBranch: "main",
          },
          prompts: {
            items: [
              {
                promptId: "p-1",
                prompt: "look at this",
                status: "completed",
                result: null,
                uploadedFiles: [{ name: "notes.txt" }],
                uploadedImages: [{ name: "image.png", mediaType: "image/png", data: "aW1hZ2U=" }],
              },
            ],
            nextCursor: null,
            total: 1,
          },
          actions: {
            canSendPrompt: true,
            canStop: false,
            canResume: false,
            canRespond: false,
            canWarm: false,
            canRetry: false,
            canArchive: true,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await fetchSessionView("s-1");

    expect(result.session.startBranch).toBe("wip/resume-me");
    expect(result.prompts[0]).toMatchObject({
      uploadedFiles: [{ name: "notes.txt" }],
      uploadedImages: [{ name: "image.png", mediaType: "image/png", data: "aW1hZ2U=" }],
    });
    expect(result.promptPage).toEqual({ nextCursor: null, total: 1 });
  });

  it("maps live sandbox state, reasoning effort, and QA verification fields from the session view", async () => {
    const baseSession = {
      sessionId: "s-1",
      phase: "running",
      title: "Live sandbox",
      createdAt: 0,
      model: null,
      prUrl: null,
      prDraft: false,
      publishStatus: "not_started",
      queueLength: 0,
      repoUrl: "https://github.com/trycycloid/cycloid",
      lastBranch: null,
      baseBranch: "main",
    };
    const emptyPrompts = { items: [], nextCursor: null, total: 0 };

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          session: {
            ...baseSession,
            reasoningEffort: "high",
            sandboxId: "sbx_live_1",
            sandboxConnected: true,
            verificationState: "verification-done",
            verificationResult: "needs-work",
          },
          prompts: emptyPrompts,
          actions: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await fetchSessionView("s-1");
    expect(result.session.reasoningEffort).toBe("high");
    expect(result.session.sandboxId).toBe("sbx_live_1");
    expect(result.session.sandboxConnected).toBe(true);
    expect(result.session.verificationState).toBe("verification-done");
    expect(result.session.verificationResult).toBe("needs-work");

    // Absent on the payload (older server) -> null, matching the WS mapper's fallback.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ session: baseSession, prompts: emptyPrompts, actions: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const bare = await fetchSessionView("s-1");
    expect(bare.session.reasoningEffort).toBeNull();
    expect(bare.session.sandboxId).toBeNull();
    expect(bare.session.sandboxConnected).toBeNull();
    expect(bare.session.verificationState).toBeNull();
    expect(bare.session.verificationResult).toBeNull();
  });

  it("carries canonical verification fields from session view", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          session: {
            sessionId: "s-verify",
            phase: "review_listening",
            displayStatus: "completed",
            title: "Verified PR",
            createdAt: 0,
            model: null,
            prUrl: "https://github.com/trycycloid/cycloid/pull/1",
            prDraft: false,
            publishStatus: "published",
            queueLength: 0,
            repoUrl: "https://github.com/trycycloid/cycloid",
            startBranch: null,
            lastBranch: null,
            baseBranch: "main",
            verificationState: "verification-done",
            verificationResult: "merge-ready",
            verificationNeedsWorkLabel: null,
            verificationAttemptCount: 2,
            verificationMaxAttempts: 3,
          },
          prompts: { items: [], nextCursor: null, total: 0 },
          actions: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await fetchSessionView("s-verify");

    expect(result.session).toMatchObject({
      verificationState: "verification-done",
      verificationResult: "merge-ready",
      verificationNeedsWorkLabel: null,
      verificationAttemptCount: 2,
      verificationMaxAttempts: 3,
    });
  });

  it("returns the first prompt page without draining additional pages", async () => {
    const session = {
      sessionId: "s-1",
      phase: "completed",
      title: "Long session",
      createdAt: 0,
      model: null,
      prUrl: null,
      prDraft: false,
      publishStatus: "not_started",
      queueLength: 0,
      repoUrl: "https://github.com/trycycloid/cycloid",
      lastBranch: null,
      baseBranch: "main",
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          session,
          prompts: {
            items: [{ promptId: "p-1", prompt: "first", status: "completed", result: null }],
            nextCursor: "100",
            total: 2,
          },
          actions: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await fetchSessionView("s-1");

    expect(result.prompts.map((prompt) => prompt.promptId)).toEqual(["p-1"]);
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      "/api/sessions/s-1/view?promptLimit=100",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("times out hanging session view requests", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementationOnce((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    });

    const result = expect(fetchSessionView("s-1")).rejects.toThrow("Session details request timed out");

    await vi.advanceTimersByTimeAsync(15_000);

    await result;
  });
});
