import { describe, expect, it, vi } from "vitest";

import { notifyAgentCreatedTicketKey } from "../../apps/sandbox-bridge/src/services/agent-ticket-key-notify.js";

const ENV = {
  CONTROL_PLANE_URL: "https://cp.example.com",
  SESSION_ID: "sess-1",
  SANDBOX_AUTH_TOKEN: "tok-1",
};

function res(status: number): Response {
  return new Response(status === 204 ? null : "{}", { status });
}

describe("notifyAgentCreatedTicketKey", () => {
  it("POSTs the ticket key to the control plane and stops on success", async () => {
    const fetchImpl = vi.fn(async () => res(200)) as unknown as typeof fetch;
    await notifyAgentCreatedTicketKey("ENG-5790", "jira", { env: ENV, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://cp.example.com/api/sessions/sess-1/ticket-key");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-1");
    expect(JSON.parse(init.body as string)).toEqual({ ticketKey: "ENG-5790" });
  });

  it("does nothing when control-plane env is not configured", async () => {
    const fetchImpl = vi.fn(async () => res(200)) as unknown as typeof fetch;
    await notifyAgentCreatedTicketKey("ENG-1", "linear", { env: {}, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retries on 5xx then succeeds without recording a failure", async () => {
    const recordTelemetry = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(503))
      .mockResolvedValueOnce(res(200)) as unknown as typeof fetch;
    await notifyAgentCreatedTicketKey("ENG-2", "jira", { env: ENV, fetchImpl, recordTelemetry });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(recordTelemetry).not.toHaveBeenCalled();
  });

  it("does NOT retry on a deterministic 4xx and records telemetry", async () => {
    const recordTelemetry = vi.fn();
    const fetchImpl = vi.fn(async () => res(400)) as unknown as typeof fetch;
    await notifyAgentCreatedTicketKey("ENG-3", "jira", { env: ENV, fetchImpl, recordTelemetry });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(recordTelemetry).toHaveBeenCalledWith(
      "agent_ticket_key_notify_failed",
      expect.objectContaining({ provider: "jira", ticketKey: "ENG-3" }),
    );
  });

  it("retries to exhaustion on persistent network errors and never throws", async () => {
    const recordTelemetry = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(
      notifyAgentCreatedTicketKey("ENG-4", "linear", { env: ENV, fetchImpl, recordTelemetry }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(recordTelemetry).toHaveBeenCalledTimes(1);
  });

  it("retries on its own per-attempt timeout instead of swallowing it as cancellation", async () => {
    const recordTelemetry = vi.fn();
    const fetchImpl = vi.fn(async () => {
      // AbortSignal.timeout(...) aborts surface as a TimeoutError; this is the
      // helper's own deadline, not the caller's, so it must be retried.
      throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    await notifyAgentCreatedTicketKey("ENG-7", "jira", { env: ENV, fetchImpl, recordTelemetry });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(recordTelemetry).toHaveBeenCalledTimes(1);
  });

  it("short-circuits without retry or telemetry when the caller's signal aborts", async () => {
    const recordTelemetry = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }) as unknown as typeof fetch;
    await notifyAgentCreatedTicketKey("ENG-8", "linear", {
      env: ENV,
      fetchImpl,
      recordTelemetry,
      signal: controller.signal,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(recordTelemetry).not.toHaveBeenCalled();
  });
});
