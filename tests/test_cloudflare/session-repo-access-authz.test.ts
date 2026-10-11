import { describe, expect, it } from "vitest";

import {
  authorizeSessionRepoAccess,
  type SessionRouteState,
} from "../../apps/control-plane-worker/src/routes/sessions";
import type { AuthInfo } from "../../apps/control-plane-worker/src/types";

// The null-repo branch short-circuits before any GitHub/DB call, so these
// fixtures only need the fields authorizeSessionRepoAccess reads.
const ENV = {} as Parameters<typeof authorizeSessionRepoAccess>[0];

function sessionWithoutRepo(ownerUserId: string): SessionRouteState {
  return { ownerUserId, repoOwner: null, repoName: null } as unknown as SessionRouteState;
}

function sharedMemberAuth(userId: string): AuthInfo {
  return {
    userId,
    canAccessAllSessions: false,
    user: {
      id: Number(userId.replace(/\D/g, "")) || 1,
      login: userId,
      name: null,
      email: `${userId}@example.com`,
      businessId: "biz-shared",
      sharedSessions: true,
      businessMemberIds: ["1", "2"],
    },
  } as unknown as AuthInfo;
}

describe("authorizeSessionRepoAccess null repo context", () => {
  it("fails closed with 404 for a non-owner shared-business member when repo context is missing", async () => {
    const result = await authorizeSessionRepoAccess(
      ENV,
      sharedMemberAuth("2"),
      "sess-null-repo",
      sessionWithoutRepo("99"),
      "access",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.response.status).toBe(404);
    }
  });

  it("still allows the owner through even when repo context is missing", async () => {
    const result = await authorizeSessionRepoAccess(
      ENV,
      sharedMemberAuth("42"),
      "sess-null-repo",
      sessionWithoutRepo("42"), // ownerUserId === auth.userId
      "access",
    );

    expect(result.ok).toBe(true);
  });

  it("still allows an all-session operator through even when repo context is missing", async () => {
    const auth = sharedMemberAuth("7");
    (auth as { canAccessAllSessions: boolean }).canAccessAllSessions = true;

    const result = await authorizeSessionRepoAccess(ENV, auth, "sess-null-repo", sessionWithoutRepo("99"), "access");

    expect(result.ok).toBe(true);
  });
});
