import { describe, expect, it } from "vitest";

import { appendSessionLink, normalizeSessionLinks } from "../../apps/control-plane-worker/src/session/pr-body";

const SESSION_ID = "sess-abc123";
const FRONTEND_URL = "https://app.trycycloid.com";

describe("appendSessionLink", () => {
  it("appends session transcript link to body", () => {
    const result = appendSessionLink("## Changes\nSome diff", SESSION_ID, FRONTEND_URL);
    expect(result).toBe(`## Changes\nSome diff\n\n📋 [Session transcript](${FRONTEND_URL}/sessions/${SESSION_ID})`);
  });

  it("deduplicates when body already contains the session link", () => {
    const body = `## Changes\nSome diff\n\n📋 [Session transcript](${FRONTEND_URL}/sessions/${SESSION_ID})`;
    expect(appendSessionLink(body, SESSION_ID, FRONTEND_URL)).toBe(body);
  });

  it("normalizes existing session links away from control-plane tunnel URLs", () => {
    const body = [
      "## Evidence Bundle",
      "- Session: https://temporary.ngrok-free.dev/sessions/sess-abc123",
      "",
      "📋 [Session transcript](https://temporary.ngrok-free.dev/sessions/sess-abc123)",
    ].join("\n");

    const result = appendSessionLink(body, SESSION_ID, FRONTEND_URL);

    expect(result).not.toContain("temporary.ngrok-free.dev");
    expect(result.match(new RegExp(`${FRONTEND_URL}/sessions/${SESSION_ID}`, "g"))).toHaveLength(2);
  });

  it("normalizes existing session links before checking for the transcript footer", () => {
    const body = "## Evidence Bundle\n- Session: http://localhost:5173/sessions/sess-abc123";
    expect(appendSessionLink(body, SESSION_ID, FRONTEND_URL)).toBe(
      `## Evidence Bundle\n- Session: ${FRONTEND_URL}/sessions/${SESSION_ID}`,
    );
  });

  it("does not rewrite artifact API URLs", () => {
    const body =
      "![after](https://temporary.ngrok-free.dev/api/sessions/sess-abc123/artifacts/artifact-1/after.png?artifactToken=token)";
    expect(normalizeSessionLinks(body, SESSION_ID, FRONTEND_URL)).toBe(body);
  });

  it("does not deduplicate when body contains a different session ID", () => {
    const body = `## Changes\nSome diff\n\n📋 [Session transcript](${FRONTEND_URL}/sessions/sess-other)`;
    const result = appendSessionLink(body, SESSION_ID, FRONTEND_URL);
    expect(result).toContain(`${FRONTEND_URL}/sessions/${SESSION_ID}`);
    // Should have both links
    expect(result).toContain(`${FRONTEND_URL}/sessions/sess-other`);
  });

  it("works with fallback body containing footer", () => {
    const body = "## Changes\nUpdated files\n\n🤖 Generated with [Cycloid](https://trycycloid.com)";
    const result = appendSessionLink(body, SESSION_ID, FRONTEND_URL);
    expect(result).toBe(`${body}\n\n📋 [Session transcript](${FRONTEND_URL}/sessions/${SESSION_ID})`);
  });

  it("works with empty body", () => {
    const result = appendSessionLink("", SESSION_ID, FRONTEND_URL);
    expect(result).toBe(`\n\n📋 [Session transcript](${FRONTEND_URL}/sessions/${SESSION_ID})`);
  });

  it("preserves Linear link when both are applied", () => {
    const bodyWithLinear =
      "Resolves [ARC-123](https://linear.app/cycloid2/issue/ARC-123/foo)\n\n## Summary\n- Fixed bug\n\n🤖 Generated with [Cycloid](https://trycycloid.com)";
    const result = appendSessionLink(bodyWithLinear, SESSION_ID, FRONTEND_URL);
    expect(result).toContain("Resolves [ARC-123]");
    expect(result).toContain(`📋 [Session transcript](${FRONTEND_URL}/sessions/${SESSION_ID})`);
  });

  it("appends the session link for public repos too", () => {
    const body = "## Changes\nPublic repo update";
    expect(appendSessionLink(body, SESSION_ID, FRONTEND_URL)).toBe(
      `## Changes\nPublic repo update\n\n📋 [Session transcript](${FRONTEND_URL}/sessions/${SESSION_ID})`,
    );
  });
});
