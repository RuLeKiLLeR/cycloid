import { describe, expect, it } from "vitest";

import { toBusinessRole } from "../../apps/control-plane-worker/src/auth/business-role";

describe("toBusinessRole", () => {
  it("keeps valid business member roles", () => {
    expect(toBusinessRole("admin")).toBe("admin");
    expect(toBusinessRole("member")).toBe("member");
  });

  it("normalizes absent and unexpected roles to null", () => {
    expect(toBusinessRole(null)).toBeNull();
    expect(toBusinessRole(undefined)).toBeNull();
    expect(toBusinessRole("owner")).toBeNull();
    expect(toBusinessRole("")).toBeNull();
  });
});
