import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  gunzipCapped,
  rewriteSentryEnvelopeDsn,
} from "../../apps/control-plane-worker/src/observability/sentry-envelope";

const REAL_DSN = "https://realkey@o1.ingest.sentry.io/42";

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe("rewriteSentryEnvelopeDsn", () => {
  it("replaces the header dsn and leaves the items untouched", () => {
    const envelope = `${JSON.stringify({ dsn: "https://placeholder@x.invalid/1", sent_at: "t" })}\n{"type":"event"}\n{"message":"hi"}`;
    const out = decode(rewriteSentryEnvelopeDsn(encode(envelope), REAL_DSN));
    const [header, ...items] = out.split("\n");
    expect(JSON.parse(header)).toEqual({ dsn: REAL_DSN, sent_at: "t" });
    expect(items).toEqual(['{"type":"event"}', '{"message":"hi"}']);
  });

  it("sets the dsn on a header that lacked one", () => {
    const out = decode(rewriteSentryEnvelopeDsn(encode('{"sent_at":"t"}\n{"type":"event"}\n{}'), REAL_DSN));
    expect(JSON.parse(out.split("\n")[0])).toEqual({ sent_at: "t", dsn: REAL_DSN });
  });

  it("handles a header-only envelope (no trailing newline)", () => {
    const out = decode(rewriteSentryEnvelopeDsn(encode("{}"), REAL_DSN));
    expect(JSON.parse(out)).toEqual({ dsn: REAL_DSN });
  });

  it("throws on a non-JSON header so callers can fall back to the original body", () => {
    expect(() => rewriteSentryEnvelopeDsn(encode("not-json\n{}"), REAL_DSN)).toThrow();
  });
});

describe("gunzipCapped", () => {
  it("round-trips gzipped data", async () => {
    const payload = '{"dsn":"x"}\n{"type":"event"}';
    const out = await gunzipCapped(new Uint8Array(gzipSync(Buffer.from(payload, "utf8"))), 1024);
    expect(decode(out)).toBe(payload);
  });

  it("rejects when the decompressed size exceeds the cap", async () => {
    const big = "a".repeat(64 * 1024);
    const compressed = new Uint8Array(gzipSync(Buffer.from(big, "utf8")));
    await expect(gunzipCapped(compressed, 1024)).rejects.toThrow(/size cap/);
  });

  it("rejects non-gzip input", async () => {
    await expect(gunzipCapped(encode("plain"), 1024)).rejects.toThrow();
  });
});
