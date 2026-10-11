import { describe, expect, it, vi } from "vitest";

import {
  buildRepoGuessSystemPrompt,
  buildRepoGuessUserPrompt,
  guessRepoFromTextContext,
  type RepoCandidate,
  validateRepoClassification,
} from "../../shared/repo-resolution";

const CANDIDATES: RepoCandidate[] = [
  { repoOwner: "acme", repoName: "widgets" },
  { repoOwner: "acme", repoName: "billing-api" },
  { repoOwner: "tools", repoName: "cycloid" },
];

describe("repo resolution", () => {
  it("matches an explicit owner/repo mention without calling the model", async () => {
    const classify = vi.fn();

    const result = await guessRepoFromTextContext({
      context: {
        source: "slack",
        triggerText: "Please inspect acme/widgets and fix the flaky test.",
      },
      candidates: CANDIDATES,
      classify,
    });

    expect(result).toMatchObject({
      status: "matched",
      repoOwner: "acme",
      repoName: "widgets",
      confidence: 1,
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it("matches a GitHub repository URL in surrounding context", async () => {
    const result = await guessRepoFromTextContext({
      context: {
        source: "slack",
        triggerText: "Please inspect https://github.com/acme/widgets for the failing build.",
      },
      candidates: CANDIDATES,
    });

    expect(result).toMatchObject({
      status: "matched",
      repoOwner: "acme",
      repoName: "widgets",
      confidence: 1,
    });
  });

  it("uses an exact channel-name match as a deterministic signal", async () => {
    const result = await guessRepoFromTextContext({
      context: {
        source: "slack",
        triggerText: "Can you inspect this production error?",
        channelName: "billing-api",
      },
      candidates: CANDIDATES,
    });

    expect(result).toMatchObject({
      status: "matched",
      repoOwner: "acme",
      repoName: "billing-api",
      confidence: 0.95,
    });
  });

  it("uses exact context name hints as deterministic signals", async () => {
    const classify = vi.fn();

    const result = await guessRepoFromTextContext({
      context: {
        source: "linear",
        triggerText: "Please investigate the failing Linear issue.",
        contextNameHints: ["Backend", "billing-api"],
      },
      candidates: CANDIDATES,
      classify,
    });

    expect(result).toMatchObject({
      status: "matched",
      repoOwner: "acme",
      repoName: "billing-api",
      confidence: 0.95,
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it("returns the deterministic no-match reason when no classifier is configured", async () => {
    const result = await guessRepoFromTextContext({
      context: {
        source: "slack",
        triggerText: "Please inspect why the session failed.",
      },
      candidates: CANDIDATES,
    });

    expect(result).toMatchObject({
      status: "unknown",
      confidence: 0,
      reason: "No deterministic repository match was found.",
    });
  });

  it("returns unknown when context name hints match multiple repositories", async () => {
    const classify = vi.fn();

    const result = await guessRepoFromTextContext({
      context: {
        source: "linear",
        triggerText: "Please investigate the failing Linear issue.",
        contextNameHints: ["widgets", "billing-api"],
      },
      candidates: CANDIDATES,
      classify,
    });

    expect(result).toMatchObject({
      status: "unknown",
      reason: "Context name hints matched more than one allowed repository name.",
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it("returns unknown when context mentions multiple allowed repositories", async () => {
    const classify = vi.fn().mockResolvedValue({
      status: "matched",
      repoOwner: "acme",
      repoName: "widgets",
      confidence: 0.99,
      reason: "The model tried to choose one.",
      candidates: [],
    });

    const result = await guessRepoFromTextContext({
      context: {
        source: "slack",
        triggerText: "Compare acme/widgets and acme/billing-api.",
      },
      candidates: CANDIDATES,
      classify,
    });

    expect(result).toMatchObject({
      status: "unknown",
      reason: "The context mentioned multiple allowed repositories.",
      candidates: [
        { repoOwner: "acme", repoName: "widgets" },
        { repoOwner: "acme", repoName: "billing-api" },
      ],
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it("returns unknown with candidates when text names multiple allowed repositories by repo name", async () => {
    const classify = vi.fn().mockResolvedValue({
      status: "matched",
      repoOwner: "tools",
      repoName: "cycloid",
      confidence: 0.99,
      reason: "The model tried to choose one.",
      candidates: [],
    });

    const result = await guessRepoFromTextContext({
      context: {
        source: "slack",
        triggerText: "I am not sure whether this belongs in widgets or billing-api.",
        metadata: {
          canonicalProductRepo: "trycycloid/control-plane",
          productRepoSignals: "repo inference",
        },
      },
      candidates: CANDIDATES,
      classify,
    });

    expect(result).toMatchObject({
      status: "unknown",
      reason: "The context mentioned multiple allowed repository names.",
      candidates: [
        { repoOwner: "acme", repoName: "widgets" },
        { repoOwner: "acme", repoName: "billing-api" },
      ],
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it("accepts a model match only when it is allowlisted and above threshold", () => {
    const result = validateRepoClassification(
      {
        status: "matched",
        repoOwner: "ACME",
        repoName: "widgets",
        confidence: 0.91,
        reason: "The thread is about widgets.",
        candidates: [],
      },
      CANDIDATES,
    );

    expect(result).toMatchObject({
      status: "matched",
      repoOwner: "acme",
      repoName: "widgets",
      confidence: 0.91,
    });
  });

  it("rejects low-confidence or non-allowlisted model matches", () => {
    expect(
      validateRepoClassification(
        {
          status: "matched",
          repoOwner: "acme",
          repoName: "widgets",
          confidence: 0.5,
          reason: "Maybe widgets.",
          candidates: [],
        },
        CANDIDATES,
      ),
    ).toMatchObject({
      status: "unknown",
      reason: "Model confidence was below the acceptance threshold.",
    });

    expect(
      validateRepoClassification(
        {
          status: "matched",
          repoOwner: "other",
          repoName: "secret-repo",
          confidence: 0.99,
          reason: "Invented repo.",
          candidates: [],
        },
        CANDIDATES,
      ),
    ).toMatchObject({
      status: "unknown",
      reason: "Model selected a repository outside the allowed list.",
    });
  });

  it("falls back to the model classifier when deterministic signals are absent", async () => {
    const classify = vi.fn().mockResolvedValue({
      status: "matched",
      repoOwner: "tools",
      repoName: "cycloid",
      confidence: 0.9,
      reason: "The text mentions Cycloid sessions.",
      candidates: [],
    });

    const result = await guessRepoFromTextContext({
      context: {
        source: "slack",
        triggerText: "Please inspect why the session failed.",
      },
      candidates: CANDIDATES,
      classify,
    });

    expect(classify).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: "matched",
      repoOwner: "tools",
      repoName: "cycloid",
    });
  });

  it("uses canonical product metadata when the model returns unknown for product behavior", async () => {
    const classify = vi.fn().mockResolvedValue({
      status: "unknown",
      repoOwner: "",
      repoName: "",
      confidence: 0,
      reason: "The user asks about repo inference but did not explicitly name a repo.",
      candidates: [],
    });

    const result = await guessRepoFromTextContext({
      context: {
        source: "slack",
        triggerText:
          "Inspect how Slack repo inference handles users with no default repo preference and summarize the relevant code path.",
        metadata: {
          applicationName: "Cycloid",
          canonicalProductRepo: "trycycloid/cycloid",
          productRepoSignals: "slack repo inference, repo inference, slack integration",
        },
      },
      candidates: [
        {
          repoOwner: "trycycloid",
          repoName: "cycloid",
          description: "Background coding-agent platform with Slack session entrypoints and repo inference.",
        },
        { repoOwner: "trycycloid", repoName: "marketing-site", description: "Public website." },
      ],
      classify,
    });

    expect(classify).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: "matched",
      repoOwner: "trycycloid",
      repoName: "cycloid",
      confidence: 0.91,
    });
  });

  it("keeps product metadata fallback behind the caller confidence threshold", async () => {
    const classify = vi.fn().mockResolvedValue({
      status: "unknown",
      repoOwner: "",
      repoName: "",
      confidence: 0,
      reason: "The user asks about repo inference but did not explicitly name a repo.",
      candidates: [],
    });

    const result = await guessRepoFromTextContext({
      context: {
        source: "slack",
        triggerText: "Inspect Slack repo inference.",
        metadata: {
          applicationName: "Cycloid",
          canonicalProductRepo: "trycycloid/cycloid",
          productRepoSignals: "slack repo inference",
        },
      },
      candidates: [
        {
          repoOwner: "trycycloid",
          repoName: "cycloid",
          description: "Background coding-agent platform with Slack session entrypoints and repo inference.",
        },
      ],
      classify,
      confidenceThreshold: 0.95,
    });

    expect(result).toMatchObject({
      status: "unknown",
      reason: "The user asks about repo inference but did not explicitly name a repo.",
    });
  });

  it("does not use application name metadata as a standalone fallback signal", async () => {
    const classify = vi.fn().mockResolvedValue({
      status: "unknown",
      repoOwner: "",
      repoName: "",
      confidence: 0,
      reason: "The user request is ambiguous.",
      candidates: [],
    });

    const result = await guessRepoFromTextContext({
      context: {
        source: "slack",
        triggerText: "Inspect the billing alert.",
        channelName: "cycloid-alerts",
        metadata: {
          applicationName: "Cycloid",
          canonicalProductRepo: "trycycloid/cycloid",
          productRepoSignals: "slack repo inference, repo inference, slack integration",
        },
      },
      candidates: [
        {
          repoOwner: "trycycloid",
          repoName: "cycloid",
          description: "Background coding-agent platform with Slack session entrypoints and repo inference.",
        },
        { repoOwner: "acme", repoName: "billing-api", description: "Billing alerts and invoices." },
      ],
      classify,
    });

    expect(result).toMatchObject({
      status: "unknown",
      reason: "The user request is ambiguous.",
    });
  });

  it("preserves unknown when the model reports a competing product candidate", async () => {
    const classify = vi.fn().mockResolvedValue({
      status: "unknown",
      repoOwner: "",
      repoName: "",
      confidence: 0,
      reason: "Multiple repositories could own Slack integration behavior.",
      candidates: [
        {
          repoOwner: "trycycloid",
          repoName: "cycloid",
          reason: "Canonical platform repository.",
        },
        {
          repoOwner: "trycycloid",
          repoName: "slack-integration",
          reason: "Repository name also matches Slack integration.",
        },
      ],
    });

    const result = await guessRepoFromTextContext({
      context: {
        source: "slack",
        triggerText: "Inspect the Slack integration behavior.",
        metadata: {
          applicationName: "Cycloid",
          canonicalProductRepo: "trycycloid/cycloid",
          productRepoSignals: "slack integration",
        },
      },
      candidates: [
        {
          repoOwner: "trycycloid",
          repoName: "cycloid",
          description: "Background coding-agent platform with Slack integrations.",
        },
        {
          repoOwner: "trycycloid",
          repoName: "slack-integration",
          description: "Standalone Slack integration service.",
        },
      ],
      classify,
    });

    expect(result).toMatchObject({
      status: "unknown",
      reason: "Multiple repositories could own Slack integration behavior.",
    });
  });

  it("gives the model candidate descriptions for semantic repo guesses", () => {
    const systemPrompt = buildRepoGuessSystemPrompt();
    const userPrompt = buildRepoGuessUserPrompt(
      {
        source: "slack",
        triggerText:
          "Inspect how Slack repo inference handles users with no default repo preference and summarize the relevant code path.",
        metadata: {
          applicationName: "Cycloid",
          canonicalProductRepo: "trycycloid/cycloid",
          productRepoSignals: "slack repo inference, repo inference, slack integration",
        },
      },
      [
        {
          repoOwner: "trycycloid",
          repoName: "cycloid",
          description: "Background coding-agent platform with Slack session entrypoints and repo inference.",
          url: "https://github.com/trycycloid/cycloid",
          private: true,
          defaultBranch: "main",
        },
        { repoOwner: "acme", repoName: "marketing-site", description: "Public website and landing pages." },
      ],
    );

    expect(systemPrompt).toContain("Make an educated guess");
    expect(systemPrompt).toContain("application's own behavior");
    expect(userPrompt).toContain('"fullName": "trycycloid/cycloid"');
    expect(userPrompt).toContain("Slack session entrypoints and repo inference");
    expect(userPrompt).toContain('"defaultBranch": "main"');
    expect(userPrompt).toContain('"canonicalProductRepo": "trycycloid/cycloid"');
    expect(userPrompt).toContain("Inspect how Slack repo inference");
  });
});
