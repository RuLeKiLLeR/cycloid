import { describe, expect, it } from "vitest";

import { BRIDGE_PROTOCOL_VERSION } from "../../shared/constants/bridge-protocol";

describe("bridge protocol version", () => {
  it("is a positive safe integer", () => {
    expect(Number.isSafeInteger(BRIDGE_PROTOCOL_VERSION)).toBe(true);
    expect(BRIDGE_PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});
