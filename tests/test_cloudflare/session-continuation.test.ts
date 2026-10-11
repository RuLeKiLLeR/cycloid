import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetchVerificationPrContext = vi.fn();
const mockQueryPlatformStructuredOutput = vi.fn();

vi.mock("../../apps/control-plane-worker/src/github/verification-pr-context", () => ({
  fetchVerificationPrContext: (...args: unknown[]) => mockFetchVerificationPrContext(...args),
}));

vi.mock("../../apps/control-plane-worker/src/services/platform-structured-output", () => ({
  queryPlatformStructuredOutput: (...args: unknown[]) => mockQueryPlatformStructuredOutput(...args),
}));

import {
  resolveSessionContinuation,
  SessionContinuationError,
} from "../../apps/control-plane-worker/src/services/session-continuation";
import type { Env } from "../../apps/control-plane-worker/src/types";
import { OpenAIModel } from "../../shared/constants/models";

const env = {} as Pick<Env, "DB" | "GITHUB_APP_ID" | "GITHUB_PRIVATE_KEY" | "REPOS_CACHE" | "ARCANIST_OPENAI_API_KEY">;

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const openPrContext = {
  prUrl: "https://github.com/trycycloid/cycloid/pull/123",
  owner: "trycycloid",
  repo: "cycloid",
  number: 123,
  title: "Continue PR",
  body: null,
  state: "open",
  draft: false,
  mergeable: null,
  mergeStateStatus: null,
  labels: [],
  headRef: "feature/continue-pr",
  headSha: "abc123",
  headRepoOwner: "trycycloid",
  headRepoName: "cycloid",
  baseRef: "main",
  authorLogin: "maya",
  files: [],
  commits: [],
  checksSummary: "",
  vercelDeployPreview: null,
  recentDiscussion: [],
  fetchWarnings: [],
};

describe("resolveSessionContinuation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchVerificationPrContext.mockResolvedValue(openPrContext);
    mockQueryPlatformStructuredOutput.mockResolvedValue({ shouldContinue: false, selectedPrUrl: null });
  });

  it("adopts an explicit continuation PR without classifying prompt intent", async () => {
    const resolved = await resolveSessionContinuation({
      env,
      sessionId: "sess-1",
      prompt: "finish this PR",
      continuePrUrl: "https://github.com/trycycloid/cycloid/pull/123",
      repoContext: { repoOwner: "trycycloid", repoName: "cycloid" },
      installationId: 99,
      allowPromptInference: true,
      logger,
    });

    expect(mockQueryPlatformStructuredOutput).not.toHaveBeenCalled();
    expect(mockFetchVerificationPrContext).toHaveBeenCalledWith(
      env,
      "https://github.com/trycycloid/cycloid/pull/123",
      expect.objectContaining({
        installationId: 99,
        repoOwner: "trycycloid",
        repoName: "cycloid",
        requireRepoMatch: true,
      }),
    );
    expect(resolved).toMatchObject({
      repoContext: {
        repoOwner: "trycycloid",
        repoName: "cycloid",
        baseBranch: "main",
        startBranch: "feature/continue-pr",
      },
      targetPrUrl: "https://github.com/trycycloid/cycloid/pull/123",
      prUrl: "https://github.com/trycycloid/cycloid/pull/123",
      prNumber: 123,
      adoptedPrMetadata: {
        prUrl: "https://github.com/trycycloid/cycloid/pull/123",
        prNumber: 123,
        prDraft: false,
        publishedBranch: "feature/continue-pr",
        headSha: "abc123",
      },
    });
  });

  it("uses the LLM-selected PR URL for prompt-inferred continuation", async () => {
    mockQueryPlatformStructuredOutput.mockResolvedValueOnce({
      shouldContinue: true,
      selectedPrUrl: "https://github.com/trycycloid/cycloid/pull/123",
    });

    const resolved = await resolveSessionContinuation({
      env,
      sessionId: "sess-2",
      prompt:
        "finish this PR https://github.com/trycycloid/cycloid/pull/123 and compare with https://github.com/trycycloid/cycloid/pull/124",
      repoContext: { repoOwner: "trycycloid", repoName: "cycloid" },
      installationId: 99,
      allowPromptInference: true,
      logger,
    });

    expect(mockQueryPlatformStructuredOutput).toHaveBeenCalledTimes(1);
    expect(mockQueryPlatformStructuredOutput.mock.calls[0]?.[1]).toMatchObject({
      model: OpenAIModel.GPT54Mini,
    });
    expect(mockFetchVerificationPrContext).toHaveBeenCalledWith(
      env,
      "https://github.com/trycycloid/cycloid/pull/123",
      expect.anything(),
    );
    expect(resolved.prUrl).toBe("https://github.com/trycycloid/cycloid/pull/123");
  });

  it("does not continue when the LLM classifies PR URLs as reference-only", async () => {
    const resolved = await resolveSessionContinuation({
      env,
      sessionId: "sess-3",
      prompt: "use https://github.com/trycycloid/cycloid/pull/123 as reference material",
      repoContext: { repoOwner: "trycycloid", repoName: "cycloid" },
      installationId: 99,
      allowPromptInference: true,
      logger,
    });

    expect(mockQueryPlatformStructuredOutput).toHaveBeenCalledTimes(1);
    expect(mockFetchVerificationPrContext).not.toHaveBeenCalled();
    expect(resolved).toMatchObject({
      targetPrUrl: null,
      prUrl: null,
      prNumber: null,
      adoptedPrMetadata: null,
    });
  });

  it("falls back to no continuation when prompt-inferred continuation intent classification fails", async () => {
    mockQueryPlatformStructuredOutput.mockRejectedValueOnce(new Error("provider timeout"));

    const resolved = await resolveSessionContinuation({
      env,
      sessionId: "sess-3b",
      prompt: "finish this PR https://github.com/trycycloid/cycloid/pull/123",
      repoContext: { repoOwner: "trycycloid", repoName: "cycloid" },
      installationId: 99,
      allowPromptInference: true,
      logger,
    });

    expect(resolved).toMatchObject({
      targetPrUrl: null,
      prUrl: null,
      prNumber: null,
      adoptedPrMetadata: null,
    });
    expect(mockFetchVerificationPrContext).not.toHaveBeenCalled();
  });

  it("treats null and empty continueMode as absent when no PR is selected", async () => {
    const nullMode = await resolveSessionContinuation({
      env,
      sessionId: "sess-4a",
      prompt: "fix the bug",
      continueMode: null,
      repoContext: { repoOwner: "trycycloid", repoName: "cycloid" },
      installationId: 99,
      allowPromptInference: true,
      logger,
    });
    const emptyMode = await resolveSessionContinuation({
      env,
      sessionId: "sess-4b",
      prompt: "fix the bug",
      continueMode: "",
      repoContext: { repoOwner: "trycycloid", repoName: "cycloid" },
      installationId: 99,
      allowPromptInference: true,
      logger,
    });

    expect(nullMode.adoptedPrMetadata).toBeNull();
    expect(emptyMode.adoptedPrMetadata).toBeNull();
    expect(mockFetchVerificationPrContext).not.toHaveBeenCalled();
  });

  it("starts from the PR head without adopting publish metadata in new-pr mode", async () => {
    const resolved = await resolveSessionContinuation({
      env,
      sessionId: "sess-4",
      prompt: "finish this PR",
      continuePrUrl: "https://github.com/trycycloid/cycloid/pull/123",
      continueMode: "new-pr",
      repoContext: { repoOwner: "trycycloid", repoName: "cycloid" },
      installationId: 99,
      allowPromptInference: true,
      logger,
    });

    expect(resolved).toMatchObject({
      repoContext: expect.objectContaining({ startBranch: "feature/continue-pr" }),
      targetPrUrl: "https://github.com/trycycloid/cycloid/pull/123",
      prUrl: null,
      prNumber: null,
      adoptedPrMetadata: null,
    });
  });

  it("rejects explicit continuation when the requested start branch differs from the PR head", async () => {
    await expect(
      resolveSessionContinuation({
        env,
        sessionId: "sess-5",
        prompt: "finish this PR",
        continuePrUrl: "https://github.com/trycycloid/cycloid/pull/123",
        repoContext: { repoOwner: "trycycloid", repoName: "cycloid" },
        installationId: 99,
        startBranch: "feature/other",
        allowPromptInference: true,
        logger,
      }),
    ).rejects.toMatchObject({
      name: "SessionContinuationError",
      status: 400,
      reasonCode: "start_branch_mismatch",
    } satisfies Partial<SessionContinuationError>);
  });
});
