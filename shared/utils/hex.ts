/**
 * Convert a Uint8Array or ArrayBuffer to a lowercase hex string.
 */
export function bytesToHex(buf: Uint8Array | ArrayBuffer): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
