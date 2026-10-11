/// <reference types="@cloudflare/workers-types" />
/**
 * Tests for the ARC-1045 superseded-attempt capacity-release guard.
 *
 * Capacity admission is session-keyed: the current attempt holds/re-acquires
 * the same session row via idempotent upsert, so a superseded attempt that
 * releases by `sessionId` frees the live runtime's capacity. The guard skips
 * the release while the attempt is not current.
 *
 * These tests pin the load-bearing decision (release ONLY when current).
 */
import { describe, expect, it } from "vitest";

import { shouldReleaseSupersededCapacity } from "../../apps/control-plane-worker/src/session/spawn-workflow";

describe("shouldReleaseSupersededCapacity (guard direction)", () => {
  it("skips the release when the attempt is no longer current (superseded)", () => {
    // The clobber case: a newer attempt is current and owns the session
    // admission. The superseded attempt's compensation path MUST NOT release.
    expect(shouldReleaseSupersededCapacity("attempt-stale", false)).toBe(false);
  });

  it("releases when this attempt is still the current one", () => {
    // Terminal failure of the still-current attempt: no successor to protect,
    // so the admission should be freed.
    expect(shouldReleaseSupersededCapacity("attempt-current", true)).toBe(true);
  });

  it("releases unconditionally when there is no attempt id (non-resumable spawn)", () => {
    expect(shouldReleaseSupersededCapacity(undefined, false)).toBe(true);
    expect(shouldReleaseSupersededCapacity(undefined, true)).toBe(true);
  });
});
