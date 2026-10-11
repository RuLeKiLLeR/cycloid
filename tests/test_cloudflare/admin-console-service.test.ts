import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  searchAdminBusinesses: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/business/db", () => ({
  searchAdminBusinesses: mocks.searchAdminBusinesses,
}));

const { listAdminBusinessesDetailed, searchAdminBusinesses } =
  await import("../../apps/control-plane-worker/src/services/admin-console");

describe("admin-console service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.searchAdminBusinesses.mockResolvedValue([]);
  });

  it("lists businesses via the business DAO with the requested order", async () => {
    const db = {} as D1Database;
    await listAdminBusinessesDetailed(db, { limit: 25, orderBy: "createdAt" });

    expect(mocks.searchAdminBusinesses).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        query: undefined,
        limit: 25,
        orderBy: "createdAt",
      }),
    );
  });

  it("trims business search queries and clamps the limit before calling the DAO", async () => {
    const db = {} as D1Database;
    await searchAdminBusinesses(db, { query: "  acme  ", limit: 999, orderBy: "name" });

    expect(mocks.searchAdminBusinesses).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        query: "acme",
        limit: 200,
        orderBy: "name",
      }),
    );
  });
});
