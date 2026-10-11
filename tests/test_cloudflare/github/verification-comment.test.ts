import { beforeEach, describe, expect, it, vi } from "vitest";

import { PR_PERSONAS, renderPersonaHeader } from "../../../shared/agent/pr-personas";

vi.mock("../../../apps/control-plane-worker/src/observability/wrappers", () => ({
  tracedFetch: async (url: string, options?: { method?: string; body?: string }) => {
    fetchCalls.push({ url, method: options?.method ?? "GET", body: options?.body ?? null });
    const response = responses.shift();
    if (!response) throw new Error(`Unexpected fetch: ${url}`);
    return {
      ok: response.ok,
      status: response.status,
      headers: { get: () => null },
      json: async () => response.body,
      text: async () => (typeof response.body === "string" ? response.body : JSON.stringify(response.body)),
    };
  },
}));

vi.mock("../../../apps/control-plane-worker/src/github/installations-db", () => ({
  getInstallationByOwner: async () => {
    if (throwInstallationLookup) throw new Error("D1 unavailable");
    return mockInstallation;
  },
}));

vi.mock("../../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: async () => "ghs_installation",
  createScopedInstallationToken: async () => "ghs_installation",
  sandboxInstallationTokenScope: (repoName: string) => ({
    repositories: [repoName],
    permissions: { contents: "write", pull_requests: "read" },
  }),
}));

type MockResponse = {
  ok: boolean;
  status: number;
  body: unknown;
};

let responses: MockResponse[] = [];
let fetchCalls: Array<{ url: string; method: string; body: string | null }> = [];
let throwInstallationLookup = false;
let mockInstallation: { installation_id: number; suspended_at: number | null } | null = {
  installation_id: 123,
  suspended_at: null,
};

const validVerifierOutput = `Done.

\`\`\`cycloid-verification-result
{
  "verdict": "CONCLUSIVE",
  "verifiedHeadSha": "abc123",
  "summary": "Verified the auth flow end to end.",
  "evidence": ["Ran Playwright login smoke.", "Checked API logs."],
  "blockers": []
}
\`\`\``;

const conclusiveVerifierResult = {
  verdict: "CONCLUSIVE" as const,
  verifiedHeadSha: "abc123",
  summary: "Verified the auth flow end to end.",
  evidence: ["Ran Playwright login smoke."],
  blockers: [],
};

const inconclusiveVerifierResult = {
  verdict: "INCONCLUSIVE" as const,
  verifiedHeadSha: "abc123",
  needsWorkLabel: "verification-gap" as const,
  summary: "Preview failed to start.",
  evidence: [],
  blockers: ["Runtime setup failed."],
};

describe("github/verification-comment-marker", () => {
  it("writes and accepts only the QA marker for the target PR", async () => {
    const { containsManagedQaCommentMarker, qaCommentMarker } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment-marker");
    const target = { owner: "org", repo: "repo", prNumber: 7 };

    expect(qaCommentMarker("org", "repo", 7, "abc123", "pass")).toBe(
      "<!-- cycloid-qa:v1 owner=org repo=repo pr=7 head=abc123 verdict=pass -->",
    );
    expect(containsManagedQaCommentMarker("<!-- cycloid-qa:v1 owner=org repo=repo pr=7 head=abc123 -->", target)).toBe(
      true,
    );
    const oldMarkerBody = "<!-- cycloid-" + "verification:v1 owner=org repo=repo pr=7 head=abc123 -->";
    expect(containsManagedQaCommentMarker(oldMarkerBody, target)).toBe(false);
    expect(containsManagedQaCommentMarker("<!-- cycloid-qa:v1 owner=org repo=repo pr=70 head=abc123 -->", target)).toBe(
      false,
    );
    expect(containsManagedQaCommentMarker("unmanaged comment", target)).toBe(false);
  });
});

describe("github/verification-comment", () => {
  beforeEach(() => {
    responses = [];
    fetchCalls = [];
    throwInstallationLookup = false;
    mockInstallation = { installation_id: 123, suspended_at: null };
  });

  it("creates the managed verification comment on first verifier run", async () => {
    const { upsertManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      { ok: true, status: 200, body: [] },
      { ok: true, status: 201, body: { id: 101, html_url: "https://github.com/org/repo/pull/7#issuecomment-101" } },
    ];

    const result = await upsertManagedVerificationComment({
      token: "ghs_test",
      owner: "org",
      repo: "repo",
      prNumber: 7,
      rawVerifierOutput: validVerifierOutput,
      fallbackHeadSha: "abc123",
    });

    expect(result).toEqual({ ok: true, commentId: 101, action: "created", malformed: false });
    expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET https://api.github.com/repos/org/repo/issues/7/comments?per_page=100",
      "POST https://api.github.com/repos/org/repo/issues/7/comments",
    ]);
    const body = JSON.parse(fetchCalls[1].body ?? "{}").body as string;
    expect(body).toContain("<!-- cycloid-qa:v1 owner=org repo=repo pr=7 head=abc123 verdict=pass -->");
    expect(body).toContain("**Verdict:** Pass");
    expect(body).toContain("**Verified head:** `abc123`");
    expect(body).toContain("- Ran Playwright login smoke.");
  });

  it("renders the optional needs-work label for inconclusive verifier results", async () => {
    const { upsertManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      { ok: true, status: 200, body: [] },
      { ok: true, status: 201, body: { id: 211, html_url: "https://github.com/org/repo/pull/7#issuecomment-211" } },
    ];

    const result = await upsertManagedVerificationComment({
      token: "ghs_test",
      owner: "org",
      repo: "repo",
      prNumber: 7,
      rawVerifierOutput: "",
      fallbackHeadSha: "abc123",
      verifierResult: inconclusiveVerifierResult,
    });

    expect(result).toEqual({ ok: true, commentId: 211, action: "created", malformed: false });
    const body = JSON.parse(fetchCalls[1].body ?? "{}").body as string;
    expect(body).toContain(`${renderPersonaHeader(PR_PERSONAS.cycloidQa)}\n\n**Verdict:**`);
    expect(body).toContain("**Verdict:** Needs work");
  });

  it("creates a verification skipped comment with the routing reason", async () => {
    const { publishVerificationSkippedComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      { ok: true, status: 200, body: [] },
      { ok: true, status: 201, body: { id: 101, html_url: "https://github.com/org/repo/pull/7#issuecomment-101" } },
    ];

    const result = await publishVerificationSkippedComment({
      env: {} as never,
      target: {
        prUrl: "https://github.com/org/repo/pull/7",
        installationId: 123,
        repoOwner: "org",
        repoName: "repo",
      },
      summary: "The PR only changes documentation.",
      reasonCode: "verification_skipped_docs_only",
    });

    expect(result).toEqual({ ok: true, commentId: 101, action: "created", malformed: false });
    const body = JSON.parse(fetchCalls[1].body ?? "{}").body as string;
    expect(body).toContain("<!-- cycloid-qa:v1 owner=org repo=repo pr=7 head=skipped verdict=none -->");
    expect(body).toContain(`${renderPersonaHeader(PR_PERSONAS.cycloidQa)}\n\nQA testing skipped:`);
    expect(body).toContain("QA testing skipped: The PR only changes documentation.");
    expect(body).toContain("Reason: Verification skipped docs only.");
  });

  it("updates the started comment when final QA Tester output is published", async () => {
    const { upsertManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      {
        ok: true,
        status: 200,
        body: [
          {
            id: 101,
            body: "<!-- cycloid-qa:v1 owner=org repo=repo pr=7 head=pending -->\n\nQA testing in this Cycloid [session](https://app.example.com/sessions/session-1).",
          },
        ],
      },
      { ok: true, status: 200, body: { id: 101 } },
    ];

    const result = await upsertManagedVerificationComment({
      token: "ghs_test",
      owner: "org",
      repo: "repo",
      prNumber: 7,
      rawVerifierOutput: "",
      fallbackHeadSha: "abc123",
      verifierResult: conclusiveVerifierResult,
      sessionUrl: "https://app.example.com/sessions/session-1",
    });

    expect(result).toEqual({ ok: true, commentId: 101, action: "updated", malformed: false });
    expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET https://api.github.com/repos/org/repo/issues/7/comments?per_page=100",
      "PATCH https://api.github.com/repos/org/repo/issues/comments/101",
    ]);
    const body = JSON.parse(fetchCalls[1].body ?? "{}").body as string;
    expect(body).toContain("<!-- cycloid-qa:v1 owner=org repo=repo pr=7 head=abc123 verdict=pass -->");
    expect(body).toContain("**Verdict:** Pass");
    expect(body).not.toContain("Verifying in session");
    expect(body).not.toContain("### QA Tester Commits");
    expect(body).toContain("### QA Transcript");
    expect(body.trimEnd().endsWith("[View QA transcript](<https://app.example.com/sessions/session-1>)")).toBe(true);
  });

  it("truncates oversized managed verification comments instead of dropping the comment", async () => {
    const { upsertManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      { ok: true, status: 200, body: [] },
      { ok: true, status: 201, body: { id: 111, html_url: "https://github.com/org/repo/pull/7#issuecomment-111" } },
    ];

    const result = await upsertManagedVerificationComment({
      token: "ghs_test",
      owner: "org",
      repo: "repo",
      prNumber: 7,
      rawVerifierOutput: "",
      fallbackHeadSha: "abc123",
      sessionUrl: "https://app.example.com/sessions/session-1",
      verifierResult: {
        verdict: "CONCLUSIVE",
        verifiedHeadSha: "abc123",
        summary: "Verified the auth flow end to end.",
        evidence: Array.from({ length: 20 }, (_, index) => `evidence ${index} ${"x".repeat(4000)}`),
        blockers: [],
      },
    });

    expect(result).toEqual({ ok: true, commentId: 111, action: "created", malformed: false });
    const body = JSON.parse(fetchCalls[1].body ?? "{}").body as string;
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(16_000);
    expect(body).toContain("<!-- cycloid-qa:v1 owner=org repo=repo pr=7 head=abc123 verdict=pass -->");
    expect(body).toContain("**Verdict:** Pass");
    expect(body).toContain("[truncated to fit GitHub comment size limit]");
    expect(body).toContain("### QA Transcript");
    expect(body.trimEnd().endsWith("[View QA transcript](<https://app.example.com/sessions/session-1>)")).toBe(true);
  });

  it("closes truncated inline evidence blocks before the verification transcript footer", async () => {
    const { upsertManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      { ok: true, status: 200, body: [] },
      { ok: true, status: 201, body: { id: 112, html_url: "https://github.com/org/repo/pull/7#issuecomment-112" } },
    ];

    const result = await upsertManagedVerificationComment({
      token: "ghs_test",
      owner: "org",
      repo: "repo",
      prNumber: 7,
      rawVerifierOutput: "",
      fallbackHeadSha: "abc123",
      sessionUrl: "https://app.example.com/sessions/session-1",
      verifierResult: conclusiveVerifierResult,
      artifacts: [
        {
          type: "log",
          label: "verification.log",
          url: "https://app.trycycloid.com/api/sessions/session-1/artifacts/artifact-1/verification.log",
          inlineText: {
            content: `command output\n${"x".repeat(40_000)}`,
            truncated: true,
            originalBytes: 40_015,
          },
        },
      ],
    });

    expect(result).toEqual({ ok: true, commentId: 112, action: "created", malformed: false });
    const body = JSON.parse(fetchCalls[1].body ?? "{}").body as string;
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(16_000);
    expect(body).toContain("[truncated to fit GitHub comment size limit]");
    expect(body).toContain("</code>\n</pre>\n</details>\n\n[truncated to fit GitHub comment size limit]");
    expect(body.indexOf("</details>\n\n[truncated to fit GitHub comment size limit]")).toBeLessThan(
      body.indexOf("### QA Transcript"),
    );
    expect(body.trimEnd().endsWith("[View QA transcript](<https://app.example.com/sessions/session-1>)")).toBe(true);
  });

  it("closes truncated inline evidence summaries before the verification transcript footer", async () => {
    const { upsertManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      { ok: true, status: 200, body: [] },
      { ok: true, status: 201, body: { id: 113, html_url: "https://github.com/org/repo/pull/7#issuecomment-113" } },
    ];

    const result = await upsertManagedVerificationComment({
      token: "ghs_test",
      owner: "org",
      repo: "repo",
      prNumber: 7,
      rawVerifierOutput: "",
      fallbackHeadSha: "abc123",
      sessionUrl: "https://app.example.com/sessions/session-1",
      verifierResult: conclusiveVerifierResult,
      artifacts: [
        {
          type: "log",
          label: `verification-${"x".repeat(40_000)}.log`,
          url: "https://app.trycycloid.com/api/sessions/session-1/artifacts/artifact-1/verification.log",
          inlineText: {
            content: "short output",
            truncated: false,
            originalBytes: 12,
          },
        },
      ],
    });

    expect(result).toEqual({ ok: true, commentId: 113, action: "created", malformed: false });
    const body = JSON.parse(fetchCalls[1].body ?? "{}").body as string;
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(16_000);
    expect(body).toContain("</summary>\n</details>\n\n[truncated to fit GitHub comment size limit]");
    expect(body.indexOf("</details>\n\n[truncated to fit GitHub comment size limit]")).toBeLessThan(
      body.indexOf("### QA Transcript"),
    );
    expect(body.trimEnd().endsWith("[View QA transcript](<https://app.example.com/sessions/session-1>)")).toBe(true);
  });

  it("renders uploaded QA Tester screenshots and recordings in the managed verification comment", async () => {
    const { upsertManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      { ok: true, status: 200, body: [] },
      { ok: true, status: 201, body: { id: 111, html_url: "https://github.com/org/repo/pull/7#issuecomment-111" } },
    ];

    const result = await upsertManagedVerificationComment({
      token: "ghs_test",
      owner: "org",
      repo: "repo",
      prNumber: 7,
      rawVerifierOutput: "",
      fallbackHeadSha: "abc123",
      verifierResult: conclusiveVerifierResult,
      artifacts: [
        {
          type: "screenshot",
          label: "dashboard-light-mode.png",
          url: "https://cdn.example.com/dashboard-light-mode.png",
        },
        {
          type: "log",
          label: "verification.log",
          url: "https://cdn.example.com/verification.log",
        },
        {
          type: "video",
          label: "happy-path-walkthrough.webm",
          url: "https://github.com/org/repo/releases/download/cycloid-evidence/happy-path-walkthrough.webm",
        },
      ],
    });

    expect(result).toEqual({ ok: true, commentId: 111, action: "created", malformed: false });
    const body = JSON.parse(fetchCalls[1].body ?? "{}").body as string;
    expect(body).toContain("### Screenshots");
    expect(body).toContain("[dashboard-light-mode.png](<https://cdn.example.com/dashboard-light-mode.png>)");
    expect(body).toContain(
      '<img src="https://cdn.example.com/dashboard-light-mode.png" width="720" alt="Cycloid QA screenshot: dashboard-light-mode.png" />',
    );
    expect(body).toContain("### Recordings");
    expect(body).toContain(
      "[happy-path-walkthrough.webm](<https://github.com/org/repo/releases/download/cycloid-evidence/happy-path-walkthrough.webm>)",
    );
    expect(body).not.toContain("verification.log");
  });

  it("renders link-only QA Tester screenshots without image embeds", async () => {
    const { upsertManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      { ok: true, status: 200, body: [] },
      { ok: true, status: 201, body: { id: 111, html_url: "https://github.com/org/repo/pull/7#issuecomment-111" } },
    ];

    const result = await upsertManagedVerificationComment({
      token: "ghs_test",
      owner: "org",
      repo: "repo",
      prNumber: 7,
      rawVerifierOutput: "",
      fallbackHeadSha: "abc123",
      verifierResult: conclusiveVerifierResult,
      artifacts: [
        {
          type: "screenshot",
          label: "dashboard-light-mode.png",
          url: "https://app.trycycloid.com/api/sessions/session-1/artifacts/artifact-1/dashboard-light-mode.png",
          renderMode: "link",
        },
      ],
    });

    expect(result).toEqual({ ok: true, commentId: 111, action: "created", malformed: false });
    const body = JSON.parse(fetchCalls[1].body ?? "{}").body as string;
    expect(body).toContain("### Screenshots");
    expect(body).toContain(
      "- [dashboard-light-mode.png](<https://app.trycycloid.com/api/sessions/session-1/artifacts/artifact-1/dashboard-light-mode.png>)",
    );
    expect(body).not.toContain("<img");
  });

  it("renders inline text evidence files as collapsible blocks in the managed verification comment", async () => {
    const { upsertManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      { ok: true, status: 200, body: [] },
      { ok: true, status: 201, body: { id: 112, html_url: "https://github.com/org/repo/pull/7#issuecomment-112" } },
    ];

    const result = await upsertManagedVerificationComment({
      token: "ghs_test",
      owner: "org",
      repo: "repo",
      prNumber: 7,
      rawVerifierOutput: "",
      fallbackHeadSha: "abc123",
      verifierResult: conclusiveVerifierResult,
      artifacts: [
        {
          type: "log",
          label: "db-20260608T122548Z/host-alembic-upgrade.log",
          url: "https://app.trycycloid.com/api/sessions/session-1/artifacts/artifact-1/host-alembic-upgrade.log",
          inlineText: {
            content: "[truncated 128 bytes]\n<unsafe>\nalembic upgrade head passed",
            truncated: true,
            originalBytes: 4224,
          },
        },
        {
          type: "log",
          label: "ignored-without-inline.log",
          url: "https://app.trycycloid.com/api/sessions/session-1/artifacts/artifact-2/ignored-without-inline.log",
        },
      ],
    });

    expect(result).toEqual({ ok: true, commentId: 112, action: "created", malformed: false });
    const body = JSON.parse(fetchCalls[1].body ?? "{}").body as string;
    expect(body).toContain("### Evidence Files");
    expect(body).toContain("<details>");
    expect(body).toContain("<summary>db-20260608T122548Z/host-alembic-upgrade.log (4224 bytes, truncated)</summary>");
    expect(body).toContain("&lt;unsafe&gt;");
    expect(body).toContain("alembic upgrade head passed");
    expect(body).not.toContain("<unsafe>");
    expect(body).not.toContain("ignored-without-inline.log");
  });

  it("renders video-only QA Tester recordings without a screenshots section", async () => {
    const { upsertManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      { ok: true, status: 200, body: [] },
      { ok: true, status: 201, body: { id: 111, html_url: "https://github.com/org/repo/pull/7#issuecomment-111" } },
    ];

    const result = await upsertManagedVerificationComment({
      token: "ghs_test",
      owner: "org",
      repo: "repo",
      prNumber: 7,
      rawVerifierOutput: "",
      fallbackHeadSha: "abc123",
      verifierResult: conclusiveVerifierResult,
      artifacts: [
        {
          type: "video",
          label: "login-walkthrough.webm",
          url: "https://github.com/org/repo/releases/download/cycloid-evidence/login-walkthrough.webm",
        },
        {
          type: "video",
          label: "settings-flow.webm",
          url: "https://github.com/org/repo/releases/download/cycloid-evidence/settings-flow.webm",
        },
      ],
    });

    expect(result).toEqual({ ok: true, commentId: 111, action: "created", malformed: false });
    const body = JSON.parse(fetchCalls[1].body ?? "{}").body as string;
    expect(body).not.toContain("### Screenshots");
    expect(body).toContain("### Recordings");
    expect(body).toContain(
      "[login-walkthrough.webm](<https://github.com/org/repo/releases/download/cycloid-evidence/login-walkthrough.webm>)",
    );
    expect(body).toContain(
      "[settings-flow.webm](<https://github.com/org/repo/releases/download/cycloid-evidence/settings-flow.webm>)",
    );
  });

  it("updates the existing managed verification comment on later verifier runs", async () => {
    const { upsertManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      {
        ok: true,
        status: 200,
        body: [{ id: 202, body: "<!-- cycloid-qa:v1 owner=org repo=repo pr=7 head=old -->" }],
      },
      { ok: true, status: 200, body: { id: 202 } },
    ];

    const result = await upsertManagedVerificationComment({
      token: "ghs_test",
      owner: "org",
      repo: "repo",
      prNumber: 7,
      rawVerifierOutput: validVerifierOutput,
      fallbackHeadSha: "abc123",
    });

    expect(result).toEqual({ ok: true, commentId: 202, action: "updated", malformed: false });
    expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET https://api.github.com/repos/org/repo/issues/7/comments?per_page=100",
      "PATCH https://api.github.com/repos/org/repo/issues/comments/202",
    ]);
    const body = JSON.parse(fetchCalls[1].body ?? "{}").body as string;
    expect(body).toContain("<!-- cycloid-qa:v1 owner=org repo=repo pr=7 head=abc123 verdict=pass -->");
    expect(body).toContain("head=abc123");
    expect(body).toContain("Verified the auth flow end to end.");
  });

  it("fails closed to inconclusive when QA Tester output is malformed", async () => {
    const { upsertManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      { ok: true, status: 200, body: [] },
      { ok: true, status: 201, body: { id: 303, html_url: "https://github.com/org/repo/pull/7#issuecomment-303" } },
    ];

    const result = await upsertManagedVerificationComment({
      token: "ghs_test",
      owner: "org",
      repo: "repo",
      prNumber: 7,
      rawVerifierOutput: "I could not verify the OAuth callback because the preview never started.",
      fallbackHeadSha: "head789",
    });

    expect(result).toEqual({ ok: true, commentId: 303, action: "created", malformed: true });
    const body = JSON.parse(fetchCalls[1].body ?? "{}").body as string;
    expect(body).toContain("**Verdict:** Needs work");
    expect(body).toContain("**Verified head:** `head789`");
    expect(body).toContain("I could not verify the OAuth callback");
    expect(body).toContain("QA Tester output was malformed");
  });

  it("fails closed when a structured verifier result from the sandbox is malformed", async () => {
    const { upsertManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      { ok: true, status: 200, body: [] },
      { ok: true, status: 201, body: { id: 404, html_url: "https://github.com/org/repo/pull/7#issuecomment-404" } },
    ];

    const result = await upsertManagedVerificationComment({
      token: "ghs_test",
      owner: "org",
      repo: "repo",
      prNumber: 7,
      rawVerifierOutput: "QA Tester claimed success, but the structured event was malformed.",
      fallbackHeadSha: "head999",
      verifierResult: {
        verdict: "CONCLUSIVE",
        verifiedHeadSha: "",
        summary: "",
        evidence: [],
        blockers: [],
      },
    });

    expect(result).toEqual({ ok: true, commentId: 404, action: "created", malformed: true });
    const body = JSON.parse(fetchCalls[1].body ?? "{}").body as string;
    expect(body).toContain("**Verdict:** Needs work");
    expect(body).toContain("**Verified head:** `head999`");
    expect(body).toContain("QA Tester output was malformed");
    expect(body).not.toContain("**Verdict:** Pass");
  });

  it("fetches the PR head when a stopped structured verifier result has no verified head", async () => {
    const { publishManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      { ok: true, status: 200, body: { head: { sha: "head-from-github" }, node_id: "PR_node_7", draft: false } },
      { ok: true, status: 200, body: [] },
      { ok: true, status: 201, body: { id: 405, html_url: "https://github.com/org/repo/pull/7#issuecomment-405" } },
    ];

    const result = await publishManagedVerificationComment({
      env: { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" } as never,
      target: { prUrl: "https://github.com/org/repo/pull/7" },
      rawVerifierOutput: "",
      fallbackHeadSha: "",
      verifierResult: {
        verdict: "INCONCLUSIVE",
        verifiedHeadSha: "",
        summary: "QA Tester session stopped before it could report a verdict.",
        evidence: ["The QA Tester session stopped before publishing a final QA Tester result."],
        blockers: ["QA testing stopped before completion."],
      },
    });

    expect(result).toEqual({
      ok: true,
      commentId: 405,
      action: "created",
      malformed: false,
    });
    // INCONCLUSIVE never mutates PR draft state.
    expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET https://api.github.com/repos/org/repo/pulls/7",
      "GET https://api.github.com/repos/org/repo/issues/7/comments?per_page=100",
      "POST https://api.github.com/repos/org/repo/issues/7/comments",
    ]);
    expect(fetchCalls.some((call) => call.url.includes("/graphql"))).toBe(false);
    const body = JSON.parse(fetchCalls[2].body ?? "{}").body as string;
    expect(body).toContain("<!-- cycloid-qa:v1 owner=org repo=repo pr=7 head=head-from-github verdict=app_breaks -->");
    expect(body).toContain("**Verdict:** Needs work");
    expect(body).toContain("QA Tester session stopped before it could report a verdict.");
    expect(body).not.toContain("QA Tester output was malformed");
  });

  it("leaves a ready human-authored PR ready when a stopped session yields INCONCLUSIVE (mialabs/mia#3130)", async () => {
    const { publishManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    // A customer opened this PR ready for review and ran `@cycloid qa=true`; the
    // verification session stopped before reporting and was synthesized as INCONCLUSIVE.
    // Cycloid must not convert the human's ready PR to draft.
    responses = [
      { ok: true, status: 200, body: [] },
      { ok: true, status: 201, body: { id: 530, html_url: "https://github.com/org/repo/pull/7#issuecomment-530" } },
    ];

    const result = await publishManagedVerificationComment({
      env: { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" } as never,
      target: { prUrl: "https://github.com/org/repo/pull/7" },
      rawVerifierOutput: "",
      fallbackHeadSha: "abc123",
      verifierResult: {
        verdict: "INCONCLUSIVE",
        verifiedHeadSha: "abc123",
        summary: "QA Tester session stopped before it could report a verdict.",
        evidence: ["The QA Tester session stopped before publishing a final QA Tester result."],
        blockers: ["QA testing stopped before completion."],
      },
    });

    expect(result).toEqual({
      ok: true,
      commentId: 530,
      action: "created",
      malformed: false,
    });
    // Only the comment is posted: no GraphQL draft mutation, and the PR draft state is
    // never even queried for a draft decision.
    expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET https://api.github.com/repos/org/repo/issues/7/comments?per_page=100",
      "POST https://api.github.com/repos/org/repo/issues/7/comments",
    ]);
    expect(fetchCalls.some((call) => call.url.includes("/graphql"))).toBe(false);
  });

  it("returns github_failed on GitHub permission or API failure", async () => {
    const { upsertManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [{ ok: false, status: 403, body: { message: "Resource not accessible by integration" } }];

    const result = await upsertManagedVerificationComment({
      token: "ghs_test",
      owner: "org",
      repo: "repo",
      prNumber: 7,
      rawVerifierOutput: validVerifierOutput,
      fallbackHeadSha: "abc123",
    });

    expect(result).toEqual({ ok: false, reason: "github_failed" });
    expect(fetchCalls).toHaveLength(1);
  });

  it("returns github_failed instead of throwing when installation lookup fails", async () => {
    const { publishManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    throwInstallationLookup = true;

    const result = await publishManagedVerificationComment({
      env: { DB: {} } as never,
      target: { prUrl: "https://github.com/org/repo/pull/7" },
      rawVerifierOutput: validVerifierOutput,
      fallbackHeadSha: "abc123",
    });

    expect(result).toEqual({ ok: false, reason: "github_failed" });
    expect(fetchCalls).toHaveLength(0);
  });

  it("leaves a draft PR draft after conclusive verification of the current head", async () => {
    const { publishManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      { ok: true, status: 200, body: [] },
      { ok: true, status: 201, body: { id: 501, html_url: "https://github.com/org/repo/pull/7#issuecomment-501" } },
      { ok: true, status: 200, body: { node_id: "PR_node_7", draft: true, head: { sha: "abc123" } } },
    ];

    const result = await publishManagedVerificationComment({
      env: { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" } as never,
      target: { prUrl: "https://github.com/org/repo/pull/7" },
      rawVerifierOutput: "",
      fallbackHeadSha: "abc123",
      verifierResult: conclusiveVerifierResult,
    });

    expect(result).toEqual({
      ok: true,
      commentId: 501,
      action: "created",
      malformed: false,
    });
    expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET https://api.github.com/repos/org/repo/issues/7/comments?per_page=100",
      "POST https://api.github.com/repos/org/repo/issues/7/comments",
      "GET https://api.github.com/repos/org/repo/pulls/7",
    ]);
  });

  it("keeps a conclusive result scoped to the verified commit and marks it stale when the PR head advanced", async () => {
    const { publishManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      { ok: true, status: 200, body: [] },
      { ok: true, status: 201, body: { id: 506, html_url: "https://github.com/org/repo/pull/7#issuecomment-506" } },
      { ok: true, status: 200, body: { node_id: "PR_node_7", draft: false, head: { sha: "new456" } } },
      {
        ok: true,
        status: 200,
        body: [
          {
            id: 506,
            body: "<!-- cycloid-qa:v1 owner=org repo=repo pr=7 head=abc123 -->\n\n## Cycloid QA",
          },
        ],
      },
      { ok: true, status: 200, body: { id: 506 } },
    ];

    const result = await publishManagedVerificationComment({
      env: { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" } as never,
      target: { prUrl: "https://github.com/org/repo/pull/7" },
      rawVerifierOutput: "",
      fallbackHeadSha: "abc123",
      verifierResult: conclusiveVerifierResult,
    });

    expect(result).toEqual({
      ok: true,
      commentId: 506,
      action: "created",
      malformed: false,
    });
    expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET https://api.github.com/repos/org/repo/issues/7/comments?per_page=100",
      "POST https://api.github.com/repos/org/repo/issues/7/comments",
      "GET https://api.github.com/repos/org/repo/pulls/7",
      "GET https://api.github.com/repos/org/repo/issues/7/comments?per_page=100",
      "PATCH https://api.github.com/repos/org/repo/issues/comments/506",
    ]);
    // Outdated-head verdicts rewrite the comment but never mutate PR draft state.
    expect(fetchCalls.some((call) => call.url.includes("/graphql"))).toBe(false);
    const body = JSON.parse(fetchCalls[4].body ?? "{}").body as string;
    expect(body).toContain("**Verdict:** Pass");
    expect(body).toContain("**Verified head:** `abc123`");
    expect(body).toContain("Verified at `abc123`; current head is `new456`, so newer commits are not yet verified.");
    expect(body).toContain("new456");
    expect(body).not.toContain("Rerun QA testing");
  });

  it("skips old-SHA live gate refresh when the PR head advanced and marks it outdated", async () => {
    const { publishManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      { ok: true, status: 200, body: { node_id: "PR_node_7", draft: false, head: { sha: "new456" } } },
      { ok: true, status: 200, body: [] },
      { ok: true, status: 201, body: { id: 516, html_url: "https://github.com/org/repo/pull/7#issuecomment-516" } },
      { ok: true, status: 200, body: { node_id: "PR_node_7", draft: false, head: { sha: "new456" } } },
      {
        ok: true,
        status: 200,
        body: [
          {
            id: 516,
            body: "<!-- cycloid-qa:v1 owner=org repo=repo pr=7 head=abc123 -->\n\n## Cycloid QA",
          },
        ],
      },
      { ok: true, status: 200, body: { id: 516 } },
    ];

    const result = await publishManagedVerificationComment({
      env: { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" } as never,
      target: { prUrl: "https://github.com/org/repo/pull/7" },
      rawVerifierOutput: "",
      fallbackHeadSha: "abc123",
      verifierResult: conclusiveVerifierResult,
      refreshLivePrGates: true,
    });

    expect(result).toEqual({
      ok: true,
      commentId: 516,
      action: "created",
      malformed: false,
    });
    expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET https://api.github.com/repos/org/repo/pulls/7",
      "GET https://api.github.com/repos/org/repo/issues/7/comments?per_page=100",
      "POST https://api.github.com/repos/org/repo/issues/7/comments",
      "GET https://api.github.com/repos/org/repo/pulls/7",
      "GET https://api.github.com/repos/org/repo/issues/7/comments?per_page=100",
      "PATCH https://api.github.com/repos/org/repo/issues/comments/516",
    ]);
    expect(fetchCalls.some((call) => call.url.includes("/graphql"))).toBe(false);
    const body = JSON.parse(fetchCalls[5].body ?? "{}").body as string;
    expect(body).toContain("**Verdict:** Pass");
    expect(body).toContain("**Verified head:** `abc123`");
    expect(body).toContain("Verified at `abc123`; current head is `new456`, so newer commits are not yet verified.");
    expect(body).toContain("new456");
  });

  it("keeps a conclusive result scoped to the verified commit when an advanced PR is already draft", async () => {
    const { publishManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      { ok: true, status: 200, body: [] },
      { ok: true, status: 201, body: { id: 502, html_url: "https://github.com/org/repo/pull/7#issuecomment-502" } },
      { ok: true, status: 200, body: { node_id: "PR_node_7", draft: true, head: { sha: "new456" } } },
      {
        ok: true,
        status: 200,
        body: [
          {
            id: 502,
            body: "<!-- cycloid-qa:v1 owner=org repo=repo pr=7 head=abc123 -->\n\n## Cycloid QA",
          },
        ],
      },
      { ok: true, status: 200, body: { id: 502 } },
    ];

    const result = await publishManagedVerificationComment({
      env: { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" } as never,
      target: { prUrl: "https://github.com/org/repo/pull/7" },
      rawVerifierOutput: "",
      fallbackHeadSha: "abc123",
      verifierResult: conclusiveVerifierResult,
    });

    expect(result).toEqual({
      ok: true,
      commentId: 502,
      action: "created",
      malformed: false,
    });
    expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET https://api.github.com/repos/org/repo/issues/7/comments?per_page=100",
      "POST https://api.github.com/repos/org/repo/issues/7/comments",
      "GET https://api.github.com/repos/org/repo/pulls/7",
      "GET https://api.github.com/repos/org/repo/issues/7/comments?per_page=100",
      "PATCH https://api.github.com/repos/org/repo/issues/comments/502",
    ]);
    const body = JSON.parse(fetchCalls[4].body ?? "{}").body as string;
    expect(body).toContain("**Verdict:** Pass");
    expect(body).toContain("**Verified head:** `abc123`");
    expect(body).toContain("Verified at `abc123`; current head is `new456`, so newer commits are not yet verified.");
    expect(body).toContain("new456");
    expect(body).not.toContain("Rerun QA testing");
  });

  it("leaves a ready PR ready for inconclusive verification", async () => {
    const { publishManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      { ok: true, status: 200, body: [] },
      { ok: true, status: 201, body: { id: 503, html_url: "https://github.com/org/repo/pull/7#issuecomment-503" } },
    ];

    const result = await publishManagedVerificationComment({
      env: { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" } as never,
      target: { prUrl: "https://github.com/org/repo/pull/7" },
      rawVerifierOutput: "",
      fallbackHeadSha: "abc123",
      verifierResult: inconclusiveVerifierResult,
    });

    expect(result).toEqual({
      ok: true,
      commentId: 503,
      action: "created",
      malformed: false,
    });
    // A human's ready PR is never converted to draft on an inconclusive verdict.
    expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET https://api.github.com/repos/org/repo/issues/7/comments?per_page=100",
      "POST https://api.github.com/repos/org/repo/issues/7/comments",
    ]);
    expect(fetchCalls.some((call) => call.url.includes("/graphql"))).toBe(false);
    const body = JSON.parse(fetchCalls[1].body ?? "{}").body as string;
    expect(body).toContain("**Verdict:** Needs work");
  });

  it("leaves an already-draft PR draft for inconclusive verification", async () => {
    const { publishManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      { ok: true, status: 200, body: [] },
      { ok: true, status: 201, body: { id: 510, html_url: "https://github.com/org/repo/pull/7#issuecomment-510" } },
    ];

    const result = await publishManagedVerificationComment({
      env: { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" } as never,
      target: { prUrl: "https://github.com/org/repo/pull/7" },
      rawVerifierOutput: "",
      fallbackHeadSha: "abc123",
      verifierResult: inconclusiveVerifierResult,
    });

    expect(result).toEqual({
      ok: true,
      commentId: 510,
      action: "created",
      malformed: false,
    });
    // INCONCLUSIVE does not touch PR draft state at all, so no pulls fetch.
    expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET https://api.github.com/repos/org/repo/issues/7/comments?per_page=100",
      "POST https://api.github.com/repos/org/repo/issues/7/comments",
    ]);
  });

  it("leaves a ready PR ready for malformed verification output", async () => {
    const { publishManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      { ok: true, status: 200, body: [] },
      { ok: true, status: 201, body: { id: 511, html_url: "https://github.com/org/repo/pull/7#issuecomment-511" } },
    ];

    const result = await publishManagedVerificationComment({
      env: { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" } as never,
      target: { prUrl: "https://github.com/org/repo/pull/7" },
      rawVerifierOutput: "QA Tester claimed success, but the structured event was malformed.",
      fallbackHeadSha: "abc123",
      verifierResult: {
        verdict: "CONCLUSIVE",
        verifiedHeadSha: "",
        summary: "",
        evidence: [],
        blockers: [],
      },
    });

    expect(result).toEqual({
      ok: true,
      commentId: 511,
      action: "created",
      malformed: true,
    });
    const body = JSON.parse(fetchCalls[1].body ?? "{}").body as string;
    expect(body).toContain("**Verdict:** Needs work");
    expect(body).toContain("QA Tester output was malformed");
    // Malformed output never converts the PR to draft.
    expect(fetchCalls.some((call) => call.url.includes("/graphql"))).toBe(false);
  });

  it("refreshes resolved live PR gate blockers without marking a conclusive PR ready", async () => {
    const { publishManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      { ok: true, status: 200, body: { node_id: "PR_node_7", draft: true, head: { sha: "abc123" } } },
      {
        ok: true,
        status: 200,
        body: {
          check_runs: [{ id: 1, name: "Validate PR Title", status: "completed", conclusion: "success" }],
        },
      },
      {
        ok: true,
        status: 200,
        body: [
          {
            id: 10,
            context: "legacy/status",
            state: "failure",
            updated_at: "2026-04-01T12:00:00Z",
          },
          {
            id: 9,
            context: "legacy/status",
            state: "success",
            updated_at: "2026-04-01T12:01:00Z",
          },
        ],
      },
      { ok: true, status: 200, body: [] },
      { ok: true, status: 201, body: { id: 507, html_url: "https://github.com/org/repo/pull/7#issuecomment-507" } },
      { ok: true, status: 200, body: { node_id: "PR_node_7", draft: true, head: { sha: "abc123" } } },
    ];

    const result = await publishManagedVerificationComment({
      env: { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" } as never,
      target: { prUrl: "https://github.com/org/repo/pull/7" },
      rawVerifierOutput: "",
      fallbackHeadSha: "abc123",
      verifierResult: {
        verdict: "INCONCLUSIVE",
        verifiedHeadSha: "abc123",
        summary: "Blocked by live PR gates.",
        evidence: ["npm test passed."],
        blockers: ["PR is draft.", "Live GitHub check failed: Validate PR Title."],
      },
      refreshLivePrGates: true,
    });

    expect(result).toEqual({
      ok: true,
      commentId: 507,
      action: "created",
      malformed: false,
    });
    expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET https://api.github.com/repos/org/repo/pulls/7",
      "GET https://api.github.com/repos/org/repo/commits/abc123/check-runs?per_page=100&page=1",
      "GET https://api.github.com/repos/org/repo/commits/abc123/statuses?per_page=100&page=1",
      "GET https://api.github.com/repos/org/repo/issues/7/comments?per_page=100",
      "POST https://api.github.com/repos/org/repo/issues/7/comments",
      "GET https://api.github.com/repos/org/repo/pulls/7",
    ]);
    const body = JSON.parse(fetchCalls[4].body ?? "{}").body as string;
    expect(body).toContain("**Verdict:** Pass");
    expect(body).toContain("Verification evidence remains valid; live PR gate blockers are now resolved.");
    expect(body).toContain("### Blockers\n\nNone.");
    expect(body).not.toContain("PR is draft.");
    expect(body).not.toContain("Live GitHub check failed: Validate PR Title.");
    expect(body).not.toContain("Live GitHub check failed: legacy/status.");
  });

  it("preserves QA Tester blockers while refreshing live PR gates", async () => {
    const { publishManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      { ok: true, status: 200, body: { node_id: "PR_node_7", draft: true, head: { sha: "abc123" } } },
      {
        ok: true,
        status: 200,
        body: {
          check_runs: [{ id: 1, name: "Validate PR Title", status: "completed", conclusion: "success" }],
        },
      },
      { ok: true, status: 200, body: [] },
      { ok: true, status: 200, body: [] },
      { ok: true, status: 201, body: { id: 508, html_url: "https://github.com/org/repo/pull/7#issuecomment-508" } },
    ];

    const result = await publishManagedVerificationComment({
      env: { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" } as never,
      target: { prUrl: "https://github.com/org/repo/pull/7" },
      rawVerifierOutput: "",
      fallbackHeadSha: "abc123",
      verifierResult: {
        verdict: "INCONCLUSIVE",
        verifiedHeadSha: "abc123",
        summary: "Backend smoke failed.",
        evidence: [],
        blockers: ["Backend smoke failed.", "Live GitHub check failed: Validate PR Title."],
      },
      refreshLivePrGates: true,
    });

    expect(result).toEqual({
      ok: true,
      commentId: 508,
      action: "created",
      malformed: false,
    });
    const body = JSON.parse(fetchCalls[4].body ?? "{}").body as string;
    expect(body).toContain("**Verdict:** Needs work");
    expect(body).toContain("- Backend smoke failed.");
    expect(body).not.toContain("Live GitHub check failed: Validate PR Title.");
    expect(fetchCalls.some((call) => call.url.includes("/graphql"))).toBe(false);
  });

  it("uses a live-gate summary when a conclusive result becomes blocked by fresh checks", async () => {
    const { publishManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      { ok: true, status: 200, body: { node_id: "PR_node_7", draft: false, head: { sha: "abc123" } } },
      {
        ok: true,
        status: 200,
        body: {
          check_runs: [{ id: 1, name: "Validate PR Title", status: "queued", conclusion: null }],
        },
      },
      { ok: true, status: 200, body: [] },
      { ok: true, status: 200, body: [] },
      { ok: true, status: 201, body: { id: 509, html_url: "https://github.com/org/repo/pull/7#issuecomment-509" } },
    ];

    const result = await publishManagedVerificationComment({
      env: { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" } as never,
      target: { prUrl: "https://github.com/org/repo/pull/7" },
      rawVerifierOutput: "",
      fallbackHeadSha: "abc123",
      verifierResult: conclusiveVerifierResult,
      refreshLivePrGates: true,
    });

    expect(result).toEqual({
      ok: true,
      commentId: 509,
      action: "created",
      malformed: false,
    });
    const body = JSON.parse(fetchCalls[4].body ?? "{}").body as string;
    expect(body).toContain("**Verdict:** Couldn't verify - CI pending");
    expect(body).toContain("Verification evidence remains valid, but live PR gates are still blocking.");
    expect(body).toContain("- Live GitHub check still in progress: Validate PR Title.");
    expect(body).not.toContain("Verified the auth flow end to end.");
    expect(fetchCalls.some((call) => call.url.includes("/graphql"))).toBe(false);
  });

  it("distinguishes failed live PR gates from pending gates", async () => {
    const { publishManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      { ok: true, status: 200, body: { node_id: "PR_node_7", draft: false, head: { sha: "abc123" } } },
      {
        ok: true,
        status: 200,
        body: {
          check_runs: [{ id: 1, name: "Validate PR Title", status: "completed", conclusion: "failure" }],
        },
      },
      { ok: true, status: 200, body: [] },
      { ok: true, status: 200, body: [] },
      { ok: true, status: 201, body: { id: 511, html_url: "https://github.com/org/repo/pull/7#issuecomment-511" } },
    ];

    const result = await publishManagedVerificationComment({
      env: { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" } as never,
      target: { prUrl: "https://github.com/org/repo/pull/7" },
      rawVerifierOutput: "",
      fallbackHeadSha: "abc123",
      verifierResult: conclusiveVerifierResult,
      refreshLivePrGates: true,
    });

    expect(result).toEqual({
      ok: true,
      commentId: 511,
      action: "created",
      malformed: false,
    });
    const body = JSON.parse(fetchCalls[4].body ?? "{}").body as string;
    expect(body).toContain("**Verdict:** Couldn't verify - CI failed");
    expect(body).toContain("- Live GitHub check failed: Validate PR Title.");
    expect(body).not.toContain("**Verdict:** Couldn't verify - CI pending");
  });

  it("does not call GraphQL for a conclusive ready PR", async () => {
    const { publishManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      { ok: true, status: 200, body: [] },
      { ok: true, status: 201, body: { id: 504, html_url: "https://github.com/org/repo/pull/7#issuecomment-504" } },
      { ok: true, status: 200, body: { node_id: "PR_node_7", draft: false, head: { sha: "abc123" } } },
    ];

    const result = await publishManagedVerificationComment({
      env: { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" } as never,
      target: { prUrl: "https://github.com/org/repo/pull/7" },
      rawVerifierOutput: "",
      fallbackHeadSha: "abc123",
      verifierResult: conclusiveVerifierResult,
    });

    expect(result).toEqual({
      ok: true,
      commentId: 504,
      action: "created",
      malformed: false,
    });
    expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET https://api.github.com/repos/org/repo/issues/7/comments?per_page=100",
      "POST https://api.github.com/repos/org/repo/issues/7/comments",
      "GET https://api.github.com/repos/org/repo/pulls/7",
    ]);
  });

  it("rewrites the comment as inconclusive when the current PR head cannot be validated", async () => {
    const { publishManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      { ok: true, status: 200, body: [] },
      { ok: true, status: 201, body: { id: 505, html_url: "https://github.com/org/repo/pull/7#issuecomment-505" } },
      { ok: false, status: 502, body: "bad gateway" },
      {
        ok: true,
        status: 200,
        body: [{ id: 505, body: "<!-- cycloid-qa:v1 owner=org repo=repo pr=7 head=abc123 -->" }],
      },
      { ok: true, status: 200, body: { id: 505 } },
    ];

    const result = await publishManagedVerificationComment({
      env: { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" } as never,
      target: { prUrl: "https://github.com/org/repo/pull/7" },
      rawVerifierOutput: "",
      fallbackHeadSha: "abc123",
      verifierResult: conclusiveVerifierResult,
    });

    expect(result).toEqual({
      ok: true,
      commentId: 505,
      action: "created",
      malformed: false,
    });
    expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET https://api.github.com/repos/org/repo/issues/7/comments?per_page=100",
      "POST https://api.github.com/repos/org/repo/issues/7/comments",
      "GET https://api.github.com/repos/org/repo/pulls/7",
      "GET https://api.github.com/repos/org/repo/issues/7/comments?per_page=100",
      "PATCH https://api.github.com/repos/org/repo/issues/comments/505",
    ]);
    // The head could not be fetched, so the comment is rewritten inconclusive — but the
    // PR draft state is never touched (no GraphQL mutation).
    expect(fetchCalls.some((call) => call.url.includes("/graphql"))).toBe(false);
    const failureBody = JSON.parse(fetchCalls[4].body ?? "{}").body as string;
    expect(failureBody).toContain("**Verdict:** Needs work");
    expect(failureBody).toContain("could not validate the current PR head");
    expect(failureBody).toContain("GitHub PR verification-state lookup failed (502): bad gateway");
    expect(failureBody).not.toContain("**Verdict:** Pass");
  });

  it("flips a passing ci check to failed when live PR gates are blocking", async () => {
    const { publishManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      { ok: true, status: 200, body: { node_id: "PR_node_7", draft: false, head: { sha: "abc123" } } },
      {
        ok: true,
        status: 200,
        body: {
          check_runs: [{ id: 1, name: "Validate PR Title", status: "queued", conclusion: null }],
        },
      },
      { ok: true, status: 200, body: [] },
      { ok: true, status: 200, body: [] },
      { ok: true, status: 201, body: { id: 510, html_url: "https://github.com/org/repo/pull/7#issuecomment-510" } },
    ];

    await publishManagedVerificationComment({
      env: { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" } as never,
      target: { prUrl: "https://github.com/org/repo/pull/7" },
      rawVerifierOutput: "",
      fallbackHeadSha: "abc123",
      verifierResult: {
        ...conclusiveVerifierResult,
        checks: [{ name: "ci", status: "passed", detail: "was green at verification time" }],
      },
      refreshLivePrGates: true,
    });

    const body = JSON.parse(fetchCalls[4].body ?? "{}").body as string;
    expect(body).toContain("**Verdict:** Couldn't verify - CI pending");
    expect(body).toContain("| ci | failed | Live GitHub PR gates are failing or still in progress. |");
    expect(body).not.toContain("was green at verification time");
  });

  it("flips a failed ci row to passed when gates pass even though a static blocker remains", async () => {
    const { publishManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      { ok: true, status: 200, body: { node_id: "PR_node_7", draft: false, head: { sha: "abc123" } } },
      {
        ok: true,
        status: 200,
        body: { check_runs: [{ id: 1, name: "Validate PR Title", status: "completed", conclusion: "success" }] },
      },
      { ok: true, status: 200, body: [] },
      { ok: true, status: 200, body: [] },
      { ok: true, status: 201, body: { id: 511, html_url: "https://github.com/org/repo/pull/7#issuecomment-511" } },
    ];

    await publishManagedVerificationComment({
      env: { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" } as never,
      target: { prUrl: "https://github.com/org/repo/pull/7" },
      rawVerifierOutput: "",
      fallbackHeadSha: "abc123",
      verifierResult: {
        verdict: "INCONCLUSIVE",
        verifiedHeadSha: "abc123",
        summary: "Backend smoke failed.",
        evidence: [],
        checks: [{ name: "ci", status: "failed", detail: "was failing at verification time" }],
        blockers: ["Backend smoke failed.", "Live GitHub check failed: Validate PR Title."],
      },
      refreshLivePrGates: true,
    });

    const body = JSON.parse(fetchCalls[4].body ?? "{}").body as string;
    // Static non-CI blocker keeps the verdict inconclusive, but the ci row must reflect the now-green gates.
    expect(body).toContain("**Verdict:** Needs work");
    expect(body).toContain("- Backend smoke failed.");
    expect(body).toContain("| ci | passed | Live GitHub PR gates passing. |");
    expect(body).not.toContain("| ci | failed");
  });

  it("preserves an explicit skipped ci row instead of claiming a pass when no gates are blocking", async () => {
    const { publishManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    responses = [
      { ok: true, status: 200, body: { node_id: "PR_node_7", draft: false, head: { sha: "abc123" } } },
      { ok: true, status: 200, body: { check_runs: [] } },
      { ok: true, status: 200, body: [] },
      { ok: true, status: 200, body: [] },
      { ok: true, status: 201, body: { id: 512, html_url: "https://github.com/org/repo/pull/7#issuecomment-512" } },
    ];

    await publishManagedVerificationComment({
      env: { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" } as never,
      target: { prUrl: "https://github.com/org/repo/pull/7" },
      rawVerifierOutput: "",
      fallbackHeadSha: "abc123",
      verifierResult: {
        ...conclusiveVerifierResult,
        checks: [{ name: "ci", status: "skipped", detail: "no CI configured for this repo" }],
      },
      refreshLivePrGates: true,
    });

    const body = JSON.parse(fetchCalls[4].body ?? "{}").body as string;
    // With no live gates we cannot prove a pass, so the explicit skipped row stays as-is.
    expect(body).toContain("| ci | skipped | no CI configured for this repo |");
    expect(body).not.toContain("| ci | passed |");
    expect(body).not.toContain("Live GitHub PR gates passing.");
  });
});

describe("renderManagedVerificationComment checks scorecard", () => {
  async function render(result: import("../../../shared/types/sandbox").VerifierTerminalResult): Promise<string> {
    const { renderManagedVerificationComment } =
      await import("../../../apps/control-plane-worker/src/github/verification-comment");
    return renderManagedVerificationComment({ owner: "org", repo: "repo", prNumber: 7, result });
  }

  const base = {
    verdict: "CONCLUSIVE" as const,
    verifiedHeadSha: "abc123",
    summary: "ok",
    evidence: [],
    blockers: [],
  };

  it("renders a table preserving check order, before the Evidence section", async () => {
    const body = await render({
      ...base,
      checks: [
        { name: "lint", status: "passed", detail: "clean" },
        { name: "ci", status: "passed" },
        { name: "runtime", status: "skipped", detail: "no user-visible change" },
      ],
    });
    expect(body).toContain("### Checks");
    expect(body).toContain("| lint | passed | clean |");
    expect(body).toContain("| ci | passed |  |");
    expect(body).toContain("| runtime | skipped | no user-visible change |");
    expect(body.indexOf("### Checks")).toBeLessThan(body.indexOf("### Evidence"));
    expect(body.indexOf("| lint")).toBeLessThan(body.indexOf("| runtime"));
  });

  it("escapes pipes, newlines, and headings so a cell cannot break the table", async () => {
    const body = await render({
      ...base,
      checks: [{ name: "tests", status: "failed", detail: "col1 | col2\n## Injected heading" }],
    });
    expect(body).toContain("| tests | failed | col1 \\| col2 \\#\\# Injected heading |");
    // The injected heading must not render as its own markdown line.
    expect(body.split("\n").some((line) => line.startsWith("## Injected heading"))).toBe(false);
  });

  it("neutralizes markdown links and images so agent text cannot render active markup", async () => {
    const zwsp = "​";
    const body = await render({
      ...base,
      checks: [{ name: "ci", status: "passed", detail: "![x](https://evil.invalid) [link](https://evil.invalid)" }],
    });
    // No active link/image syntax survives, and the bare URL no longer autolinks.
    expect(body).not.toContain("[link](https://evil.invalid)");
    expect(body).not.toContain("![x](https://evil.invalid)");
    expect(body).not.toContain("https://evil.invalid");
    expect(body).toContain(`\\[link\\]\\(https:${zwsp}//evil.invalid\\)`);
  });

  it("breaks bare URL and email autolinks so a detail cannot render a clickable target", async () => {
    const zwsp = "​";
    const body = await render({
      ...base,
      checks: [
        { name: "ci", status: "passed", detail: "see https://evil.invalid or www.evil.invalid or admin@evil.invalid" },
      ],
    });
    // None of the autolink triggers survive contiguously, so GitHub renders literal text.
    expect(body).not.toContain("https://evil.invalid");
    expect(body).not.toContain("www.evil.invalid");
    expect(body).not.toContain("admin@evil.invalid");
    expect(body).toContain(`https:${zwsp}//evil.invalid`);
    expect(body).toContain(`www${zwsp}.evil.invalid`);
    expect(body).toContain(`admin${zwsp}@evil.invalid`);
  });

  it("caps an oversized detail at the render limit", async () => {
    const body = await render({
      ...base,
      checks: [{ name: "tests", status: "passed", detail: "x".repeat(300) }],
    });
    expect(body).toContain(`${"x".repeat(199)}…`);
    expect(body).not.toContain("x".repeat(201));
  });

  it("omits the Checks section entirely when there are no checks", async () => {
    const body = await render(base);
    expect(body).not.toContain("### Checks");
    expect(body).toContain("### Summary");
    expect(body).toContain("### Evidence");
  });
});
