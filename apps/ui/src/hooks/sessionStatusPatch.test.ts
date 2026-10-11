import { describe, expect, it } from "vitest";

import { buildSessionStatusPatch } from "./sessionStatusPatch";

const NOW = 1_700_000_000_000;

describe("buildSessionStatusPatch", () => {
  it("sets userStopped when the live status event carries it (live-idle stop)", () => {
    const patch = buildSessionStatusPatch({ phase: "idle", userStopped: true }, NOW);
    expect(patch).toMatchObject({ phase: "idle", userStopped: true, lastLiveStatusPatchAt: NOW });
  });

  it("passes an explicit false through so the Stopped badge can CLEAR", () => {
    // Stale-badge trap: prompt-admit clears the flag by sending userStopped:false
    // on the next status event. The mapped patch MUST carry the key (not drop the
    // false) so the reducer's {...prev, ...patch} merge overwrites a prior true.
    // A truthiness / `!= null`-shaped guard that silently swallowed `false` would
    // leave the badge stuck.
    const patch = buildSessionStatusPatch({ phase: "running", userStopped: false }, NOW);
    expect(patch).toHaveProperty("userStopped", false);
  });

  it("omits userStopped entirely when the status event does not carry it (no clobber)", () => {
    const patch = buildSessionStatusPatch({ phase: "running" }, NOW);
    expect(patch).not.toHaveProperty("userStopped");
  });
});
