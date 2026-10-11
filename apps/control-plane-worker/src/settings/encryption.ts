import { bytesToHex } from "../../../../shared/utils/hex.js";

const ENC_PREFIX = "enc:";
const SALT = new TextEncoder().encode("cycloid-salt");

// Single-slot cache for the PBKDF2-derived CryptoKey. The salt is a fixed
// module constant and the input is always the same TOKEN_ENCRYPTION_KEY, so the
// derived key is identical on every call - deriving it once per isolate removes
// a 100k-iteration PBKDF2 run from every encrypt()/decrypt(). `fp` is a
// non-secret-by-construction equality token (SHA-256 of the raw key) used only
// to detect rotation; it is secret-derived, so it is never logged or exposed.
// We cache the promise (not the awaited key) so concurrent first-callers share
// one derivation instead of stampeding.
let cached: { fp: string; key: Promise<CryptoKey> } | null = null;

async function fingerprint(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return bytesToHex(new Uint8Array(digest));
}

async function deriveKeyUncached(raw: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(raw), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: SALT, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function deriveKey(raw: string): Promise<CryptoKey> {
  const fp = await fingerprint(raw);
  if (cached?.fp === fp) return cached.key;

  const key = deriveKeyUncached(raw);
  cached = { fp, key };
  // On derivation failure, evict so the next call retries instead of returning
  // a permanently-cached rejection. Guard the slot identity so a newer
  // derivation (rotation) is not clobbered by an older one's rejection.
  key.catch(() => {
    if (cached?.key === key) cached = null;
  });
  return key;
}

// Test-only reset so module-scoped cache state does not leak across cases. The
// `__...ForTest` prefix marks this as not for production use (matches
// `__resetInstallationTokenSingleFlightForTest` in github/octokit.ts); a stray
// call only forces a single re-derivation, never a correctness or security
// regression.
export function __resetDerivedKeyCacheForTest(): void {
  cached = null;
}

function fromHex(hex: string): ArrayBuffer {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new Error("Invalid hex segment in encrypted value");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes.buffer as ArrayBuffer;
}

export async function encrypt(plaintext: string, encryptionKey: string | undefined): Promise<string> {
  if (!encryptionKey) {
    throw new Error("TOKEN_ENCRYPTION_KEY is required to encrypt credentials");
  }

  const key = await deriveKey(encryptionKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);

  // AES-GCM appends the 16-byte auth tag to the ciphertext
  const combined = new Uint8Array(ciphertext);
  const authTag = combined.slice(-16);
  const encrypted = combined.slice(0, -16);

  return `${ENC_PREFIX}${bytesToHex(iv)}:${bytesToHex(authTag)}:${bytesToHex(encrypted)}`;
}

export async function decrypt(stored: string, encryptionKey: string | undefined): Promise<string> {
  // Values without the enc: prefix are legacy plaintext rows; pass them through.
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  if (!encryptionKey) {
    throw new Error("TOKEN_ENCRYPTION_KEY is required to decrypt credentials");
  }

  const segments = stored.slice(ENC_PREFIX.length).split(":");
  if (segments.length !== 3) {
    throw new Error("Malformed encrypted value");
  }

  const [ivHex, authTagHex, ciphertextHex] = segments;
  // IV and auth tag are fixed-size and never empty; an empty ciphertext is
  // valid (empty plaintext encrypts to 0 bytes + tag). Reject empty iv/tag
  // here so a value like `enc:::abcd` fails with a clear message instead of an
  // opaque AES-GCM error.
  if (ivHex.length === 0 || authTagHex.length === 0) {
    throw new Error("Malformed encrypted value");
  }
  const iv = fromHex(ivHex);
  const authTag = new Uint8Array(fromHex(authTagHex));
  const ciphertext = new Uint8Array(fromHex(ciphertextHex));

  // Reassemble: ciphertext + authTag (AES-GCM expects them concatenated)
  const combined = new Uint8Array(ciphertext.length + authTag.length);
  combined.set(ciphertext);
  combined.set(authTag, ciphertext.length);

  const key = await deriveKey(encryptionKey);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, combined.buffer as ArrayBuffer);
  return new TextDecoder().decode(decrypted);
}
