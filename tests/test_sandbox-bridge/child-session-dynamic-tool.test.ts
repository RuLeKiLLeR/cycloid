import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDdLog = vi.hoisted(() => vi.fn());

vi.mock("../../apps/sandbox-bridge/src/services/dd-logs", () => ({
  ddLog: mockDdLog,
}));

import {
  buildSpawnChildSessionDynamicToolSpec,
  buildSpawnChildSessionIdempotencyKey,
  SPAWN_CHILD_SESSION_DYNAMIC_TOOL_NAME,
} from "../../apps/sandbox-bridge/src/services/child-session-dynamic-tool";
import { validateFirstPartyDynamicToolInput } from "../../apps/sandbox-bridge/src/services/dynamic-tool-input-schemas";
import {
  buildAllDynamicToolSpecs,
  executeFirstPartyDynamicToolCall,
} from "../../apps/sandbox-bridge/src/services/first-party-dynamic-tools";
import {
  MAX_CHILD_SESSION_SPAWN_DEPTH,
  MAX_CHILD_SESSIONS_PER_PROMPT,
  SPAWN_CHILD_SESSION_MAX_PROMPT_LENGTH,
  SPAWN_CHILD_SESSION_MAX_TITLE_LENGTH,
  SPAWN_CHILD_SESSION_REPOSITORY_ID_PATTERN_SOURCE,
} from "../../shared/constants/session";

const ENV = {
  CONTROL_PLANE_URL: "https://api.test",
  SESSION_ID: "parent-session-1",
  SANDBOX_AUTH_TOKEN: "sandbox-auth",
} as const;

function call(args: unknown, extra: Record<string, unknown> = {}) {
  return executeFirstPartyDynamicToolCall("cycloid", SPAWN_CHILD_SESSION_DYNAMIC_TOOL_NAME, args, {
    env: { ...ENV },
    ...extra,
  });
}

describe("cycloid.spawn_child_session dynamic tool", () => {
  beforeEach(() => {
    mockDdLog.mockClear();
  });

  it("exports the expected tool name", () => {
    expect(SPAWN_CHILD_SESSION_DYNAMIC_TOOL_NAME).toBe("spawn_child_session");
  });

  it("publishes input limits from the shared child-session constants", () => {
    const spec = buildSpawnChildSessionDynamicToolSpec({})[0];
    const properties = spec?.inputSchema.properties as Record<string, Record<string, unknown>>;

    expect(properties.prompt?.maxLength).toBe(SPAWN_CHILD_SESSION_MAX_PROMPT_LENGTH);
    expect(properties.title?.maxLength).toBe(SPAWN_CHILD_SESSION_MAX_TITLE_LENGTH);
    expect(properties.repositoryId?.pattern).toBe(SPAWN_CHILD_SESSION_REPOSITORY_ID_PATTERN_SOURCE);
    expect(spec?.description).toContain(`at most ${MAX_CHILD_SESSIONS_PER_PROMPT} children`);
    expect(spec?.description).toContain(`max child depth ${MAX_CHILD_SESSION_SPAWN_DEPTH}`);
    expect(spec?.description).toContain("Identical-content spawns");
  });

  it("validates inputs with the same shared limits used by the published spec", () => {
    const invalidPrompt = validateFirstPartyDynamicToolInput("cycloid", SPAWN_CHILD_SESSION_DYNAMIC_TOOL_NAME, {
      prompt: "x".repeat(SPAWN_CHILD_SESSION_MAX_PROMPT_LENGTH + 1),
      repositoryId: "trycycloid/cycloid",
    });
    expect(invalidPrompt.ok).toBe(false);

    const invalidTitle = validateFirstPartyDynamicToolInput("cycloid", SPAWN_CHILD_SESSION_DYNAMIC_TOOL_NAME, {
      prompt: "go",
      repositoryId: "trycycloid/cycloid",
      title: "x".repeat(SPAWN_CHILD_SESSION_MAX_TITLE_LENGTH + 1),
    });
    expect(invalidTitle.ok).toBe(false);

    const invalidRepo = validateFirstPartyDynamicToolInput("cycloid", SPAWN_CHILD_SESSION_DYNAMIC_TOOL_NAME, {
      prompt: "go",
      repositoryId: "trycycloid//cycloid",
    });
    expect(invalidRepo.ok).toBe(false);
  });

  it("rejects missing prompt before any fetch", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(call({ repositoryId: "trycycloid/cycloid" }, { fetchImpl })).resolves.toMatchObject({
      success: false,
      errorCode: "invalid_input",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects missing repositoryId before any fetch", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(call({ prompt: "go" }, { fetchImpl })).resolves.toMatchObject({
      success: false,
      errorCode: "invalid_input",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects malformed repositoryId before any fetch", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(call({ prompt: "go", repositoryId: "not-a-repo" }, { fetchImpl })).resolves.toMatchObject({
      success: false,
      errorCode: "invalid_input",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails not_connected when env is incomplete", async () => {
    await expect(
      executeFirstPartyDynamicToolCall(
        "cycloid",
        SPAWN_CHILD_SESSION_DYNAMIC_TOOL_NAME,
        { prompt: "go", repositoryId: "trycycloid/cycloid" },
        { env: { CONTROL_PLANE_URL: "https://api.test" } },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "not_connected" });
  });

  it("is not published or executable for verification sessions", async () => {
    expect(
      buildAllDynamicToolSpecs({ ...ENV, ARCANIST_AGENT_ROLE: "verification" }).map(
        (tool) => `${tool.namespace}.${tool.name}`,
      ),
    ).not.toContain("cycloid.spawn_child_session");

    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      call(
        { prompt: "go", repositoryId: "trycycloid/cycloid" },
        {
          env: { ...ENV, ARCANIST_AGENT_ROLE: "verification" },
          fetchImpl,
        },
      ),
    ).resolves.toMatchObject({
      success: false,
      errorCode: "blocked",
      contentItems: [
        {
          type: "inputText",
          text: "Policy block: verification sessions cannot use side-effecting first-party dynamic tool 'cycloid.spawn_child_session'.",
        },
      ],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("POSTs the child-session with the sandbox token and returns the id", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      expect(String(input)).toBe("https://api.test/api/sessions/parent-session-1/sandbox/child-sessions");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer sandbox-auth");
      expect((init?.headers as Record<string, string>)["Idempotency-Key"]).toBe(
        buildSpawnChildSessionIdempotencyKey({
          prompt: "find one useEffect lifecycle bug",
          repositoryId: "trycycloid/cycloid",
          title: "useEffect slice A",
          reasoningEffort: "low",
        }),
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        prompt: "find one useEffect lifecycle bug",
        repositoryId: "trycycloid/cycloid",
        title: "useEffect slice A",
        reasoningEffort: "low",
      });
      return new Response(
        JSON.stringify({
          ok: true,
          childSessionId: "child-123",
          childSessionUrl: "https://app.trycycloid.com/sessions/child-123",
          parentSessionId: "parent-session-1",
          parentPromptId: "p-1",
          spawnDepth: 1,
        }),
        { status: 201 },
      );
    }) as typeof fetch;

    const result = await call(
      {
        prompt: "find one useEffect lifecycle bug",
        repositoryId: "trycycloid/cycloid",
        title: "useEffect slice A",
        reasoningEffort: "low",
      },
      { fetchImpl },
    );

    expect(result).toMatchObject({ success: true });
    expect(mockDdLog).toHaveBeenLastCalledWith(
      expect.objectContaining({ event: "spawn_child_session.create", outcome: "success", surface: "bridge" }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.test/api/sessions/parent-session-1/sandbox/child-sessions");
    const text = (result as { contentItems: Array<{ text: string }> }).contentItems[0]?.text ?? "";
    expect(JSON.parse(text)).toEqual({
      ok: true,
      childSessionId: "child-123",
      childSessionUrl: "https://app.trycycloid.com/sessions/child-123",
      parentSessionId: "parent-session-1",
      parentPromptId: "p-1",
      spawnDepth: 1,
    });
  });

  it("generates the same Idempotency-Key for a retry with identical arguments", async () => {
    const postKeys: string[] = [];
    let postAttempts = 0;
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith("/cli-auth-token")) {
        return new Response(JSON.stringify({ ok: true, token: "t" }), { status: 200 });
      }
      postAttempts += 1;
      postKeys.push((init?.headers as Record<string, string>)["Idempotency-Key"] ?? "");
      if (postAttempts === 1) throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      return new Response(
        JSON.stringify({
          ok: true,
          childSessionId: "child-replayed",
          childSessionUrl: "https://app.trycycloid.com/sessions/child-replayed",
          parentSessionId: "parent-session-1",
          parentPromptId: "p-1",
          spawnDepth: 1,
        }),
        { status: 201 },
      );
    }) as typeof fetch;
    const args = { prompt: "go", repositoryId: "a/b", model: "gpt-5.1-codex" };

    await expect(call(args, { fetchImpl })).resolves.toMatchObject({ success: false, errorCode: "timed_out" });
    await expect(call(args, { fetchImpl })).resolves.toMatchObject({ success: true });

    expect(mockDdLog).toHaveBeenCalledWith(expect.objectContaining({ outcome: "timed_out", errorCode: "timed_out" }));
    expect(mockDdLog).toHaveBeenCalledWith(expect.objectContaining({ outcome: "success" }));
    expect(postKeys).toHaveLength(2);
    expect(postKeys[0]).toBe(postKeys[1]);
    expect(postKeys[0]).toHaveLength(64);
  });

  it("maps API error codes (unauthorized_repo -> forbidden) and surfaces the message", async () => {
    const fetchImpl = vi.fn(async (input: unknown) => {
      if (String(input).endsWith("/cli-auth-token")) {
        return new Response(JSON.stringify({ ok: true, token: "t" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          ok: false,
          error: { code: "unauthorized_repo", message: "Parent user has no access to that repo." },
        }),
        { status: 403 },
      );
    }) as typeof fetch;

    await expect(call({ prompt: "go", repositoryId: "other/private" }, { fetchImpl })).resolves.toMatchObject({
      success: false,
      errorCode: "forbidden",
      contentItems: [
        {
          type: "inputText",
          text:
            "Parent user has no access to that repo.\n\n" +
            "Recovery: Verify the identifier and arguments before retrying; do not repeat the identical call.",
        },
      ],
    });
    expect(mockDdLog).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "forbidden", errorCode: "forbidden", apiCode: "unauthorized_repo" }),
    );
  });

  it("maps depth/limit codes to limit_exceeded", async () => {
    const fetchImpl = vi.fn(async (input: unknown) => {
      if (String(input).endsWith("/cli-auth-token")) {
        return new Response(JSON.stringify({ ok: true, token: "t" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          ok: false,
          error: { code: "max_children_per_prompt", message: "Hit per-prompt cap." },
        }),
        { status: 409 },
      );
    }) as typeof fetch;

    await expect(call({ prompt: "go", repositoryId: "a/b" }, { fetchImpl })).resolves.toMatchObject({
      success: false,
      errorCode: "limit_exceeded",
    });
  });

  it("surfaces sandbox authorization failure without attempting a second call", async () => {
    const fetchImpl = vi.fn(async (input: unknown) => {
      if (String(input).endsWith("/sandbox/child-sessions")) {
        return new Response("nope", { status: 401 });
      }
      throw new Error("should not be reached");
    }) as typeof fetch;

    await expect(call({ prompt: "go", repositoryId: "a/b" }, { fetchImpl })).resolves.toMatchObject({
      success: false,
      errorCode: "forbidden",
    });
  });

  it("returns timed_out when AbortSignal.timeout fires a TimeoutError", async () => {
    const fetchImpl = vi.fn(async (input: unknown) => {
      if (String(input).endsWith("/cli-auth-token")) {
        return new Response(JSON.stringify({ ok: true, token: "t" }), { status: 200 });
      }
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    }) as typeof fetch;

    await expect(call({ prompt: "go", repositoryId: "a/b" }, { fetchImpl })).resolves.toMatchObject({
      success: false,
      errorCode: "timed_out",
    });
  });

  it("returns cancelled on abort during the child-session POST", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (input: unknown) => {
      if (String(input).endsWith("/cli-auth-token")) {
        return new Response(JSON.stringify({ ok: true, token: "t" }), { status: 200 });
      }
      controller.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }) as typeof fetch;

    await expect(
      call({ prompt: "go", repositoryId: "a/b" }, { signal: controller.signal, fetchImpl }),
    ).resolves.toMatchObject({ success: false, errorCode: "cancelled" });
  });
});
