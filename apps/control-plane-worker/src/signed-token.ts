import { decodeBase64Url, encodeBase64Url } from "./base64url";
import { computeHmacHex, timingSafeEqualString } from "./crypto";

/**
 * Shared HMAC-signed token primitives. Every signed callback token in the
 * worker (prompt, build, eval, artifact access, Sentry OAuth session)
 * follows the same shape:
 *
 *   token = base64url(payload_string) + "." + hex(HMAC-SHA256(secret, payload_string))
 *
 * `createSignedToken` writes that shape. `verifySignedToken` splits on `.`,
 * timing-safe compares the HMAC, and returns the decoded payload object
 * (or `null` on any failure). Callers layer their own payload-specific
 * validation (e.g. expiry, field match) on top.
 *
 * Webhook verifiers in `src/webhooks/verify.ts` (Slack `v0=`, GitHub
 * `sha256=`, etc.) intentionally do NOT use this — they have third-party
 * signature formats and stay separate.
 */

export interface SignedTokenCodec<T> {
  /**
   * Serialize the payload to a UTF-8 string before base64url encoding and
   * signing. The returned string is what the HMAC is computed over.
   */
  encode(payload: T): string;
  /**
   * Parse the decoded UTF-8 payload string back into structured form, or
   * return `null` if it is malformed. This is invoked only after the
   * signature has been verified.
   */
  decode(raw: string): T | null;
}

export async function createSignedToken<T>(payload: T, secret: string, codec: SignedTokenCodec<T>): Promise<string> {
  const payloadString = codec.encode(payload);
  const signature = await computeHmacHex(secret, payloadString);
  return `${encodeBase64Url(payloadString)}.${signature}`;
}

export async function verifySignedToken<T>(
  token: string,
  secret: string,
  codec: SignedTokenCodec<T>,
): Promise<T | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) return null;

  const payloadString = decodeBase64Url(encodedPayload);
  if (payloadString === null) return null;

  const expectedSignature = await computeHmacHex(secret, payloadString);
  if (!timingSafeEqualString(signature, expectedSignature)) return null;

  return codec.decode(payloadString);
}
