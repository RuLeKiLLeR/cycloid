import { describe, expect, it } from "vitest";

import {
  isInternalCycloidBusinessId,
  SEEDED_BUSINESS_IDS,
} from "../../apps/control-plane-worker/src/constants/businesses";

describe("isInternalCycloidBusinessId", () => {
  it("treats the prod Cycloid business as internal", () => {
    expect(isInternalCycloidBusinessId(SEEDED_BUSINESS_IDS.cycloid)).toBe(true);
  });

  it("treats the QA Cycloid business as internal", () => {
    expect(isInternalCycloidBusinessId(SEEDED_BUSINESS_IDS.cycloidQa)).toBe(true);
  });

  it("treats other seeded businesses as external", () => {
    expect(isInternalCycloidBusinessId(SEEDED_BUSINESS_IDS.armory)).toBe(false);
  });

  it("treats an unknown business id as external", () => {
    expect(isInternalCycloidBusinessId("not-a-real-business-id")).toBe(false);
  });
});
