import { describe, expect, it } from "vitest";

import { d1Changed } from "../../apps/control-plane-worker/src/db/errors";

function d1Result(input: { success?: boolean; changes?: number }): D1Result {
  return {
    success: input.success ?? true,
    meta: input.changes === undefined ? undefined : { changes: input.changes },
  } as D1Result;
}

describe("d1Changed", () => {
  it("returns false when D1 reports zero changed rows", () => {
    expect(d1Changed(d1Result({ changes: 0 }))).toBe(false);
  });

  it("returns true when D1 reports changed rows", () => {
    expect(d1Changed(d1Result({ changes: 1 }))).toBe(true);
  });

  it("returns false when D1 reports failure with changed rows", () => {
    expect(d1Changed(d1Result({ success: false, changes: 1 }))).toBe(false);
  });

  it("returns false when D1 omits meta.changes, even if success is true", () => {
    expect(d1Changed(d1Result({ success: true }))).toBe(false);
  });

  it("returns false when meta exists but has no changes key", () => {
    expect(d1Changed({ success: true, meta: {} } as unknown as D1Result)).toBe(false);
  });
});
