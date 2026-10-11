import { describe, expect, it } from "vitest";

import { escapeRegExp } from "../../apps/control-plane-worker/src/regex";

describe("escapeRegExp", () => {
  it("escapes regex metacharacters with the canonical control-plane helper", () => {
    expect(escapeRegExp("Auto-generated / summary - v2.0")).toBe("Auto\\-generated \\/ summary \\- v2\\.0");
  });
});
