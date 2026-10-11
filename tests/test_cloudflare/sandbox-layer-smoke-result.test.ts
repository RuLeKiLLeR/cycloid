import { describe, expect, it } from "vitest";

import {
  parseSmokeResult,
  readNumber,
  readSmokeStatus,
  readString,
} from "../../apps/control-plane-worker/src/sandbox/layer-smoke-result";

describe("sandbox layer smoke result helpers", () => {
  it("reads pass, fail, and unknown smoke status from JSON objects", () => {
    expect(readSmokeStatus(JSON.stringify({ ok: true }))).toBe("passed");
    expect(readSmokeStatus(JSON.stringify({ ok: false }))).toBe("failed");
    expect(readSmokeStatus(JSON.stringify({}))).toBeNull();
    expect(readSmokeStatus("[]")).toBeNull();
    expect(readSmokeStatus("not-json")).toBeNull();
  });

  it("parses smoke result objects and rejects non-object payloads", () => {
    expect(parseSmokeResult(JSON.stringify({ ok: true, command: "npm test" }))).toEqual({
      ok: true,
      command: "npm test",
    });
    expect(parseSmokeResult("null")).toBeNull();
    expect(parseSmokeResult('"value"')).toBeNull();
    expect(parseSmokeResult("[1,2,3]")).toBeNull();
  });

  it("coerces only non-empty strings and finite numbers", () => {
    expect(readString("value")).toBe("value");
    expect(readString("")).toBeUndefined();
    expect(readString(123)).toBeUndefined();

    expect(readNumber(0)).toBe(0);
    expect(readNumber(42)).toBe(42);
    expect(readNumber(Number.NaN)).toBeUndefined();
    expect(readNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(readNumber("42")).toBeUndefined();
  });
});
