import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("@sentry/cloudflare", () => ({
  instrumentDurableObjectWithSentry: (_optionsCallback: unknown, DurableObjectClass: unknown) => DurableObjectClass,
  withSentry: (_optionsCallback: unknown, handler: unknown) => handler,
  setTag: () => {},
  setUser: () => {},
  captureException: () => {},
}));

type EncryptionModule = {
  encrypt: (plaintext: string, encryptionKey: string | undefined) => Promise<string>;
  decrypt: (stored: string, encryptionKey: string | undefined) => Promise<string>;
  __resetDerivedKeyCacheForTest: () => void;
};

let mod: EncryptionModule;

describe("settings/encryption", () => {
  beforeEach(async () => {
    const modulePath: string = "../../apps/control-plane-worker/src/settings/encryption";
    mod = (await import(modulePath)) as unknown as EncryptionModule;
    mod.__resetDerivedKeyCacheForTest();
  });

  describe("encrypt/decrypt round-trip", () => {
    it("round-trips plaintext with encryption key", async () => {
      const plaintext = "sk-openai-api03-very-secret-key-123";
      const key = "my-encryption-key-for-testing";

      const encrypted = await mod.encrypt(plaintext, key);
      expect(encrypted).not.toBe(plaintext);
      expect(encrypted.startsWith("enc:")).toBe(true);

      const decrypted = await mod.decrypt(encrypted, key);
      expect(decrypted).toBe(plaintext);
    });

    it("throws when encryption key is undefined", async () => {
      await expect(mod.encrypt("sk-openai-api03-not-encrypted", undefined)).rejects.toThrow(
        "TOKEN_ENCRYPTION_KEY is required",
      );
    });

    it("returns stored value as-is when it does not start with enc: prefix", async () => {
      const stored = "plain-text-value";
      const decrypted = await mod.decrypt(stored, "some-key");
      expect(decrypted).toBe(stored);
    });

    it("throws when decryption key is undefined and value has enc: prefix", async () => {
      await expect(mod.decrypt("enc:something:here:there", undefined)).rejects.toThrow(
        "TOKEN_ENCRYPTION_KEY is required",
      );
    });

    it("handles empty plaintext", async () => {
      const encrypted = await mod.encrypt("", "test-key");
      const decrypted = await mod.decrypt(encrypted, "test-key");
      expect(decrypted).toBe("");
    });

    it("handles unicode plaintext", async () => {
      const plaintext = "hello world 123 special chars: !@#$%^&*()";
      const key = "test-key";
      const encrypted = await mod.encrypt(plaintext, key);
      const decrypted = await mod.decrypt(encrypted, key);
      expect(decrypted).toBe(plaintext);
    });

    it("produces different ciphertexts for same plaintext (random IV)", async () => {
      const plaintext = "same-plaintext";
      const key = "test-key";
      const encrypted1 = await mod.encrypt(plaintext, key);
      const encrypted2 = await mod.encrypt(plaintext, key);
      expect(encrypted1).not.toBe(encrypted2);

      // Both should decrypt to the same value
      expect(await mod.decrypt(encrypted1, key)).toBe(plaintext);
      expect(await mod.decrypt(encrypted2, key)).toBe(plaintext);
    });

    it("encrypted value has three colon-separated hex segments after prefix", async () => {
      const encrypted = await mod.encrypt("test", "key");
      const segments = encrypted.slice("enc:".length).split(":");
      expect(segments).toHaveLength(3);
      // Each segment should be valid hex
      for (const seg of segments) {
        expect(seg).toMatch(/^[0-9a-f]+$/);
      }
    });

    it("IV is 12 bytes (24 hex chars)", async () => {
      const encrypted = await mod.encrypt("test", "key");
      const iv = encrypted.slice("enc:".length).split(":")[0];
      expect(iv.length).toBe(24);
    });

    it("auth tag is 16 bytes (32 hex chars)", async () => {
      const encrypted = await mod.encrypt("test", "key");
      const authTag = encrypted.slice("enc:".length).split(":")[1];
      expect(authTag.length).toBe(32);
    });
  });

  describe("decrypt error handling", () => {
    it("throws when enc: prefix but wrong segment count", async () => {
      await expect(mod.decrypt("enc:only-one-segment", "key")).rejects.toThrow("Malformed encrypted value");
    });

    it("throws when enc: prefix but two segments", async () => {
      await expect(mod.decrypt("enc:seg1:seg2", "key")).rejects.toThrow("Malformed encrypted value");
    });

    it("throws when segments are not valid hex", async () => {
      await expect(mod.decrypt("enc:zzzz:gggg:hhhh", "key")).rejects.toThrow("Invalid hex segment");
    });

    it("throws when a hex segment has odd length", async () => {
      await expect(mod.decrypt("enc:abc:abcd:abcdef", "key")).rejects.toThrow("Invalid hex segment");
    });

    it("throws a clear error for an empty IV or auth tag", async () => {
      await expect(mod.decrypt("enc:::abcd", "key")).rejects.toThrow("Malformed encrypted value");
      await expect(mod.decrypt("enc:abcd::abcd", "key")).rejects.toThrow("Malformed encrypted value");
    });

    it("throws on decrypt with wrong key", async () => {
      const encrypted = await mod.encrypt("secret", "correct-key");
      await expect(mod.decrypt(encrypted, "wrong-key")).rejects.toThrow();
    });

    it("throws on decrypt with corrupted ciphertext", async () => {
      const encrypted = await mod.encrypt("test", "key");
      // Corrupt the ciphertext portion
      const parts = encrypted.split(":");
      parts[3] = "00".repeat(parts[3].length / 2);
      const corrupted = parts.join(":");
      await expect(mod.decrypt(corrupted, "key")).rejects.toThrow();
    });
  });

  describe("derived-key cache", () => {
    it("derives once across two encrypt() calls with the same key", async () => {
      const spy = vi.spyOn(crypto.subtle, "deriveBits");
      const key = "same-encryption-key";
      await mod.encrypt("a", key);
      await mod.encrypt("b", key);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it("re-derives when the key changes (fingerprint mismatch)", async () => {
      const spy = vi.spyOn(crypto.subtle, "deriveBits");
      await mod.encrypt("a", "key-one");
      await mod.encrypt("b", "key-two");
      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockRestore();
    });

    it("round-trips correctly with the cache warm", async () => {
      const key = "round-trip-key";
      await mod.encrypt("warm-the-cache", key);
      const encrypted = await mod.encrypt("secret-payload", key);
      expect(await mod.decrypt(encrypted, key)).toBe("secret-payload");
    });

    it("shares a single derivation across concurrent first-callers", async () => {
      const spy = vi.spyOn(crypto.subtle, "deriveBits");
      const key = "concurrent-key";
      await Promise.all([mod.encrypt("a", key), mod.encrypt("b", key), mod.encrypt("c", key)]);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it("evicts the slot on derivation failure so the next call retries", async () => {
      const spy = vi.spyOn(crypto.subtle, "deriveBits").mockRejectedValueOnce(new Error("boom"));
      const key = "eviction-key";
      await expect(mod.encrypt("a", key)).rejects.toThrow("boom");
      // Next call must re-derive (not return the cached rejection) and succeed.
      const encrypted = await mod.encrypt("b", key);
      expect(await mod.decrypt(encrypted, key)).toBe("b");
      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockRestore();
    });
  });
});
