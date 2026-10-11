import { beforeEach, describe, expect, it, vi } from "vitest";

import { translateBridgeEventToCycloidEvent } from "../../apps/sandbox-bridge/src/events/translate";

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

type TransportDurableEntry = {
  type: string;
  data: Record<string, unknown>;
  transportEvent: { payload: Record<string, unknown> };
};
type EventsModule = {
  projectCycloidEventToDurableEntry: (event: unknown) => TransportDurableEntry | null;
  redactCycloidEventSecrets: <T>(event: T) => T;
  translateCycloidEventToSandboxEvent: (event: unknown) => Record<string, unknown>;
};

let projectCycloidEventToDurableEntry: EventsModule["projectCycloidEventToDurableEntry"];
let redactCycloidEventSecrets: EventsModule["redactCycloidEventSecrets"];
let translateCycloidEventToSandboxEvent: EventsModule["translateCycloidEventToSandboxEvent"];

const GH_TOKEN = "ghs_abcdefghijklmnopqrstuvwxyz0123456789";
const ANT_KEY = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA";

function cycloidEvent(bridgeEvent: Record<string, unknown>) {
  const enriched = {
    messageId: "prompt-1",
    sandboxId: "sbx-1",
    timestamp: Date.parse("2026-01-01T00:00:00Z"),
    ...bridgeEvent,
  };
  return translateBridgeEventToCycloidEvent("session-1", enriched as never);
}

function project(bridgeEvent: Record<string, unknown>): TransportDurableEntry | null {
  return projectCycloidEventToDurableEntry(cycloidEvent(bridgeEvent));
}

beforeEach(async () => {
  vi.resetModules();
  const mod =
    (await import("../../apps/control-plane-worker/src/session/cycloid-event-store.js")) as unknown as EventsModule;
  projectCycloidEventToDurableEntry = mod.projectCycloidEventToDurableEntry;
  redactCycloidEventSecrets = mod.redactCycloidEventSecrets;
  translateCycloidEventToSandboxEvent = mod.translateCycloidEventToSandboxEvent;
});

describe("event secret redaction at the projection chokepoint", () => {
  it("redacts a GitHub token in tool_call args from BOTH data.input and the persisted transportEvent", () => {
    const entry = project({
      type: "tool_call",
      tool: "shell",
      args: { command: `curl -H 'Authorization: token ${GH_TOKEN}' https://api.github.com` },
      callId: "tc1",
    });

    expect(entry).not.toBeNull();
    const input = entry!.data.input as { command: string };
    expect(input.command).not.toContain(GH_TOKEN);
    expect(input.command).toContain("[REDACTED]");

    // The full raw event persisted/replayed via transportEvent must also be scrubbed.
    const serialized = JSON.stringify(entry!.transportEvent);
    expect(serialized).not.toContain(GH_TOKEN);
    expect(serialized).toContain("[REDACTED]");
  });

  it("preserves non-secret args while removing only the secret substring", () => {
    const entry = project({
      type: "tool_call",
      tool: "write",
      args: { filePath: "/src/config.ts", contents: `export const KEY = "${ANT_KEY}";` },
      callId: "tc2",
    });

    const input = entry!.data.input as { filePath: string; contents: string };
    expect(input.filePath).toBe("/src/config.ts");
    expect(input.contents).not.toContain(ANT_KEY);
    expect(input.contents).toContain('export const KEY = "[REDACTED]";');
  });

  it("redactCycloidEventSecrets returns the same reference for a secret-free event", () => {
    const clean = { phase: "text.delta", sessionId: "s", timestampMs: 1, payload: { partId: "p1", text: "hello" } };
    expect(redactCycloidEventSecrets(clean)).toBe(clean);
  });

  it("redacts live WS broadcast projection when ingestion redaction is applied", () => {
    const event = cycloidEvent({
      type: "tool_call",
      tool: "shell",
      args: { command: `curl -H 'Authorization: token ${GH_TOKEN}' https://api.github.com` },
      callId: "tc3",
    });

    const broadcast = translateCycloidEventToSandboxEvent(redactCycloidEventSecrets(event));

    const serialized = JSON.stringify(broadcast);
    expect(serialized).not.toContain(GH_TOKEN);
    expect(serialized).toContain("[REDACTED]");
  });
});
