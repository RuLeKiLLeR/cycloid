import { beforeEach, describe, expect, it, vi } from "vitest";

const mockVerifyRepoAccessAndInstallation = vi.fn();
const mockNotifyUserBlocked = vi.fn();

vi.mock("../../apps/control-plane-worker/src/services/repo-gate", () => ({
  verifyRepoAccessAndInstallation: (...a: unknown[]) => mockVerifyRepoAccessAndInstallation(...a),
}));

vi.mock("../../apps/control-plane-worker/src/session/notify-user-blocked", () => ({
  notifyUserBlocked: (...a: unknown[]) => mockNotifyUserBlocked(...a),
}));

import {
  resolveAndRefreshSessionResumeAccess,
  type SessionRouteState,
} from "../../apps/control-plane-worker/src/routes/sessions";
import type { AuthInfo } from "../../apps/control-plane-worker/src/types";

const ENV = { DB: {} } as Parameters<typeof resolveAndRefreshSessionResumeAccess>[0];

function session(ownerUserId: string): SessionRouteState {
  return { ownerUserId, repoOwner: "acme", repoName: "repo" } as unknown as SessionRouteState;
}

function auth(userId: string): AuthInfo {
  return { userId, canAccessAllSessions: false } as unknown as AuthInfo;
}

function gateFailure(reason: string) {
  return { ok: false, reason, response: new Response("nope", { status: 403 }) };
}

describe("resolveAndRefreshSessionResumeAccess repo-access-denied DM", () => {
  beforeEach(() => {
    mockVerifyRepoAccessAndInstallation.mockReset();
    mockNotifyUserBlocked.mockReset();
  });

  it("DMs the owner when the owner themselves is denied repo access", async () => {
    mockVerifyRepoAccessAndInstallation.mockResolvedValueOnce(gateFailure("repo_access_denied"));

    const result = await resolveAndRefreshSessionResumeAccess(ENV, auth("101"), "sess-1", session("101"));

    expect(result.ok).toBe(false);
    expect(mockNotifyUserBlocked).toHaveBeenCalledTimes(1);
    expect(mockNotifyUserBlocked).toHaveBeenCalledWith(
      ENV,
      expect.objectContaining({
        sessionId: "sess-1",
        ownerUserId: 101,
        kind: "repo_access_denied",
        dedupKey: "sess-1",
      }),
    );
  });

  it("DMs the owner when a non-owner shared member is denied repo access", async () => {
    mockVerifyRepoAccessAndInstallation.mockResolvedValueOnce(gateFailure("repo_access_denied"));

    const result = await resolveAndRefreshSessionResumeAccess(ENV, auth("2"), "sess-1", session("101"));

    expect(result.ok).toBe(false);
    expect(mockNotifyUserBlocked).toHaveBeenCalledWith(
      ENV,
      expect.objectContaining({ ownerUserId: 101, kind: "repo_access_denied" }),
    );
  });

  it("does NOT DM for non-denial gate failures (install-missing / unverifiable)", async () => {
    for (const reason of ["installation_missing", "installation_suspended", "access_unverifiable"]) {
      mockNotifyUserBlocked.mockReset();
      mockVerifyRepoAccessAndInstallation.mockResolvedValueOnce(gateFailure(reason));

      const result = await resolveAndRefreshSessionResumeAccess(ENV, auth("101"), "sess-1", session("101"));

      expect(result.ok).toBe(false);
      expect(mockNotifyUserBlocked).not.toHaveBeenCalled();
    }
  });
});
