import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildZeusReviewIssuesAlertText,
  notifyZeusReviewIssues,
  type ZeusReviewIssuesAlertInput,
} from "../../apps/control-plane-worker/src/session/zeus-review-issues-alert";
import { PROJECT_CODE_REVIEW_CHANNEL_ID } from "../../apps/control-plane-worker/src/slack/internal-channels";

const mockPostInternalAlert = vi.fn();

vi.mock("../../apps/control-plane-worker/src/slack/internal-alerts", () => ({
  postInternalAlert: (...args: unknown[]) => mockPostInternalAlert(...args),
}));

const env = { SLACK_BOT_TOKEN: "xoxb-test" } as const;

function input(overrides: Partial<ZeusReviewIssuesAlertInput> = {}): ZeusReviewIssuesAlertInput {
  return {
    sessionId: "session-1",
    prUrl: "https://github.com/trycycloid/cycloid/pull/123",
    repoOwner: "trycycloid",
    repoName: "cycloid",
    prNumber: 123,
    verdict: "issues_found",
    findings: [
      {
        severity: "P1",
        title: "Handle missing session state",
        path: "src/session.ts",
        line: 42,
        side: "RIGHT",
        bodyMarkdown: "The state can be absent.",
      },
    ],
    inlineCommentCount: 1,
    foldedFindingCount: 0,
    ...overrides,
  };
}

describe("Zeus review issues alert", () => {
  beforeEach(() => {
    mockPostInternalAlert.mockReset();
  });

  it("renders the verdict, PR link, finding counts, and a fenced finding summary", () => {
    const text = buildZeusReviewIssuesAlertText(input({ foldedFindingCount: 2 }));

    expect(text).toContain("🔎 *Zeus found issues*");
    expect(text).toContain("<https://github.com/trycycloid/cycloid/pull/123|trycycloid/cycloid#123>");
    expect(text).toContain("Findings: 1 (1 inline, 2 folded)");
    expect(text).toContain("[P1] Handle missing session state - src/session.ts:42");
    expect(text).toContain("```");
  });

  it("renders only the top five findings", () => {
    const findings = Array.from({ length: 6 }, (_, index) => ({
      severity: "P2" as const,
      title: `Finding ${index + 1}`,
      path: `src/${index + 1}.ts`,
      line: index + 1,
      side: "RIGHT" as const,
      bodyMarkdown: "Details.",
    }));

    const text = buildZeusReviewIssuesAlertText(input({ findings }));

    expect(text).toContain("[P2] Finding 5 - src/5.ts:5");
    expect(text).not.toContain("Finding 6");
    expect(text).toContain("… and 1 more");
  });

  it("escapes Slack markup and prevents finding text from closing the code fence", () => {
    const text = buildZeusReviewIssuesAlertText(
      input({
        findings: [
          {
            severity: "P1",
            title: "<unsafe>&\nheading ``` @channel",
            path: "src/<unsafe>&\tfile.ts",
            line: 42,
            side: "RIGHT",
            bodyMarkdown: "Details.",
          },
        ],
      }),
    );

    expect(text).toContain("[P1] &lt;unsafe&gt;&amp; heading ˋˋˋ @channel - src/&lt;unsafe&gt;&amp; file.ts:42");
    expect(text.match(/```/g)).toHaveLength(2);
  });

  it("returns false when internal Slack alerts are unconfigured", async () => {
    mockPostInternalAlert.mockResolvedValue(null);

    await expect(notifyZeusReviewIssues(env, input())).resolves.toBe(false);
  });

  it("returns true when the internal Slack alert posts successfully", async () => {
    mockPostInternalAlert.mockResolvedValue({ ok: true, ts: "1.2", channel: PROJECT_CODE_REVIEW_CHANNEL_ID });

    await expect(notifyZeusReviewIssues(env, input())).resolves.toBe(true);

    expect(mockPostInternalAlert).toHaveBeenCalledWith(
      env,
      PROJECT_CODE_REVIEW_CHANNEL_ID,
      expect.stringContaining("Zeus found issues"),
      undefined,
      {
        sessionId: "session-1",
        prUrl: "https://github.com/trycycloid/cycloid/pull/123",
        verdict: "issues_found",
        findingCount: 1,
      },
    );
  });
});
