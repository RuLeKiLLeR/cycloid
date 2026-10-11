import { afterEach, describe, expect, it, vi } from "vitest";

import { readRollout, writeRollout } from "../../apps/control-plane-worker/src/services/archive";
import type { Env } from "../../apps/control-plane-worker/src/types";

const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as Parameters<
  typeof writeRollout
>[3];

function s3Env(overrides: Record<string, unknown> = {}): Env {
  return {
    S3_ACCESS_KEY_ID: "ak",
    S3_SECRET_ACCESS_KEY: "sk",
    S3_SESSION_BUCKET: "bucket",
    S3_REGION: "us-east-1",
    ...overrides,
  } as Env;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("writeRollout", () => {
  it("PUTs gzip bytes to the rollout key and returns true on success", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const ok = await writeRollout(s3Env(), "sess-1", new Uint8Array([1, 2, 3]), log);
    expect(ok).toBe(true);
    const url = fetchSpy.mock.calls[0]![0] as string | URL;
    expect(String(url)).toContain("/sessions/sess-1/codex-rollout.tar.gz");
    expect((fetchSpy.mock.calls[0]![1] as RequestInit).method).toBe("PUT");
    expect((fetchSpy.mock.calls[0]![1] as RequestInit).headers as Headers).toSatisfy(
      (h: Headers) => h.get("content-type") === "application/gzip",
    );
  });

  it("returns false when S3 is not configured", async () => {
    const ok = await writeRollout(s3Env({ S3_SESSION_BUCKET: undefined }), "sess-1", new Uint8Array([1]), log);
    expect(ok).toBe(false);
  });

  it("returns false when S3 PUT fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));
    const ok = await writeRollout(s3Env(), "sess-1", new Uint8Array([1]), log);
    expect(ok).toBe(false);
    expect(log.error).toHaveBeenCalled();
  });
});

describe("readRollout", () => {
  it("returns the body stream on 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([9, 9]), { status: 200 }));
    const body = await readRollout(s3Env(), "sess-1", log);
    expect(body).not.toBeNull();
  });

  it("returns null on 404", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    const body = await readRollout(s3Env(), "sess-1", log);
    expect(body).toBeNull();
  });

  it("returns null when S3 is not configured", async () => {
    const body = await readRollout(s3Env({ S3_SESSION_BUCKET: undefined }), "sess-1", log);
    expect(body).toBeNull();
  });
});
