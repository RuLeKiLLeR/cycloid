import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

// Pure-logic tests for the bridge-bundle publish script (ARC-1512). No network:
// the wrangler R2 calls are exercised only during real deploys. These lock the
// content-addressing contract and pointer shape that PR 2 reads back at session
// start.

type PublishModule = {
  BRIDGE_KEY_PREFIX: string;
  POINTER_KEY: string;
  DEFAULT_BUNDLE_PATH: string;
  START_BRIDGE_KEY_PREFIX: string;
  START_BRIDGE_POINTER_KEY: string;
  DEFAULT_START_BRIDGE_PATH: string;
  computeSha256(buf: Buffer): string;
  contentAddressedKey(sha256: string): string;
  contentAddressedStartBridgeKey(sha256: string): string;
  buildPointer(args: {
    sha256: string;
    key: string;
    bytes: number;
    gzBytes: number;
    builtAt: string;
    gitSha: string;
  }): Record<string, unknown>;
};

const mod = (await import(new URL("../../scripts/publish-bridge-bundle.mjs", import.meta.url).href)) as PublishModule;

describe("publish-bridge-bundle pure logic", () => {
  it("computes sha256 of the raw bundle bytes", () => {
    const buf = Buffer.from("bridge-bundle-contents");
    const expected = createHash("sha256").update(buf).digest("hex");
    expect(mod.computeSha256(buf)).toBe(expected);
    expect(mod.computeSha256(buf)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("derives a content-addressed gzip key under bridge/", () => {
    const sha = "a".repeat(64);
    expect(mod.contentAddressedKey(sha)).toBe(`bridge/${sha}.js.gz`);
    expect(mod.contentAddressedKey(sha).startsWith(mod.BRIDGE_KEY_PREFIX)).toBe(true);
  });

  it("derives a content-addressed gzip key under start-bridge/", () => {
    const sha = "c".repeat(64);
    expect(mod.contentAddressedStartBridgeKey(sha)).toBe(`start-bridge/${sha}.sh.gz`);
    expect(mod.contentAddressedStartBridgeKey(sha).startsWith(mod.START_BRIDGE_KEY_PREFIX)).toBe(true);
  });

  it("rejects a non-sha key input", () => {
    expect(() => mod.contentAddressedKey("not-a-sha")).toThrow();
    expect(() => mod.contentAddressedKey("A".repeat(64))).toThrow(); // uppercase is not hex-normalized
    expect(() => mod.contentAddressedStartBridgeKey("not-a-sha")).toThrow();
  });

  it("builds the pointer object with the injection-contract shape", () => {
    const pointer = mod.buildPointer({
      sha256: "b".repeat(64),
      key: `bridge/${"b".repeat(64)}.js.gz`,
      bytes: 8_800_000,
      gzBytes: 2_500_000,
      builtAt: "2026-07-08T00:00:00.000Z",
      gitSha: "deadbeef",
    });
    expect(pointer).toEqual({
      sha256: "b".repeat(64),
      key: `bridge/${"b".repeat(64)}.js.gz`,
      bytes: 8_800_000,
      gzBytes: 2_500_000,
      builtAt: "2026-07-08T00:00:00.000Z",
      gitSha: "deadbeef",
    });
    // Pointer must round-trip as JSON (it is written to bridge/current.json).
    expect(JSON.parse(JSON.stringify(pointer))).toEqual(pointer);
  });

  it("pins the pointer keys and default artifact paths", () => {
    expect(mod.POINTER_KEY).toBe("bridge/current.json");
    expect(mod.DEFAULT_BUNDLE_PATH).toBe("apps/sandbox-bridge/dist/bundle.js");
    expect(mod.START_BRIDGE_POINTER_KEY).toBe("start-bridge/current.json");
    expect(mod.DEFAULT_START_BRIDGE_PATH).toBe("apps/sandbox-e2b/start-bridge.sh");
  });
});
