import { describe, expect, it } from "vitest";

import { buildStatusConditions } from "../../apps/control-plane-worker/src/session/db.js";

describe("buildStatusConditions", () => {
  it("excludes archived from the default feed without dropping NULL-status rows", () => {
    // The sidebar fetches without a status; archived rows must not leak in, but a
    // bare `!= 'archived'` would also drop NULL-status rows (NULL != x is UNKNOWN).
    expect(buildStatusConditions(null).conditions).toEqual(["(s.status IS NULL OR s.status != 'archived')"]);
  });

  it("returns archived rows only when the archived chip is selected", () => {
    expect(buildStatusConditions("archived").conditions).toEqual(["(s.status = 'closed' OR s.status = 'archived')"]);
  });

  it("keeps excluding archived for the active filter", () => {
    expect(buildStatusConditions("active").conditions).toContain("s.status != 'archived'");
  });
});
