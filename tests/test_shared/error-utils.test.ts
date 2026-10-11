import { describe, expect, it } from "vitest";

import { serializeError } from "../../shared/observability/error-utils.js";
import { stringifyError } from "../../shared/utils/errors.js";

describe("serializeError", () => {
  it("preserves name, message, type, code, and stack", () => {
    const err = new TypeError("boom");
    (err as TypeError & { code?: string }).code = "ECONNREFUSED";

    const result = serializeError(err);

    expect(result.name).toBe("TypeError");
    expect(result.type).toBe("TypeError");
    expect(result.message).toBe("boom");
    expect(result.code).toBe("ECONNREFUSED");
    expect(result.stack).toContain("boom");
  });

  it("preserves the cause chain", () => {
    const cause = new Error("inner");
    const err = new Error("outer", { cause });

    const result = serializeError(err);

    expect(result.cause).toBeDefined();
    expect(result.cause?.message).toBe("inner");
    expect(result.cause?.name).toBe("Error");
  });

  it("preserves the aggregated errors of an AggregateError", () => {
    const err = new AggregateError([new TypeError("first"), new Error("second")], "");

    const result = serializeError(err);

    expect(result.name).toBe("AggregateError");
    expect(result.errors).toHaveLength(2);
    expect(result.errors?.[0]).toMatchObject({ name: "TypeError", message: "first" });
    expect(result.errors?.[1]).toMatchObject({ name: "Error", message: "second" });
  });

  it("redacts secrets inside aggregated sub-errors", () => {
    const err = new AggregateError([new Error("token ghp_0123456789abcdefghijABCDEF")], "all failed");

    const result = serializeError(err);

    expect(JSON.stringify(result)).not.toContain("ghp_0123456789abcdefghijABCDEF");
    expect(result.errors?.[0]?.message).toContain("[REDACTED]");
  });

  it("survives JSON serialization with all fields intact", () => {
    const err = new Error("serializable");
    (err as Error & { code?: number }).code = 503;

    const round = JSON.parse(JSON.stringify(serializeError(err)));

    expect(round.name).toBe("Error");
    expect(round.message).toBe("serializable");
    expect(round.code).toBe(503);
    expect(round.stack).toContain("serializable");
  });

  it("redacts secrets in the message", () => {
    const err = new Error("auth failed for token ghp_0123456789abcdefghijABCDEF");

    const result = serializeError(err);

    expect(result.message).not.toContain("ghp_0123456789abcdefghijABCDEF");
    expect(result.message).toContain("[REDACTED]");
  });

  it("redacts secrets in the stack and cause", () => {
    const cause = new Error("postgres://user:sentinel-pass@db.example/app");
    const err = new Error("wrapper https://user:sentinel-pass@example.com/repo.git", { cause });

    const result = serializeError(err);

    expect(JSON.stringify(result)).not.toContain("sentinel-pass");
    expect(result.cause?.message).toContain("[REDACTED]");
  });

  it("omits the stack when includeStack is false (response-safe)", () => {
    const err = new Error("response error");

    const result = serializeError(err, { includeStack: false });

    expect(result.stack).toBeUndefined();
    expect(result.message).toBe("response error");
  });

  it("handles non-Error throwables", () => {
    expect(serializeError("just a string")).toMatchObject({
      name: "NonError",
      message: "just a string",
      type: "string",
    });
    expect(serializeError(null)).toMatchObject({ name: "NonError", type: "null" });
    expect(serializeError({ weird: "object" })).toMatchObject({ name: "NonError", type: "object" });
  });

  it("redacts secrets in non-Error throwables", () => {
    const result = serializeError("leaked ghp_0123456789abcdefghijABCDEF");
    expect(result.message).not.toContain("ghp_0123456789abcdefghijABCDEF");
  });

  it("key-aware redacts secret-named fields of thrown plain objects", () => {
    const result = serializeError({ password: "devpass", note: "fine" });
    expect(result.message).not.toContain("devpass");
    expect(result.message).toContain("[REDACTED]");
    expect(result.message).toContain("fine");
  });

  it("truncates cause chains deeper than MAX_CAUSE_DEPTH", () => {
    const deepest = new Error("level5");
    const c3 = new Error("level4", { cause: deepest });
    const c2 = new Error("level3", { cause: c3 });
    const c1 = new Error("level2", { cause: c2 });
    const top = new Error("level1", { cause: c1 });

    const result = serializeError(top);

    expect(result.cause?.cause?.cause).toBeDefined();
    expect(result.cause?.cause?.cause?.cause).toBeUndefined();
  });

  it("gives type the constructor name, falling back without empty strings", () => {
    const anon = new (class extends Error {})("anon");
    const result = serializeError(anon);

    expect(result.type).not.toBe("");
    expect(result.type).toBeTruthy();
  });

  it("never throws on an error with a throwing getter", () => {
    const hostile = new Error("ok");
    Object.defineProperty(hostile, "stack", {
      get() {
        throw new Error("getter blew up");
      },
    });

    expect(() => serializeError(hostile)).not.toThrow();
    expect(serializeError(hostile).name).toBe("SerializationError");
  });
});

describe("stringifyError", () => {
  it("uses Error.message for Error instances", () => {
    expect(stringifyError(new Error("boom"))).toBe("boom");
  });

  it("falls back to String for non-Error values", () => {
    expect(stringifyError("plain")).toBe("plain");
    expect(stringifyError(42)).toBe("42");
  });
});
