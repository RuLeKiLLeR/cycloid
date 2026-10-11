import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEnsureRepoLabel = vi.hoisted(() => vi.fn());
const mockAddLabels = vi.hoisted(() => vi.fn());
const mockCreateInstallationToken = vi.hoisted(() => vi.fn());
const mockGetInstallationByOwner = vi.hoisted(() => vi.fn());

vi.mock("../../../apps/control-plane-worker/src/github/pr", () => ({
  ensureRepoLabel: (...args: unknown[]) => mockEnsureRepoLabel(...args),
  addLabels: (...args: unknown[]) => mockAddLabels(...args),
}));
vi.mock("../../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: (...args: unknown[]) => mockCreateInstallationToken(...args),
}));
vi.mock("../../../apps/control-plane-worker/src/github/installations-db", () => ({
  getInstallationByOwner: (...args: unknown[]) => mockGetInstallationByOwner(...args),
}));

import { E2E_TESTED_LABEL } from "../../../apps/control-plane-worker/src/constants/pr-labels";
import type { Logger } from "../../../apps/control-plane-worker/src/logger";
import { applyQaPassLabel } from "../../../apps/control-plane-worker/src/services/qa-pass-label";
import type { Env } from "../../../apps/control-plane-worker/src/types";

const env = { DB: {} } as Env;
const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as unknown as Logger;
const PR_URL = "https://github.com/acme/widgets/pull/42";

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureRepoLabel.mockResolvedValue({ ok: true, created: false });
  mockAddLabels.mockResolvedValue(undefined);
  mockCreateInstallationToken.mockResolvedValue("token");
  mockGetInstallationByOwner.mockResolvedValue({ installation_id: 99, suspended_at: null });
});

describe("applyQaPassLabel", () => {
  it("ensures create-only metadata and applies E2E-Tested using a matching installation hint", async () => {
    await applyQaPassLabel(env, {
      prUrl: PR_URL,
      sessionId: "session-1",
      installationId: 456,
      repoOwner: "acme",
      repoName: "widgets",
      logger,
    });

    expect(mockGetInstallationByOwner).not.toHaveBeenCalled();
    expect(mockCreateInstallationToken).toHaveBeenCalledWith(env, 456);
    expect(mockEnsureRepoLabel).toHaveBeenCalledWith(
      "token",
      "acme",
      "widgets",
      E2E_TESTED_LABEL,
      "0e8a16",
      "End-to-end tested",
      { updateOnDrift: false },
    );
    expect(mockAddLabels).toHaveBeenCalledWith("token", "acme", "widgets", 42, [E2E_TESTED_LABEL]);
  });

  it("falls back to the owner installation when the hint does not match the target repo", async () => {
    await applyQaPassLabel(env, {
      prUrl: PR_URL,
      sessionId: "session-1",
      installationId: 456,
      repoOwner: "other",
      repoName: "repo",
      logger,
    });

    expect(mockGetInstallationByOwner).toHaveBeenCalledWith(env.DB, "acme");
    expect(mockCreateInstallationToken).toHaveBeenCalledWith(env, 99);
    expect(mockAddLabels).toHaveBeenCalledOnce();
  });

  it("does not add when the label cannot be ensured", async () => {
    mockEnsureRepoLabel.mockResolvedValue({
      ok: false,
      reason: "permission_denied",
      status: 403,
      detail: "forbidden",
    });

    await expect(
      applyQaPassLabel(env, {
        prUrl: PR_URL,
        sessionId: "session-1",
        installationId: 456,
        repoOwner: "acme",
        repoName: "widgets",
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(mockAddLabels).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ prUrl: PR_URL, sessionId: "session-1", status: 403 }),
      "QA pass label ensure failed",
    );
  });

  it("swallows and warns on a GitHub write failure", async () => {
    mockAddLabels.mockRejectedValue(new Error("GitHub 503"));

    await expect(
      applyQaPassLabel(env, {
        prUrl: PR_URL,
        sessionId: "session-1",
        installationId: 456,
        repoOwner: "acme",
        repoName: "widgets",
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ prUrl: PR_URL, sessionId: "session-1", error: expect.stringContaining("503") }),
      "QA pass label apply failed",
    );
  });

  it("skips an invalid PR URL without throwing", async () => {
    await expect(
      applyQaPassLabel(env, {
        prUrl: "not-a-pr",
        sessionId: "session-1",
        installationId: null,
        repoOwner: null,
        repoName: null,
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(mockCreateInstallationToken).not.toHaveBeenCalled();
    expect(mockAddLabels).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      { prUrl: "not-a-pr", sessionId: "session-1" },
      "QA pass label skipped invalid PR URL",
    );
  });
});
