import { describe, expect, it } from "vitest";

import { normalizeTelemetryId } from "../../shared/utils/trace-ids";

describe("normalizeTelemetryId", () => {
  it("accepts non-empty telemetry IDs that are not all zeroes", () => {
    expect(normalizeTelemetryId("bt-span-1")).toBe("bt-span-1");
    expect(normalizeTelemetryId("bbbbbbbbbbbbbbbb")).toBe("bbbbbbbbbbbbbbbb");
  });

  it("rejects non-string, empty, and all-zero telemetry IDs", () => {
    expect(normalizeTelemetryId(undefined)).toBeUndefined();
    expect(normalizeTelemetryId(null)).toBeUndefined();
    expect(normalizeTelemetryId("")).toBeUndefined();
    expect(normalizeTelemetryId("0000000000000000")).toBeUndefined();
  });
});
