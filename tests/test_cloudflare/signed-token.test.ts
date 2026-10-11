import { describe, expect, it } from "vitest";

import { encodeBase64Url } from "../../apps/control-plane-worker/src/base64url";
import {
  createSignedToken,
  type SignedTokenCodec,
  verifySignedToken,
} from "../../apps/control-plane-worker/src/signed-token";

interface TestPayload {
  id: string;
  expiresAt: number;
}

const codec: SignedTokenCodec<TestPayload> = {
  encode(payload) {
    return `${payload.id}:${payload.expiresAt}`;
  },
  decode(raw) {
    const parts = raw.split(":");
    if (parts.length !== 2) return null;
    const expiresAt = Number(parts[1]);
    if (!Number.isFinite(expiresAt)) return null;
    return { id: parts[0], expiresAt };
  },
};

const jsonCodec: SignedTokenCodec<TestPayload> = {
  encode(payload) {
    return JSON.stringify(payload);
  },
  decode(raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<TestPayload>;
      if (typeof parsed.id !== "string" || typeof parsed.expiresAt !== "number") return null;
      return { id: parsed.id, expiresAt: parsed.expiresAt };
    } catch {
      return null;
    }
  },
};

describe("signed-token", () => {
  it("produces payload.signature with hex-64 signature", async () => {
    const token = await createSignedToken({ id: "abc", expiresAt: 1 }, "secret", codec);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
  });

  it("verifies a valid token and returns the decoded payload", async () => {
    const payload = { id: "abc", expiresAt: 123456 };
    const token = await createSignedToken(payload, "secret", codec);
    expect(await verifySignedToken(token, "secret", codec)).toEqual(payload);
  });

  it("works with a JSON codec", async () => {
    const payload = { id: "json-id", expiresAt: 42 };
    const token = await createSignedToken(payload, "secret", jsonCodec);
    expect(await verifySignedToken(token, "secret", jsonCodec)).toEqual(payload);
  });

  it("rejects a token with a tampered payload", async () => {
    const token = await createSignedToken({ id: "abc", expiresAt: 1 }, "secret", codec);
    const [, signature] = token.split(".");
    const tampered = `${encodeBase64Url("zzz:1")}.${signature}`;
    expect(await verifySignedToken(tampered, "secret", codec)).toBe(null);
  });

  it("rejects a token with a tampered signature", async () => {
    const token = await createSignedToken({ id: "abc", expiresAt: 1 }, "secret", codec);
    const [encoded] = token.split(".");
    const tampered = `${encoded}.${"0".repeat(64)}`;
    expect(await verifySignedToken(tampered, "secret", codec)).toBe(null);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createSignedToken({ id: "abc", expiresAt: 1 }, "secret-a", codec);
    expect(await verifySignedToken(token, "secret-b", codec)).toBe(null);
  });

  it("rejects a token that is missing the dot separator", async () => {
    expect(await verifySignedToken("no-dot-here", "secret", codec)).toBe(null);
  });

  it("rejects a token with only one side of the dot separator", async () => {
    expect(await verifySignedToken(".sig", "secret", codec)).toBe(null);
    expect(await verifySignedToken("payload.", "secret", codec)).toBe(null);
  });

  it("rejects tokens with more than two dot-separated segments", async () => {
    // A valid token appended with extra "." segments must be rejected outright
    // to avoid widening the grammar beyond `payload.signature`.
    const token = await createSignedToken({ id: "abc", expiresAt: 1 }, "secret", codec);
    expect(await verifySignedToken(`${token}.extra`, "secret", codec)).toBe(null);
    expect(await verifySignedToken(`${token}.extra.more`, "secret", codec)).toBe(null);
  });

  it("returns null when the codec refuses to decode the payload", async () => {
    // Sign with a payload that the codec cannot parse back.
    const bogusCodec: SignedTokenCodec<string> = {
      encode: (v) => v,
      decode: () => null,
    };
    const token = await createSignedToken("unparseable", "secret", bogusCodec);
    expect(await verifySignedToken(token, "secret", bogusCodec)).toBe(null);
  });
});
