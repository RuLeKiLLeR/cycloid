// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { describe, expect, it } from "vitest";

import { CodexBridgeClient } from "../../apps/sandbox-bridge/src/services/codex-server.js";

const EXECUTE_SANDBOX_POLICY = { type: "dangerFullAccess" } as const;
const PLAN_SANDBOX_POLICY = { type: "readOnly", networkAccess: false } as const;

type RecordedRequest = { method: string; params: Record<string, unknown> };

function makeClient() {
  const requests: RecordedRequest[] = [];
  const transport = {
    onNotification: null,
    onClosed: null,
    onServerRequest: null,
    close() {},
    async request(method: string, params: Record<string, unknown>) {
      requests.push({ method, params });
      if (method === "thread/start") return { thread: { id: "thread-1" } };
      if (method === "turn/start") return { turn: { id: "turn-1" } };
      // thread/read, thread/resume, turn/interrupt, etc.
      return {};
    },
  };
  const client = new CodexBridgeClient({ transport, cwd: "/workspace/repo", model: "gpt-5.5" });
  return { client, requests };
}

const requestFor = (requests: RecordedRequest[], method: string) => requests.filter((r) => r.method === method);

describe("CodexBridgeClient sandbox mode", () => {
  it("creates a fresh thread with danger-full-access sandbox", async () => {
    const { client, requests } = makeClient();
    await client.session.create();

    const starts = requestFor(requests, "thread/start");
    expect(starts).toHaveLength(1);
    expect(starts[0].params.sandbox).toBe("danger-full-access");
  });

  it("resumes a thread with danger-full-access sandbox (regression)", async () => {
    const { client, requests } = makeClient();

    // Simulate restoring a prior Codex thread from a respawned sandbox: `session.get`
    // adopts an existing thread id without going through `thread/start`, leaving the
    // session record `loaded: false` so the next prompt triggers `thread/resume`.
    const restored = await client.session.get({ path: { id: "prior-thread" } });
    expect(restored.data?.id).toBe("prior-thread");

    await client.session.promptAsync({
      path: { id: "prior-thread" },
      body: {
        sandboxPolicy: EXECUTE_SANDBOX_POLICY,
        parts: [{ type: "text", text: "append a line to README.md and commit" }],
      },
    });

    // The resume path must have run with the sandbox mode, and must not re-create the thread.
    expect(requestFor(requests, "thread/start")).toHaveLength(0);
    const resumes = requestFor(requests, "thread/resume");
    expect(resumes).toHaveLength(1);
    expect(resumes[0].params.sandbox).toBe("danger-full-access");
  });

  it("starts execute turns with danger-full-access sandboxPolicy", async () => {
    const { client, requests } = makeClient();
    const session = await client.session.create();

    await client.session.promptAsync({
      path: { id: session.data.id },
      body: { sandboxPolicy: EXECUTE_SANDBOX_POLICY, parts: [{ type: "text", text: "edit README.md" }] },
    });

    const starts = requestFor(requests, "turn/start");
    expect(starts).toHaveLength(1);
    expect(starts[0].params.sandboxPolicy).toEqual(EXECUTE_SANDBOX_POLICY);
  });

  it("starts plan turns with read-only sandboxPolicy and no network", async () => {
    const { client, requests } = makeClient();
    const session = await client.session.create();

    await client.session.promptAsync({
      path: { id: session.data.id },
      body: { sandboxPolicy: PLAN_SANDBOX_POLICY, parts: [{ type: "text", text: "inspect the repo" }] },
    });

    const starts = requestFor(requests, "turn/start");
    expect(starts).toHaveLength(1);
    expect(starts[0].params.sandboxPolicy).toEqual(PLAN_SANDBOX_POLICY);
  });

  it("resets a resumed execute turn to danger-full-access after a prior plan turn", async () => {
    const { client, requests } = makeClient();

    await client.session.get({ path: { id: "prior-thread" } });
    await client.session.promptAsync({
      path: { id: "prior-thread" },
      body: { sandboxPolicy: EXECUTE_SANDBOX_POLICY, parts: [{ type: "text", text: "edit README.md" }] },
    });

    const starts = requestFor(requests, "turn/start");
    expect(starts).toHaveLength(1);
    expect(starts[0].params.sandboxPolicy).toEqual(EXECUTE_SANDBOX_POLICY);
  });

  it("fails closed when a turn omits sandboxPolicy", async () => {
    const { client, requests } = makeClient();
    const session = await client.session.create();

    await expect(
      client.session.promptAsync({
        path: { id: session.data.id },
        body: { parts: [{ type: "text", text: "edit README.md" }] } as never,
      }),
    ).rejects.toThrow("Codex turn sandboxPolicy is required for every prompt");

    expect(requestFor(requests, "turn/start")).toHaveLength(0);
  });
});
