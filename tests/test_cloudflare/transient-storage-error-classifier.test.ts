import { describe, expect, it } from "vitest";

import {
  isTransientD1StorageError,
  isTransientDurableObjectInternalError,
} from "../../apps/control-plane-worker/src/db/errors";

describe("isTransientD1StorageError", () => {
  it("classifies gated D1 transient faults as transient", () => {
    expect(isTransientD1StorageError(new Error("D1_ERROR: internal error"))).toBe(true);
    expect(isTransientD1StorageError(new Error("D1_ERROR: network connection lost"))).toBe(true);
    expect(isTransientD1StorageError(new Error("D1_ERROR: storage operation exceeded timeout, object was reset"))).toBe(
      true,
    );
    expect(isTransientD1StorageError(new Error("D1_ERROR: synthetic per-attempt timeout after 5000ms"))).toBe(true);
  });

  it("requires the d1_error / d1 db prefix gate", () => {
    expect(isTransientD1StorageError(new Error("internal error"))).toBe(false);
    expect(isTransientD1StorageError(new Error("network connection lost"))).toBe(false);
  });

  it("excludes D1 load-shed", () => {
    expect(isTransientD1StorageError(new Error("D1_ERROR: D1 DB is overloaded"))).toBe(false);
    expect(isTransientD1StorageError(new Error("D1_ERROR: queued for too long"))).toBe(false);
  });
});

describe("isTransientDurableObjectInternalError", () => {
  it("classifies a bare Cloudflare internal-reference fault as transient", () => {
    expect(
      isTransientDurableObjectInternalError(new Error("internal error; reference = 36kk4umk6cp46i8a6hsdu41g")),
    ).toBe(true);
    // Extra whitespace variants Cloudflare emits.
    expect(isTransientDurableObjectInternalError(new Error("Error: internal error;reference=abc123"))).toBe(true);
    // Accepts an already-stringified error (the slack-channel-service caller passes a string).
    expect(isTransientDurableObjectInternalError("internal error; reference = abc123")).toBe(true);
  });

  it("matches the reference fault even without the d1_error prefix that gates isTransientD1StorageError", () => {
    const error = new Error("internal error; reference = abc123");
    expect(isTransientD1StorageError(error)).toBe(false);
    expect(isTransientDurableObjectInternalError(error)).toBe(true);
  });

  it("ignores unrelated errors and load-shed", () => {
    expect(isTransientDurableObjectInternalError(new Error("boom"))).toBe(false);
    expect(isTransientDurableObjectInternalError(new Error("internal error"))).toBe(false);
    expect(isTransientDurableObjectInternalError(new Error("internal error; reference = abc123 but overloaded"))).toBe(
      false,
    );
  });
});
