import { bytesToHex } from "../../../shared/utils/hex.js";

/**
 * Low-level crypto primitives shared across the worker. Kept in a dedicated
 * module so `signed-token.ts` and `utils.ts` can both import from it without
 * creating an import cycle.
 */

const textEncoder = new TextEncoder();

export async function computeHmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(message));
  return bytesToHex(new Uint8Array(signature));
}

export async function computeSha256Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(message));
  return bytesToHex(new Uint8Array(digest));
}

export function timingSafeEqualString(left: string, right: string): boolean {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return mismatch === 0;
}
