import { afterEach, describe, expect, it, vi } from "vitest";

import { computeHmacHex } from "../../apps/control-plane-worker/src/crypto.js";
import {
  verifyGithubWebhookSignature,
  verifyJiraWebhookJwt,
  verifyLinearWebhookSignature,
  verifyPagerDutyWebhookSignature,
  verifySlackWebhookSignature,
} from "../../apps/control-plane-worker/src/webhooks/verify.js";

// These four functions are the security boundary that rejects forged inbound
// webhooks. They had no dedicated unit tests: handlers only ever exercised them
// with fixtures that generate valid signatures, so a mutation that weakened
// rejection (dropped the algorithm pin, inverted a comparison, removed the
// timestamp/exp guard) would not have been caught. Each block below pins both
// the accept and the reject path.

const SECRET = "webhook-secret-value";
const BODY = JSON.stringify({ hello: "world", n: 42 });

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Signs a JWT with an attacker-controllable `alg` header but a genuine HS256
 * signature over the secret. This lets us prove the verifier rejects on the
 * pinned-algorithm check alone, even when the HMAC itself is valid.
 */
async function signJwt(
  secret: string,
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<string> {
  const headerSegment = base64Url(encoder.encode(JSON.stringify(header)));
  const payloadSegment = base64Url(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = base64Url(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${headerSegment}.${payloadSegment}`))),
  );
  return `${headerSegment}.${payloadSegment}.${signature}`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("verifyGithubWebhookSignature", () => {
  it("accepts a correctly signed payload", async () => {
    const signature = `sha256=${await computeHmacHex(SECRET, BODY)}`;
    expect(await verifyGithubWebhookSignature(BODY, signature, SECRET)).toBe(true);
  });

  it("rejects a payload signed with a different secret", async () => {
    const signature = `sha256=${await computeHmacHex("other-secret", BODY)}`;
    expect(await verifyGithubWebhookSignature(BODY, signature, SECRET)).toBe(false);
  });

  it("rejects when the body is tampered after signing", async () => {
    const signature = `sha256=${await computeHmacHex(SECRET, BODY)}`;
    expect(await verifyGithubWebhookSignature(`${BODY} `, signature, SECRET)).toBe(false);
  });

  it("rejects a signature without the sha256= prefix", async () => {
    const bare = await computeHmacHex(SECRET, BODY);
    expect(await verifyGithubWebhookSignature(BODY, bare, SECRET)).toBe(false);
  });

  it("rejects when the signature or secret is empty (fail closed)", async () => {
    const signature = `sha256=${await computeHmacHex(SECRET, BODY)}`;
    expect(await verifyGithubWebhookSignature(BODY, "", SECRET)).toBe(false);
    expect(await verifyGithubWebhookSignature(BODY, signature, "")).toBe(false);
  });
});

describe("verifySlackWebhookSignature", () => {
  async function slackSig(timestamp: string, body = BODY, secret = SECRET): Promise<string> {
    return `v0=${await computeHmacHex(secret, `v0:${timestamp}:${body}`)}`;
  }

  it("accepts a fresh, correctly signed request", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    expect(await verifySlackWebhookSignature(BODY, ts, await slackSig(ts), SECRET)).toBe(true);
  });

  it("accepts a timestamp just inside the 300s window and rejects just outside", async () => {
    const now = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);

    const inside = String(now - 299);
    const boundary = String(now - 300);
    const outside = String(now - 301);
    expect(await verifySlackWebhookSignature(BODY, inside, await slackSig(inside), SECRET)).toBe(true);
    expect(await verifySlackWebhookSignature(BODY, boundary, await slackSig(boundary), SECRET)).toBe(true);
    expect(await verifySlackWebhookSignature(BODY, outside, await slackSig(outside), SECRET)).toBe(false);
  });

  it("rejects a far-future timestamp (clock skew / replay)", async () => {
    const now = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const future = String(now + 600);
    expect(await verifySlackWebhookSignature(BODY, future, await slackSig(future), SECRET)).toBe(false);
  });

  it("rejects a non-numeric or empty timestamp", async () => {
    expect(await verifySlackWebhookSignature(BODY, "not-a-number", await slackSig("not-a-number"), SECRET)).toBe(false);
    expect(await verifySlackWebhookSignature(BODY, "", await slackSig(""), SECRET)).toBe(false);
  });

  it("rejects a fresh timestamp with a forged signature", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const forged = await slackSig(ts, BODY, "wrong-secret");
    expect(await verifySlackWebhookSignature(BODY, ts, forged, SECRET)).toBe(false);
  });
});

describe("verifyLinearWebhookSignature", () => {
  it("accepts a correctly signed payload", async () => {
    const signature = await computeHmacHex(SECRET, BODY);
    expect(await verifyLinearWebhookSignature(BODY, signature, SECRET)).toBe(true);
  });

  it("rejects a forged signature and an empty secret", async () => {
    const forged = await computeHmacHex("wrong-secret", BODY);
    expect(await verifyLinearWebhookSignature(BODY, forged, SECRET)).toBe(false);
    expect(await verifyLinearWebhookSignature(BODY, await computeHmacHex(SECRET, BODY), "")).toBe(false);
  });
});

describe("verifyPagerDutyWebhookSignature", () => {
  it("accepts a correctly signed payload", async () => {
    const signature = `v1=${await computeHmacHex(SECRET, BODY)}`;
    expect(await verifyPagerDutyWebhookSignature(BODY, signature, SECRET)).toBe(true);
  });

  it("accepts any matching signature when PagerDuty sends multiple v1 entries", async () => {
    const valid = `v1=${await computeHmacHex(SECRET, BODY)}`;
    const invalid = `v1=${await computeHmacHex("other-secret", BODY)}`;
    expect(await verifyPagerDutyWebhookSignature(BODY, `${invalid}, ${valid}`, SECRET)).toBe(true);
  });

  it("rejects forged or missing signatures", async () => {
    const valid = `v1=${await computeHmacHex(SECRET, BODY)}`;
    expect(await verifyPagerDutyWebhookSignature(BODY, "", SECRET)).toBe(false);
    expect(await verifyPagerDutyWebhookSignature(BODY, valid, "")).toBe(false);
    expect(await verifyPagerDutyWebhookSignature(BODY, `v1=${await computeHmacHex("wrong", BODY)}`, SECRET)).toBe(
      false,
    );
  });
});

describe("verifyJiraWebhookJwt", () => {
  const future = () => Math.floor(Date.now() / 1000) + 300;

  it("accepts a valid HS256 token with JWT, Bearer, and bare framings", async () => {
    const token = await signJwt(SECRET, { alg: "HS256", typ: "JWT" }, { exp: future() });
    expect(await verifyJiraWebhookJwt(`JWT ${token}`, SECRET)).toBe(true);
    expect(await verifyJiraWebhookJwt(`Bearer ${token}`, SECRET)).toBe(true);
    expect(await verifyJiraWebhookJwt(token, SECRET)).toBe(true);
  });

  it("rejects an alg=none downgrade even with an otherwise valid signature", async () => {
    // Header claims `none` but we still attach a real HMAC signature. The pin
    // must reject purely on the algorithm, never trusting the token's choice.
    const token = await signJwt(SECRET, { alg: "none", typ: "JWT" }, { exp: future() });
    expect(await verifyJiraWebhookJwt(`JWT ${token}`, SECRET)).toBe(false);
  });

  it("rejects an alg=RS256 downgrade and a missing alg header", async () => {
    const rs256 = await signJwt(SECRET, { alg: "RS256", typ: "JWT" }, { exp: future() });
    const noAlg = await signJwt(SECRET, { typ: "JWT" }, { exp: future() });
    expect(await verifyJiraWebhookJwt(`JWT ${rs256}`, SECRET)).toBe(false);
    expect(await verifyJiraWebhookJwt(`JWT ${noAlg}`, SECRET)).toBe(false);
  });

  it("rejects a token signed with the wrong secret", async () => {
    const token = await signJwt("wrong-secret", { alg: "HS256", typ: "JWT" }, { exp: future() });
    expect(await verifyJiraWebhookJwt(`JWT ${token}`, SECRET)).toBe(false);
  });

  it("rejects an expired token and one missing the exp claim", async () => {
    const expired = await signJwt(SECRET, { alg: "HS256", typ: "JWT" }, { exp: Math.floor(Date.now() / 1000) - 10 });
    const noExp = await signJwt(SECRET, { alg: "HS256", typ: "JWT" }, { sub: "user" });
    expect(await verifyJiraWebhookJwt(`JWT ${expired}`, SECRET)).toBe(false);
    expect(await verifyJiraWebhookJwt(`JWT ${noExp}`, SECRET)).toBe(false);
  });

  it("rejects malformed structures and empty inputs (fail closed)", async () => {
    expect(await verifyJiraWebhookJwt(null, SECRET)).toBe(false);
    expect(await verifyJiraWebhookJwt("JWT not.enough", SECRET)).toBe(false);
    expect(await verifyJiraWebhookJwt("JWT a..c", SECRET)).toBe(false);
    expect(await verifyJiraWebhookJwt("JWT %%%.%%%.%%%", SECRET)).toBe(false);
    const valid = await signJwt(SECRET, { alg: "HS256", typ: "JWT" }, { exp: future() });
    expect(await verifyJiraWebhookJwt(`JWT ${valid}`, "")).toBe(false);
  });
});
