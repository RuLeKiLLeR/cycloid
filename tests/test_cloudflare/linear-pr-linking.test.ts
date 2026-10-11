import { describe, expect, it } from "vitest";

import { appendLinearLink } from "../../apps/control-plane-worker/src/session/pr-body";

const SAMPLE_CONTEXT = {
  identifier: "ARC-241",
  url: "https://linear.app/cycloid2/issue/ARC-241/token-counter-still-appears-incorrect",
};

describe("appendLinearLink", () => {
  it("prepends a bare-URL Resolves magic word to the body", () => {
    const result = appendLinearLink("## Changes\nSome diff", SAMPLE_CONTEXT);
    expect(result).toBe(`Resolves ${SAMPLE_CONTEXT.url}\n\n## Changes\nSome diff`);
  });

  it("returns body unchanged when no linear context", () => {
    const body = "## Changes\nSome diff";
    expect(appendLinearLink(body)).toBe(body);
    expect(appendLinearLink(body, undefined)).toBe(body);
  });

  it("returns body unchanged when identifier is empty", () => {
    const body = "test";
    expect(appendLinearLink(body, { identifier: "", url: SAMPLE_CONTEXT.url })).toBe(body);
  });

  it("returns body unchanged when url is empty", () => {
    const body = "test";
    expect(appendLinearLink(body, { identifier: "ARC-241", url: "" })).toBe(body);
  });

  it("returns body unchanged when identifier is not a valid ticket key", () => {
    const body = "test";
    // Lowercase / malformed identifiers must not reach the PR body.
    expect(appendLinearLink(body, { identifier: "arc-241", url: SAMPLE_CONTEXT.url })).toBe(body);
    expect(appendLinearLink(body, { identifier: "not a key", url: SAMPLE_CONTEXT.url })).toBe(body);
  });

  it("returns body unchanged when url is not an https linear.app URL", () => {
    const body = "test";
    expect(appendLinearLink(body, { identifier: "ARC-241", url: "https://example.com/issue/123" })).toBe(body);
    // Host-prefix spoof must be rejected by strict hostname check.
    expect(appendLinearLink(body, { identifier: "ARC-241", url: "https://linear.app.evil.com/issue/ARC-241" })).toBe(
      body,
    );
    // Non-https scheme rejected.
    expect(appendLinearLink(body, { identifier: "ARC-241", url: "http://linear.app/x/issue/ARC-241" })).toBe(body);
    // Unparseable URL rejected.
    expect(appendLinearLink(body, { identifier: "ARC-241", url: "not a url" })).toBe(body);
  });

  // ARC-947 regression: raw Linear URL elsewhere in body (e.g. Evidence Bundle)
  // must NOT suppress the explicit `Resolves` line. Dedup keys on `Resolves <url>`,
  // not a bare URL appearing anywhere.
  it("still prepends Resolves line when raw URL appears in Evidence Bundle", () => {
    const body = [
      "## Summary",
      "- Fixed token counter.",
      "",
      "## Evidence Bundle",
      `- Issue: ${SAMPLE_CONTEXT.url}`,
    ].join("\n");

    const result = appendLinearLink(body, SAMPLE_CONTEXT);
    expect(result.startsWith(`Resolves ${SAMPLE_CONTEXT.url}`)).toBe(true);
  });

  it("deduplicates when body already contains the bare-URL Resolves form", () => {
    const body = `## Changes\nSome diff\n\nResolves ${SAMPLE_CONTEXT.url}`;
    expect(appendLinearLink(body, SAMPLE_CONTEXT)).toBe(body);
  });

  it("deduplicates when body contains bare Resolves TICKET-ID (bridge-generated)", () => {
    const body = "## Summary\n- Fixed token counter\n\nResolves ARC-241";
    expect(appendLinearLink(body, SAMPLE_CONTEXT)).toBe(body);
  });

  it("deduplicates the legacy markdown-link Resolves form (avoids duplicate on republish)", () => {
    // PRs opened before the bare-URL switch carry `Resolves [ARC-241](url)`; republishing
    // must not append a second Resolves line.
    const body = `## Changes\nSome diff\n\nResolves [ARC-241](${SAMPLE_CONTEXT.url})`;
    expect(appendLinearLink(body, SAMPLE_CONTEXT)).toBe(body);
  });

  it("does not deduplicate on partial identifier match", () => {
    // ARC-24 should not match ARC-241
    const body = "Resolves ARC-24\nSome changes";
    const result = appendLinearLink(body, SAMPLE_CONTEXT);
    expect(result.startsWith(`Resolves ${SAMPLE_CONTEXT.url}`)).toBe(true);
  });
});
