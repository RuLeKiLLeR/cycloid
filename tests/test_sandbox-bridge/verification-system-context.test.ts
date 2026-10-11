// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { describe, expect, it } from "vitest";

import { buildVerificationAgentSystemContext } from "../../apps/sandbox-bridge/src/constants/bridge.ts";

// Guard against re-introducing the per-check "scorecard" prompt clause removed in the
// #5050 QA regression fix. That clause anchored the QA Tester agent on
// filling a fixed checklist (cheap static rows pass, expensive dynamic rows skipped)
// instead of running real QA testing. The schema/parser/renderer stay as dormant infra;
// only the prompt instruction must not return.
describe("buildVerificationAgentSystemContext", () => {
  it("matches the assembled verification context snapshot", () => {
    const context = buildVerificationAgentSystemContext({
      targetPrUrl: "https://github.com/trycycloid/cycloid/pull/123",
      verificationRuntimeMode: "app_runtime",
      verificationSetupWarnings: ["preview boot reused cached dependencies"],
      verificationPrContext: {
        prUrl: "https://github.com/trycycloid/cycloid/pull/123",
        owner: "trycycloid",
        repo: "cycloid",
        number: 123,
        title: "Tighten QA prompt",
        body: "## Summary\n\nUpdate QA guidance.",
        state: "open",
        draft: false,
        headRef: "qa-prompt",
        headSha: "abc123",
        headRepoOwner: "trycycloid",
        headRepoName: "cycloid",
        baseRef: "main",
        authorLogin: "octocat",
        files: [{ path: "apps/sandbox-bridge/src/bridge.ts", status: "modified", additions: 2, deletions: 1 }],
        commits: [{ sha: "abc123", message: "Update QA prompt" }],
        recentDiscussion: [{ author: "reviewer", body: "Please verify the app flow." }],
        fetchWarnings: ["discussion truncated"],
      },
      verificationParentPrompts: [
        {
          promptId: "prompt-1",
          status: "completed",
          createdAt: "2026-01-02T03:04:05.000Z",
          prompt: "Implement the requested QA prompt adjustment.",
        },
      ],
      verificationRuntimeContext: {
        runtime: {
          provider: "e2b",
          runtimeBackend: "e2b_cloud",
          sandboxId: "sandbox-1",
          sandboxState: "running",
          sandboxImageId: "image-1",
          sandboxImageVersion: "v1",
          dockerEnabled: true,
        },
        previewUrl: "http://127.0.0.1:5173/",
        previewContract: {
          url: { hostPort: 5173, path: "/" },
        },
      },
    });

    expect(context).toMatchSnapshot();
  });

  it("does not instruct the agent to emit a checks scorecard", () => {
    const context = buildVerificationAgentSystemContext({ targetPrUrl: "https://github.com/o/r/pull/1" });

    expect(context).not.toContain("emit a `checks`");
    expect(context).not.toContain("never silently omit");
    // The structured-result JSON shape must not carry a `checks` field.
    expect(context).not.toMatch(/"checks"\s*:/);
  });

  it("still describes the dynamic-evidence QA testing contract", () => {
    const context = buildVerificationAgentSystemContext({ targetPrUrl: "https://github.com/o/r/pull/1" });

    // The QA Tester owns behavior proof, not GitHub merge/check state.
    expect(context).toContain("cycloid-verification-result");
    expect(context).toContain("Your primary job is to test the app behavior a user would experience");
    expect(context).toContain("Evidence is the record of that testing, not the goal");
    expect(context).toContain("CONCLUSIVE means your QA testing found the requested behavior works");
    expect(context).toContain("Any sort of blocker must be INCONCLUSIVE");
    expect(context).toContain("A CONCLUSIVE result requires evidence for every applicable surface");
    expect(context).toContain("Treat runtime/user-path proof as required");
    expect(context).toContain("must not replace an operated runtime/user journey");
    expect(context).toContain("GitHub CI/check-run state is outside your verification scope");
    expect(context).toContain("desktop/VNC first-party tools");
    expect(context).toContain("Use `desktop.record_start` and `desktop.record_stop` for a short additive walkthrough");
    expect(context).toContain("Desktop walkthrough videos are additive and never replace required screenshots");
    expect(context).toContain("Performance improvement change");
    expect(context).toContain("Before PR");
    expect(context).toContain("After PR");
    expect(context).toContain("improved, regressed, unchanged, or blocked");
    expect(context).toContain("Never add them to the customer repository");
    expect(context).toContain("never install packages just to use desktop recording");
    expect(context).not.toContain("CONCLUSIVE means merge-ready");
  });

  it("forbids nested Cycloid session creation as QA evidence", () => {
    const context = buildVerificationAgentSystemContext({ targetPrUrl: "https://github.com/o/r/pull/1" });

    expect(context).toContain("Do not create or enqueue Cycloid product sessions from QA");
    expect(context).toContain("cycloid sessions create");
    expect(context).toContain("cycloid.spawn_child_session");
    expect(context).toContain("not valid verification evidence");
  });

  it("allows non-web proof instead of forcing browser or visual evidence", () => {
    const context = buildVerificationAgentSystemContext({ targetPrUrl: "https://github.com/o/r/pull/1" });

    expect(context).toContain("app user path, API/runtime path, CLI command, library test, data path");
    expect(context).toContain("UI/app, backend/API, data/storage/schema, infra/config, CLI/library");
    expect(context).toContain("If the desktop tools are unavailable");
    expect(context).toContain("CLI/library change");
    expect(context).toContain("Missing video is not an automatic blocker for non-visual/API-only work");
    expect(context).not.toContain("use the app like a real user");
    expect(context).not.toContain("Record a demo");
    expect(context).not.toContain("DAO/database");
    expect(context).not.toContain("Terraform/Terragrunt");
  });
});
