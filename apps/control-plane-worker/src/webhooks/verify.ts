import { computeHmacHex, timingSafeEqualString } from "../utils";

const SLACK_MAX_AGE_SECONDS = 300;

export async function verifyGithubWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  if (!secret || !signature || !signature.startsWith("sha256=")) return false;
  const expected = `sha256=${await computeHmacHex(secret, rawBody)}`;
  return timingSafeEqualString(signature, expected);
}

export async function verifySlackWebhookSignature(
  rawBody: string,
  timestamp: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  if (!secret || !timestamp || !signature) return false;

  const requestTimestamp = Number(timestamp);
  if (!Number.isFinite(requestTimestamp)) return false;

  const ageInSeconds = Math.abs(Math.floor(Date.now() / 1000) - requestTimestamp);
  if (ageInSeconds > SLACK_MAX_AGE_SECONDS) return false;

  const expected = `v0=${await computeHmacHex(secret, `v0:${timestamp}:${rawBody}`)}`;
  return timingSafeEqualString(signature, expected);
}

export async function verifyLinearWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  if (!secret || !signature) return false;
  const expected = await computeHmacHex(secret, rawBody);
  return timingSafeEqualString(signature, expected);
}

export async function verifyPagerDutyWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  if (!secret || !signatureHeader.trim()) return false;
  const expected = await computeHmacHex(secret, rawBody);
  for (const candidate of signatureHeader.split(",")) {
    const signature = candidate.trim();
    if (!signature.startsWith("v1=")) continue;
    if (timingSafeEqualString(signature.slice(3), expected)) return true;
  }
  return false;
}

function base64UrlToBytes(value: string): Uint8Array | null {
  try {
    const padded = value
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Verifies the Authorization token Atlassian attaches to OAuth-app dynamic
 * webhook deliveries: an HS256 JWT signed with the app's client secret.
 * Accepts `JWT <token>`, `Bearer <token>`, or a bare token. Rejects on
 * signature mismatch, non-HS256 algorithms, malformed structure, or an
 * expired `exp` claim.
 */
export async function verifyJiraWebhookJwt(
  authorizationHeader: string | null,
  clientSecret: string,
  now = Date.now(),
): Promise<boolean> {
  if (!clientSecret || !authorizationHeader) return false;

  const token = authorizationHeader.replace(/^(JWT|Bearer)\s+/i, "").trim();
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) return false;
  const [headerSegment, payloadSegment, signatureSegment] = segments;

  let header: { alg?: unknown };
  let payload: { exp?: unknown };
  try {
    const headerBytes = base64UrlToBytes(headerSegment);
    const payloadBytes = base64UrlToBytes(payloadSegment);
    if (!headerBytes || !payloadBytes) return false;
    header = JSON.parse(new TextDecoder().decode(headerBytes)) as { alg?: unknown };
    payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as { exp?: unknown };
  } catch {
    return false;
  }

  // Pinned algorithm: never let the token pick its own (alg=none downgrade).
  if (header.alg !== "HS256") return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(clientSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expectedSignature = bytesToBase64Url(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${headerSegment}.${payloadSegment}`))),
  );
  if (!timingSafeEqualString(signatureSegment, expectedSignature)) return false;

  // exp is mandatory: a signed token without one would otherwise be valid
  // forever if it ever leaked.
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) return false;
  return true;
}
