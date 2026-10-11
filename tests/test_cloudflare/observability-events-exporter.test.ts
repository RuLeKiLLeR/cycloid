import { afterEach, describe, expect, it, vi } from "vitest";

import { runInSpan, startSpan } from "../../apps/control-plane-worker/src/observability/context";
import { postStructuredEventToDd } from "../../apps/control-plane-worker/src/observability/events-exporter";

describe("observability events exporter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips direct-posting when Datadog auth is absent", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await postStructuredEventToDd(
      { WORKER_ENV: "test" },
      {
        event: "prompt.trace.finalized",
        prompt_id: "prompt-1",
      },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts structured control-plane events with Datadog envelope fields", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
    const rootSpan = startSpan("worker.fetch", { "session.id": "sess-1" });

    await runInSpan(rootSpan, async () => {
      await postStructuredEventToDd(
        {
          DD_API_KEY: "dd-api-key",
          WORKER_ENV: "test",
        },
        {
          event: "prompt.trace.finalized",
          prompt_id: "prompt-1",
          trace_complete: true,
        },
      );
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://http-intake.logs.us5.datadoghq.com/api/v2/logs");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "DD-API-KEY": "dd-api-key",
      },
    });

    const body = JSON.parse(String(init?.body));
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      ddsource: "cycloid",
      ddtags: "env:test,worker:control-plane,script:cycloid-control-plane-test",
      hostname: "cf-worker",
      service: "cycloid-control-plane",
      _direct_post: true,
      event: "prompt.trace.finalized",
      prompt_id: "prompt-1",
      trace_complete: true,
      "dd.trace_id": rootSpan.traceId,
      "dd.span_id": rootSpan.spanId,
    });
    expect(JSON.parse(body[0].message)).toMatchObject({
      event: "prompt.trace.finalized",
      prompt_id: "prompt-1",
      trace_complete: true,
    });
  });

  it("keeps the Datadog envelope message field even when the event includes message", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));

    await postStructuredEventToDd(
      {
        DD_API_KEY: "dd-api-key",
        WORKER_ENV: "test",
      },
      {
        event: "prompt.trace.finalized",
        message: "user-payload-message",
        prompt_id: "prompt-1",
      },
    );

    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    expect(body[0].message).toBe(
      JSON.stringify({
        event: "prompt.trace.finalized",
        message: "user-payload-message",
        prompt_id: "prompt-1",
      }),
    );
  });

  it("fails open when the direct-post request rejects", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      postStructuredEventToDd(
        {
          DD_API_KEY: "dd-api-key",
          WORKER_ENV: "test",
        },
        {
          event: "trace_queue_export_failed",
          exportPath: "dd_logs",
        },
      ),
      // Resolves false (not a throw) so callers fail open, but the false signals
      // the post was rejected and a once-only marker must not be cached.
    ).resolves.toBe(false);

    expect(consoleWarn).toHaveBeenCalledWith("[events-exporter] direct-POST failed:", "Error: network down");
  });
});
