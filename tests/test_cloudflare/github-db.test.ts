import { describe, expect, it } from "vitest";

import { getUserGitIdentity } from "../../apps/control-plane-worker/src/github/db";

function mockDb(row: Record<string, unknown> | null) {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => row,
      }),
    }),
  } as unknown as D1Database;
}

describe("getUserGitIdentity", () => {
  it("returns login, name, and email when all exist", async () => {
    const result = await getUserGitIdentity(
      mockDb({ login: "jdoe", name: "Jane Doe", email: "jane@example.com" }),
      "1",
    );
    expect(result).toEqual({ login: "jdoe", name: "Jane Doe", email: "jane@example.com" });
  });

  it("falls back to login when name is null", async () => {
    const result = await getUserGitIdentity(mockDb({ login: "jdoe", name: null, email: "jane@example.com" }), "1");
    expect(result).toEqual({ login: "jdoe", name: "jdoe", email: "jane@example.com" });
  });

  it("falls back to noreply email when email is null", async () => {
    const result = await getUserGitIdentity(
      mockDb({ github_id: 12345, login: "jdoe", name: "Jane", email: null }),
      "1",
    );
    expect(result).toEqual({ login: "jdoe", name: "Jane", email: "12345+jdoe@users.noreply.github.com" });
  });

  it("falls back to legacy noreply email when github id is unavailable", async () => {
    const result = await getUserGitIdentity(mockDb({ github_id: null, login: "jdoe", name: "Jane", email: null }), "1");
    expect(result).toEqual({ login: "jdoe", name: "Jane", email: "jdoe@users.noreply.github.com" });
  });

  it("falls back to defaults when both name and login are null", async () => {
    const result = await getUserGitIdentity(mockDb({ login: null, name: null, email: null }), "1");
    expect(result).toEqual({ login: null, name: "Cycloid User", email: "bot@trycycloid.com" });
  });

  it("returns null when user not found", async () => {
    const result = await getUserGitIdentity(mockDb(null), "999");
    expect(result).toBeNull();
  });
});
