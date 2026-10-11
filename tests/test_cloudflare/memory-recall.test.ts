import { describe, expect, it } from "vitest";

import { rankRepoMemoryRecallCandidates } from "../../apps/control-plane-worker/src/memory/recall";

describe("repo memory recall ranking", () => {
  it("uses deterministic structured channels instead of provider ranking", async () => {
    await expect(
      rankRepoMemoryRecallCandidates({
        repoOwner: null,
        repoName: null,
        intent: "Plan a queue consumer",
        files: ["wrangler.toml"],
        symbols: ["queue"],
        tool: null,
        sourcePrNumbers: [],
        sourceSessionIds: [],
        memories: [
          {
            id: "mem-queue",
            level: "tactical",
            primitive: "procedure",
            authority: "accepted",
            enforcement: "none",
            applies_to: ["wrangler.toml"],
            candidate_channels: ["path_match", "symbol_match"],
            content: "Use the shared queue dispatcher.",
          },
        ],
      }),
    ).resolves.toMatchObject({
      rankings: [
        {
          id: "mem-queue",
          score: 1,
          reason: expect.stringContaining("path_match"),
          expected_effect: "Check the memory before editing the matched path.",
        },
      ],
      retrievalTrace: {
        retrievalConfigVersion: "repo-memory-structured-v6-pr-reference",
        candidateCount: 1,
        selectedCount: 1,
        returnedEmpty: false,
        selectedCandidates: [
          expect.objectContaining({
            memoryId: "mem-queue",
            candidateChannels: expect.arrayContaining(["path_match"]),
            bridgeCandidateChannels: expect.arrayContaining(["path_match", "symbol_match"]),
            pathMatches: [expect.objectContaining({ kind: "exact_file" })],
            actionSurface: expect.objectContaining({ compatible: true }),
            decision: "selected",
          }),
        ],
      },
    });
  });

  it("does not treat broad task text overlap as a concrete symbol match", async () => {
    await expect(
      rankRepoMemoryRecallCandidates({
        repoOwner: null,
        repoName: null,
        intent: "Fix the Datadog sparse counter monitor alert.",
        files: [],
        symbols: [],
        tool: null,
        sourcePrNumbers: [],
        sourceSessionIds: [],
        memories: [
          {
            id: "mem-sandbox-telemetry",
            subjects: ["datadog", "monitor"],
            tags: ["sandbox", "telemetry"],
            candidate_channels: ["text_retrieval"],
            content: "Sandbox Datadog monitor telemetry should attribute disconnect spans to the runtime provider.",
          },
        ],
      }),
    ).resolves.toMatchObject({
      rankings: [],
      retrievalTrace: {
        returnedEmpty: true,
        rejectedCandidates: [
          expect.objectContaining({
            memoryId: "mem-sandbox-telemetry",
            rejectReason: "same_domain_wrong_mechanism",
          }),
        ],
      },
    });
  });

  it("rejects bridge text-retrieval memories that only have weak text overlap", async () => {
    await expect(
      rankRepoMemoryRecallCandidates({
        repoOwner: null,
        repoName: null,
        intent: "Inspect review epoch bot retry flow.",
        files: [],
        symbols: [],
        tool: null,
        sourcePrNumbers: [],
        sourceSessionIds: [],
        memories: [
          {
            id: "mem-weak-text-only",
            candidate_channels: ["text_retrieval"],
            content: "Review epoch bot retry guidance belongs to a different workflow.",
          },
        ],
      }),
    ).resolves.toMatchObject({
      rankings: [],
      retrievalTrace: {
        returnedEmpty: true,
        rejectedCandidates: [
          expect.objectContaining({
            memoryId: "mem-weak-text-only",
            candidateChannels: expect.arrayContaining(["fts_match"]),
            matchedTerms: expect.objectContaining({ text: ["review", "epoch", "bot", "retry"] }),
            rejectReason: "weak_text_only_match",
          }),
        ],
      },
    });
  });

  it("does not treat generic error words as a strong error fingerprint", async () => {
    await expect(
      rankRepoMemoryRecallCandidates({
        repoOwner: null,
        repoName: null,
        intent: "Fix missing paused sandbox runtime error after a failure.",
        files: [],
        symbols: [],
        tool: null,
        sourcePrNumbers: [],
        sourceSessionIds: [],
        memories: [
          {
            id: "mem-structured-output",
            content:
              "When a reconciliation sweep sees StructuredOutputError provider failures, skip retryable transport errors.",
          },
        ],
      }),
    ).resolves.toMatchObject({
      rankings: [],
      retrievalTrace: {
        returnedEmpty: true,
        rejectedCandidates: [
          expect.objectContaining({
            memoryId: "mem-structured-output",
            candidateChannels: expect.not.arrayContaining(["error_fingerprint"]),
          }),
        ],
      },
    });
  });

  it("promotes bridge text-retrieval candidates with several distinctive matched terms", async () => {
    await expect(
      rankRepoMemoryRecallCandidates({
        repoOwner: null,
        repoName: null,
        intent: "Rekey human review-loop epoch bot wave insert retry path.",
        files: [],
        symbols: [],
        tool: null,
        sourcePrNumbers: [],
        sourceSessionIds: [],
        memories: [
          {
            id: "mem-review-loop-epoch",
            candidate_channels: ["text_retrieval"],
            content:
              "When a human review must start a new wave from a frozen bot epoch, keep the human wave on a human-only epoch key and reuse the re-keyed input for retry.",
          },
        ],
      }),
    ).resolves.toMatchObject({
      rankings: [expect.objectContaining({ id: "mem-review-loop-epoch" })],
      retrievalTrace: {
        returnedEmpty: false,
        selectedCandidates: [
          expect.objectContaining({
            memoryId: "mem-review-loop-epoch",
            candidateChannels: expect.arrayContaining(["fts_match"]),
          }),
        ],
      },
    });
  });

  it("keeps compatible same-source siblings when an explicit source artifact is focused", async () => {
    await expect(
      rankRepoMemoryRecallCandidates({
        repoOwner: null,
        repoName: null,
        intent:
          "Fix dogfood startup so runtime env and D1 bootstrap share the OpenAI credential source; startup scripts must handle quoted secrets.",
        files: [],
        symbols: [],
        tool: null,
        sourcePrNumbers: [4946],
        sourceSessionIds: [],
        memories: [
          {
            id: "mem-prior-strong",
            source_pr_number: 4946,
            candidate_channels: ["text_retrieval"],
            content:
              "Dogfood runtime env and D1 bootstrap must share the same OpenAI credential source for local full-stack startup.",
          },
          {
            id: "mem-prior-sibling",
            source_pr_number: 4946,
            candidate_channels: ["text_retrieval"],
            content: "Startup scripts must not line-parse quoted or multiline secrets.",
          },
        ],
      }),
    ).resolves.toMatchObject({
      rankings: [
        expect.objectContaining({ id: "mem-prior-strong" }),
        expect.objectContaining({ id: "mem-prior-sibling" }),
      ],
      retrievalTrace: {
        selectedCount: 2,
        selectedCandidates: [
          expect.objectContaining({ memoryId: "mem-prior-strong", sourceArtifactId: "pr:4946" }),
          expect.objectContaining({ memoryId: "mem-prior-sibling", sourceArtifactId: "pr:4946" }),
        ],
      },
    });
  });

  it("uses plain PR number references as exact source artifact evidence", async () => {
    await expect(
      rankRepoMemoryRecallCandidates({
        repoOwner: null,
        repoName: null,
        intent: "Verify PR #4533 and run the repo checks.",
        files: [],
        symbols: [],
        tool: null,
        sourcePrNumbers: [],
        sourceSessionIds: [],
        memories: [
          {
            id: "mem-pr-4533-a",
            source_pr_number: 4533,
            candidate_channels: ["text_retrieval"],
            content: "Use here-strings instead of echo pipes under pipefail in migration scripts.",
          },
          {
            id: "mem-pr-4912-noise",
            source_pr_number: 4912,
            candidate_channels: ["text_retrieval"],
            content: "General GitHub checks should pass before merging.",
          },
        ],
      }),
    ).resolves.toMatchObject({
      rankings: [expect.objectContaining({ id: "mem-pr-4533-a" })],
      retrievalTrace: {
        structuredSignals: expect.objectContaining({ prNumbers: [4533] }),
        selectedCandidates: [
          expect.objectContaining({
            memoryId: "mem-pr-4533-a",
            candidateChannels: expect.arrayContaining(["exact_identifier"]),
            sourceArtifactId: "pr:4533",
          }),
        ],
      },
    });
  });

  it("does not exact-match cross-repo GitHub pull URL references with the same PR number", async () => {
    const memory = {
      id: "mem-pr-4533-current-repo",
      source_pr_number: 4533,
      candidate_channels: ["text_retrieval"],
      content: "Use here-strings instead of echo pipes under pipefail in migration scripts.",
    };

    await expect(
      rankRepoMemoryRecallCandidates({
        repoOwner: "trycycloid",
        repoName: "cycloid",
        intent: "Review https://github.com/other/repo/pull/4533 before making the related fix.",
        files: [],
        symbols: [],
        tool: null,
        sourcePrNumbers: [],
        sourceSessionIds: [],
        memories: [memory],
      }),
    ).resolves.toMatchObject({
      rankings: [],
      retrievalTrace: {
        structuredSignals: expect.objectContaining({
          prNumbers: [4533],
          prUrls: ["https://github.com/other/repo/pull/4533"],
        }),
        returnedEmpty: true,
        rejectedCandidates: [
          expect.objectContaining({
            memoryId: "mem-pr-4533-current-repo",
            candidateChannels: expect.not.arrayContaining(["exact_identifier"]),
          }),
        ],
      },
    });
    await expect(
      rankRepoMemoryRecallCandidates({
        repoOwner: null,
        repoName: null,
        intent: "Review https://github.com/other/repo/pull/4533 before making the related fix.",
        files: [],
        symbols: [],
        tool: null,
        sourcePrNumbers: [],
        sourceSessionIds: [],
        memories: [memory],
      }),
    ).resolves.toMatchObject({
      rankings: [],
      retrievalTrace: {
        returnedEmpty: true,
        rejectedCandidates: [
          expect.objectContaining({
            memoryId: "mem-pr-4533-current-repo",
            candidateChannels: expect.not.arrayContaining(["exact_identifier"]),
          }),
        ],
      },
    });
  });

  it("does not let a plain PR number override a cross-repo pull request URL", async () => {
    await expect(
      rankRepoMemoryRecallCandidates({
        repoOwner: "trycycloid",
        repoName: "cycloid",
        intent: "Review https://github.com/other/repo/pull/4533 and compare it with PR #4533.",
        files: [],
        symbols: [],
        tool: null,
        sourcePrNumbers: [],
        sourceSessionIds: [],
        memories: [
          {
            id: "mem-pr-4533-current-repo-plain-fallback",
            source_pr_number: 4533,
            candidate_channels: ["text_retrieval"],
            content: "Use here-strings instead of echo pipes under pipefail in migration scripts.",
          },
        ],
      }),
    ).resolves.toMatchObject({ rankings: [], retrievalTrace: { returnedEmpty: true } });
  });

  it("requires inferred same-source siblings to clear the normal threshold", async () => {
    await expect(
      rankRepoMemoryRecallCandidates({
        repoOwner: null,
        repoName: null,
        intent:
          "Fix dogfood startup so runtime env and D1 bootstrap share the OpenAI credential source; startup scripts must handle quoted secrets.",
        files: [],
        symbols: [],
        tool: null,
        sourcePrNumbers: [],
        sourceSessionIds: [],
        memories: [
          {
            id: "mem-prior-strong",
            source_pr_number: 4946,
            candidate_channels: ["text_retrieval"],
            content:
              "Dogfood runtime env and D1 bootstrap must share the same OpenAI credential source for local full-stack startup.",
          },
          {
            id: "mem-prior-sibling",
            source_pr_number: 4946,
            candidate_channels: ["text_retrieval"],
            content: "Startup scripts must not line-parse quoted or multiline secrets.",
          },
        ],
      }),
    ).resolves.toMatchObject({
      rankings: [expect.objectContaining({ id: "mem-prior-strong" })],
      retrievalTrace: {
        selectedCount: 1,
        selectedCandidates: [expect.objectContaining({ memoryId: "mem-prior-strong", sourceArtifactId: "pr:4946" })],
        rejectedCandidates: [expect.objectContaining({ memoryId: "mem-prior-sibling" })],
      },
    });
  });

  it("uses exact source artifact evidence to suppress same-file memories from other PRs", async () => {
    await expect(
      rankRepoMemoryRecallCandidates({
        repoOwner: null,
        repoName: null,
        intent: "Fix PR 4771 memory ingestion links in refine.ts.",
        files: ["apps/control-plane-worker/src/company-memory/refine.ts"],
        symbols: ["parseRefineOutput"],
        tool: null,
        sourcePrNumbers: [4771],
        sourceSessionIds: [],
        memories: [
          {
            id: "mem-pr-4771-a",
            source_pr_number: 4771,
            applies_to: ["apps/control-plane-worker/src/company-memory/refine.ts"],
            content: "For this PR, reject empty-title memory entities before links are written.",
          },
          {
            id: "mem-pr-4771-b",
            source_pr_number: 4771,
            applies_to: ["apps/control-plane-worker/src/company-memory/refine.ts"],
            content: "For this PR, surface dropped links during refine output parsing.",
          },
          {
            id: "mem-pr-5249-same-file",
            source_pr_number: 5249,
            applies_to: ["apps/control-plane-worker/src/company-memory/refine.ts"],
            content: "A prior refine.ts change handled unrelated LLM output ordering.",
          },
        ],
      }),
    ).resolves.toMatchObject({
      rankings: [expect.objectContaining({ id: "mem-pr-4771-a" }), expect.objectContaining({ id: "mem-pr-4771-b" })],
      retrievalTrace: {
        selectedCandidates: [
          expect.objectContaining({ memoryId: "mem-pr-4771-a", sourceArtifactId: "pr:4771" }),
          expect.objectContaining({ memoryId: "mem-pr-4771-b", sourceArtifactId: "pr:4771" }),
        ],
        rejectedCandidates: [
          expect.objectContaining({
            memoryId: "mem-pr-5249-same-file",
            rejectReason: "same_subsystem_wrong_mechanism",
          }),
        ],
      },
    });
  });

  it("does not let sibling cluster size suppress the best evidenced source memory", async () => {
    await expect(
      rankRepoMemoryRecallCandidates({
        repoOwner: null,
        repoName: null,
        intent:
          "Fix flaky env-inheritance in tests/test_sandbox-e2b/start-bridge.test.ts where real ARCANIST_TOKEN leaks into child process; audit baseEnv and sibling tests for same hazard.",
        files: ["tests/test_sandbox-e2b/start-bridge.test.ts", "apps/sandbox-e2b/start-bridge.sh"],
        symbols: ["baseEnv", "start-bridge.sh"],
        tool: null,
        sourcePrNumbers: [],
        sourceSessionIds: [],
        memories: [
          {
            id: "mem-pr-4593",
            source_pr_number: 4593,
            applies_to: ["tests/test_sandbox-e2b/start-bridge.test.ts"],
            symbols: ["baseEnv"],
            candidate_channels: ["path_match", "symbol_match", "text_retrieval"],
            content: "When testing start-bridge env isolation, scrub real ARCANIST_TOKEN from baseEnv before spawning.",
          },
          {
            id: "mem-pr-4889-a",
            source_pr_number: 4889,
            applies_to: ["apps/sandbox-e2b/start-bridge.sh"],
            symbols: ["start-bridge.sh"],
            candidate_channels: ["path_match", "text_retrieval"],
            content: "When persisting sandbox CLI credentials, delay writing the auth file until startup is ready.",
          },
          {
            id: "mem-pr-4889-b",
            source_pr_number: 4889,
            applies_to: ["tests/test_sandbox-e2b/start-bridge.test.ts", "apps/sandbox-e2b/start-bridge.sh"],
            candidate_channels: ["path_match"],
            content: "When persisting sandbox CLI auth to disk, write the credential file atomically.",
          },
          {
            id: "mem-pr-4889-c",
            source_pr_number: 4889,
            applies_to: ["tests/test_sandbox-e2b/start-bridge.test.ts", "apps/sandbox-e2b/start-bridge.sh"],
            symbols: ["start-bridge.sh"],
            candidate_channels: ["path_match", "text_retrieval"],
            content: "If setup runs in the same user context as start-bridge, avoid credential timing races.",
          },
        ],
      }),
    ).resolves.toMatchObject({
      rankings: [expect.objectContaining({ id: "mem-pr-4593" })],
      retrievalTrace: {
        selectedCandidates: [
          expect.objectContaining({
            memoryId: "mem-pr-4593",
            sourceArtifactId: "pr:4593",
            matchedTerms: expect.objectContaining({ symbol: ["base", "env"] }),
          }),
        ],
        rejectedCandidates: expect.arrayContaining([
          expect.objectContaining({
            memoryId: "mem-pr-4889-a",
            rejectReason: "same_subsystem_wrong_mechanism",
          }),
        ]),
      },
    });
  });

  it("rejects exact path memories without enough task-text support", async () => {
    await expect(
      rankRepoMemoryRecallCandidates({
        repoOwner: null,
        repoName: null,
        intent:
          "Investigate and fix intent mismatch context degradation when the VA comment body is capped; follow ARC-1235 guidance.",
        files: [
          ".cycloid/agent-profiles/investigate-incident.md",
          "tests/test_agent/constants.test.ts",
          "apps/ui/src/api/sessions.ts",
          "apps/ui/src/components/sessionheader.tsx",
          "apps/ui/src/types.ts",
          "apps/control-plane-worker/src/integrations/runtime.ts",
          "tests/test_cloudflare/integration-runtime.test.ts",
          "apps/control-plane-worker/src/sandbox/undersize-notify.ts",
          "apps/control-plane-worker/src/slack/internal-alerts.ts",
          "tests/test_cloudflare/undersize-notify.test.ts",
          "apps/control-plane-worker/src/webhooks/prompts.ts",
        ],
        symbols: [],
        tool: null,
        sourcePrNumbers: [],
        sourceSessionIds: [],
        memories: [
          {
            id: "mem-prompt-profile",
            source_pr_number: 6103,
            applies_to: [".cycloid/agent-profiles/investigate-incident.md"],
            content:
              "When editing a shared prompt/template, document every rendered contract field and pin the wording in a test.",
          },
          {
            id: "mem-intent-mismatch",
            source_pr_number: 4969,
            candidate_channels: ["text_retrieval"],
            content:
              "If a VA verification comment can be capped, do not reconstruct intent-mismatch context from the truncated body.",
          },
        ],
      }),
    ).resolves.toMatchObject({
      rankings: [expect.objectContaining({ id: "mem-intent-mismatch" })],
      retrievalTrace: {
        rejectedCandidates: expect.arrayContaining([
          expect.objectContaining({
            memoryId: "mem-prompt-profile",
            rejectReason: "weak_path_only",
          }),
        ]),
      },
    });
  });

  it("does not score spoofed bridge candidate channels as proof", async () => {
    await expect(
      rankRepoMemoryRecallCandidates({
        repoOwner: null,
        repoName: null,
        intent: "Fix sparse counter Datadog monitor handling.",
        files: ["infra/datadog-monitors.tf"],
        symbols: [],
        tool: null,
        sourcePrNumbers: [],
        sourceSessionIds: [],
        memories: [
          {
            id: "mem-spoofed",
            candidate_channels: ["path_match", "symbol_match"],
            applies_to: ["apps/sandbox-bridge/src/**"],
            subjects: ["datadog"],
            content: "Sandbox telemetry should tag provider attribution for Datadog traces.",
          },
        ],
      }),
    ).resolves.toMatchObject({
      rankings: [],
      retrievalTrace: {
        returnedEmpty: true,
        rejectedCandidates: [
          expect.objectContaining({
            memoryId: "mem-spoofed",
            bridgeCandidateChannels: ["path_match", "symbol_match"],
            candidateChannels: expect.not.arrayContaining(["path_match", "symbol_match"]),
          }),
        ],
      },
    });
  });

  it("prefers exact file path evidence over broad directory evidence", async () => {
    await expect(
      rankRepoMemoryRecallCandidates({
        repoOwner: null,
        repoName: null,
        intent: "Fix queued prompt ordering in prompt-queue.",
        files: ["apps/control-plane-worker/src/session/prompt-queue.ts"],
        symbols: [],
        tool: null,
        sourcePrNumbers: [],
        sourceSessionIds: [],
        memories: [
          {
            id: "mem-broad",
            applies_to: ["apps/control-plane-worker/src"],
            content: "Use general control-plane worker conventions.",
          },
          {
            id: "mem-exact",
            applies_to: ["apps/control-plane-worker/src/session/prompt-queue.ts"],
            content: "Prompt queue ordering changes must preserve FIFO behavior.",
          },
        ],
      }),
    ).resolves.toMatchObject({
      rankings: [expect.objectContaining({ id: "mem-exact" })],
      retrievalTrace: {
        selectedCandidates: [expect.objectContaining({ memoryId: "mem-exact" })],
      },
    });
  });

  it("keeps bridge-passed tool-trigger memories in the trace via exact trigger matching", async () => {
    await expect(
      rankRepoMemoryRecallCandidates({
        repoOwner: null,
        repoName: null,
        intent: "Run the Braintrust tool to inspect experiment failures.",
        files: [],
        symbols: [],
        tool: "braintrust.query_sql",
        sourcePrNumbers: [],
        sourceSessionIds: [],
        memories: [
          {
            id: "mem-tool-trigger",
            candidate_channels: ["tool_trigger_match"],
            triggers: {
              tools: ["braintrust.query_sql"],
            },
            content: "Prefer the saved Braintrust query pattern for experiment failure inspection.",
          },
        ],
      }),
    ).resolves.toMatchObject({
      rankings: [expect.objectContaining({ id: "mem-tool-trigger" })],
      retrievalTrace: {
        returnedEmpty: false,
        selectedCandidates: [
          expect.objectContaining({
            memoryId: "mem-tool-trigger",
            candidateChannels: expect.arrayContaining(["tool_or_command_match"]),
            bridgeCandidateChannels: ["tool_trigger_match"],
            matchedTerms: expect.objectContaining({ tool: ["braintrust.query_sql"] }),
          }),
        ],
        rejectedCandidates: [],
      },
    });
  });

  it("uses exact mcp tool triggers in control-plane recall scoring", async () => {
    await expect(
      rankRepoMemoryRecallCandidates({
        repoOwner: null,
        repoName: null,
        intent: "Inspect failed experiments with Braintrust.",
        files: [],
        symbols: [],
        tool: "braintrust.query_sql",
        sourcePrNumbers: [],
        sourceSessionIds: [],
        memories: [
          {
            id: "mem-mcp-tool-trigger",
            candidate_channels: ["tool_trigger_match"],
            triggers: {
              mcp_tools: ["braintrust.query_sql"],
            },
            content: "Use the saved Braintrust experiment query before inventing a new one.",
          },
        ],
      }),
    ).resolves.toMatchObject({
      rankings: [expect.objectContaining({ id: "mem-mcp-tool-trigger" })],
      retrievalTrace: {
        selectedCandidates: [
          expect.objectContaining({
            memoryId: "mem-mcp-tool-trigger",
            candidateChannels: expect.arrayContaining(["tool_or_command_match"]),
            matchedTerms: expect.objectContaining({ tool: ["braintrust.query_sql"] }),
          }),
        ],
      },
    });
  });

  it("keeps broad tool triggers in trace but rejects them without another anchor", async () => {
    await expect(
      rankRepoMemoryRecallCandidates({
        repoOwner: null,
        repoName: null,
        intent: "Make the requested edit.",
        files: [],
        symbols: [],
        tool: "apply_patch",
        sourcePrNumbers: [],
        sourceSessionIds: [],
        memories: [
          {
            id: "mem-generic-tool-trigger",
            candidate_channels: ["tool_trigger_match"],
            triggers: {
              tools: ["apply_patch"],
            },
            content: "General editing reminder.",
          },
        ],
      }),
    ).resolves.toMatchObject({
      rankings: [],
      retrievalTrace: {
        returnedEmpty: true,
        rejectedCandidates: [
          expect.objectContaining({
            memoryId: "mem-generic-tool-trigger",
            bridgeCandidateChannels: ["tool_trigger_match"],
            candidateChannels: expect.not.arrayContaining(["tool_or_command_match"]),
            matchedTerms: expect.objectContaining({ tool: ["apply_patch"] }),
          }),
        ],
      },
    });
  });
});
