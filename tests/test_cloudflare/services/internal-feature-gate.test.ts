import { beforeEach, describe, expect, it, vi } from "vitest";

const mockResolveInternalFeatureGateUser = vi.fn();
const mockResolveCycloidAdminUser = vi.fn();

vi.mock("../../../apps/control-plane-worker/src/auth/db", () => ({
  resolveCycloidAdminUser: (...args: unknown[]) => mockResolveCycloidAdminUser(...args),
  resolveInternalFeatureGateUser: (...args: unknown[]) => mockResolveInternalFeatureGateUser(...args),
}));

import { ARCANIST_BUSINESS_ID } from "../../../apps/control-plane-worker/src/constants/auth";
import { SEEDED_BUSINESS_IDS } from "../../../apps/control-plane-worker/src/constants/businesses";
import {
  isCycloidAdmin,
  isCycloidMember,
  verifyCycloidAdmin,
  verifyCycloidMember,
} from "../../../apps/control-plane-worker/src/services/internal-feature-gate";

describe("internal feature gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows any member of a Cycloid-owned business (prod or QA) to access internal features", () => {
    expect(isCycloidMember({ businessId: ARCANIST_BUSINESS_ID })).toBe(true);
    expect(isCycloidMember({ businessId: SEEDED_BUSINESS_IDS.cycloidQa })).toBe(true);
    // No hardcoded allowlist: any Cycloid-business member qualifies, with no
    // dependency on a GitHub user ID.
    expect(isCycloidMember({ businessId: ARCANIST_BUSINESS_ID })).toBe(true);
  });

  it("denies users outside any Cycloid-owned business", () => {
    expect(isCycloidMember({ businessId: "biz-other" })).toBe(false);
  });

  it("treats any admin of a Cycloid-owned business as an internal admin", () => {
    // Non-allowlisted admin member of the Cycloid business now qualifies.
    expect(
      isCycloidAdmin({
        businessId: ARCANIST_BUSINESS_ID,
        businessRole: "admin",
      }),
    ).toBe(true);
    expect(
      isCycloidAdmin({
        businessId: SEEDED_BUSINESS_IDS.cycloidQa,
        businessRole: "admin",
      }),
    ).toBe(true);
    // Member role is not enough.
    expect(
      isCycloidAdmin({
        businessId: ARCANIST_BUSINESS_ID,
        businessRole: "member",
      }),
    ).toBe(false);
    // Admin of a non-Cycloid business is not an internal admin.
    expect(
      isCycloidAdmin({
        businessId: "biz-other",
        businessRole: "admin",
      }),
    ).toBe(false);
  });

  it("fails closed when identity or business membership is missing", () => {
    expect(isCycloidMember(null)).toBe(false);
    expect(isCycloidMember({ businessId: null })).toBe(false);
  });

  it("re-resolves the canonical user row for authoritative checks", async () => {
    mockResolveInternalFeatureGateUser.mockResolvedValue({
      businessId: ARCANIST_BUSINESS_ID,
    });

    await expect(
      verifyCycloidMember({} as D1Database, {
        user: {
          id: 2,
          githubUserId: 99999999,
          login: "test-user",
          name: null,
          email: null,
          businessId: "biz-customer",
        },
      }),
    ).resolves.toBe(true);
    expect(mockResolveInternalFeatureGateUser).toHaveBeenCalledWith(expect.anything(), 2);
  });

  it("re-resolves the canonical user row for admin authoritative checks", async () => {
    mockResolveCycloidAdminUser.mockResolvedValue({
      businessId: ARCANIST_BUSINESS_ID,
      businessRole: "admin",
    });

    await expect(
      verifyCycloidAdmin({} as D1Database, {
        user: {
          id: 2,
          githubUserId: 99999999,
          login: "test-user",
          name: null,
          email: null,
          businessId: "biz-customer",
          businessRole: "member",
        },
      }),
    ).resolves.toBe(true);
    expect(mockResolveCycloidAdminUser).toHaveBeenCalledWith(expect.anything(), 2);
  });

  it("allows QA Cycloid admins in admin authoritative checks", async () => {
    mockResolveCycloidAdminUser.mockResolvedValue({
      businessId: SEEDED_BUSINESS_IDS.cycloidQa,
      businessRole: "admin",
    });

    await expect(
      verifyCycloidAdmin({} as D1Database, {
        user: {
          id: 3,
          githubUserId: 99999998,
          login: "qa-admin",
          name: null,
          email: null,
          businessId: "biz-customer",
          businessRole: "member",
        },
      }),
    ).resolves.toBe(true);
  });

  it("denies non-admin and non-Cycloid users in admin authoritative checks", async () => {
    mockResolveCycloidAdminUser.mockResolvedValue({
      businessId: ARCANIST_BUSINESS_ID,
      businessRole: "member",
    });
    await expect(verifyCycloidAdmin({} as D1Database, { user: { id: 4 } as never })).resolves.toBe(false);

    mockResolveCycloidAdminUser.mockResolvedValue({
      businessId: "biz-other",
      businessRole: "admin",
    });
    await expect(verifyCycloidAdmin({} as D1Database, { user: { id: 5 } as never })).resolves.toBe(false);
  });

  it("fails closed for missing or invalid auth users in admin authoritative checks", async () => {
    await expect(verifyCycloidAdmin({} as D1Database, null)).resolves.toBe(false);
    await expect(verifyCycloidAdmin({} as D1Database, { user: { id: "2" } as never })).resolves.toBe(false);
    await expect(verifyCycloidAdmin({} as D1Database, { user: { id: 2.5 } as never })).resolves.toBe(false);
    expect(mockResolveCycloidAdminUser).not.toHaveBeenCalled();
  });

  it("uses actorUser before impersonated user for admin authoritative checks", async () => {
    mockResolveCycloidAdminUser.mockResolvedValue({
      businessId: ARCANIST_BUSINESS_ID,
      businessRole: "admin",
    });

    await expect(
      verifyCycloidAdmin({} as D1Database, {
        user: { id: 6 } as never,
        actorUser: { id: 7 } as never,
      }),
    ).resolves.toBe(true);
    expect(mockResolveCycloidAdminUser).toHaveBeenCalledWith(expect.anything(), 7);
  });
});
