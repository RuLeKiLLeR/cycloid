import { Buffer } from "node:buffer";

/**
 * Base64url helpers shared across the worker. Centralizes the handful of
 * near-identical implementations that previously lived alongside each
 * signed-token system.
 *
 * All functions operate on the URL-safe alphabet described in RFC 4648 §5
 * (`-`/`_` in place of `+`/`/`) with padding stripped.
 */

export function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/**
 * Decodes base64url back to a UTF-8 string. Returns `null` if the underlying
 * `Buffer.from` ever throws. Note: Node's `base64url` parser is permissive —
 * it silently accepts non-alphabet characters and replaces invalid UTF-8
 * sequences with U+FFFD rather than throwing. The `null` branch is a
 * defensive guard rather than a routinely-hit path. Every caller gates
 * authentication on a subsequent HMAC comparison, so permissive decoding
 * never weakens token security.
 */
export function decodeBase64Url(value: string): string | null {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

export function encodeBase64UrlBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
