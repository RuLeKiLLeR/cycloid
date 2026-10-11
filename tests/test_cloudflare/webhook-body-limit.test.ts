import { describe, expect, it } from "vitest";

import {
  DEFAULT_WEBHOOK_MAX_BYTES,
  readCappedWebhookBody,
} from "../../apps/control-plane-worker/src/webhooks/body-limit";

function makeRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://example.com/webhook", { method: "POST", body, headers });
}

describe("readCappedWebhookBody", () => {
  it("returns the body when it is within the cap", async () => {
    const result = await readCappedWebhookBody(makeRequest("hello"), 1024);
    expect(result).toBe("hello");
  });

  it("fast-rejects with 413 when Content-Length exceeds the cap (without trusting the body)", async () => {
    const result = await readCappedWebhookBody(makeRequest("x", { "content-length": String(2048) }), 1024);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
  });

  it("rejects with 413 when the actual body exceeds the cap with a lying Content-Length", async () => {
    const big = "a".repeat(2048);
    // Content-Length says 1 (under cap) but the actual body is 2048 bytes.
    const result = await readCappedWebhookBody(makeRequest(big, { "content-length": "1" }), 1024);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
  });

  it("rejects with 413 when the body exceeds the cap and Content-Length is absent", async () => {
    let canceled = false;
    let chunksPulled = 0;
    const chunks = [new Uint8Array(512), new Uint8Array(513), new Uint8Array(1024 * 1024)];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[chunksPulled];
        chunksPulled += 1;
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
      cancel() {
        canceled = true;
      },
    });
    const request = new Request("https://example.com/webhook", {
      method: "POST",
      body: stream,
      // @ts-expect-error duplex is required for a streamed request body but missing from the lib DOM types
      duplex: "half",
    });

    const result = await readCappedWebhookBody(request, 1024);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
    expect(canceled).toBe(true);
    expect(chunksPulled).toBeLessThanOrEqual(chunks.length);
  });

  it("counts UTF-8 bytes, not characters, against the cap", async () => {
    // 4 multibyte chars = 12 bytes (each '✓' is 3 bytes); cap at 8 bytes rejects.
    const result = await readCappedWebhookBody(makeRequest("✓✓✓✓"), 8);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
  });

  it("defaults to a 1 MiB cap", () => {
    expect(DEFAULT_WEBHOOK_MAX_BYTES).toBe(1024 * 1024);
  });
});
