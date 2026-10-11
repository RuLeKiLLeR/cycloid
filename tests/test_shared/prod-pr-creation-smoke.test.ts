import { describe, expect, it } from "vitest";

import {
  buildStartSessionBody,
  escapeMarkdownTableCell,
  isTerminalSessionPhase,
  normalizeCloseReason,
  sessionPhaseOf,
} from "../../scripts/prod-pr-creation-smoke";

describe("prod PR creation smoke runner helpers", () => {
  it("escapes pipes and newlines in markdown table cells", () => {
    expect(escapeMarkdownTableCell('400 {"code":"rate_limit|exceeded"}\nretry later')).toBe(
      '400 {"code":"rate_limit\\|exceeded"}<br>retry later',
    );
  });

  it("preserves empty string close reasons as terminal values", () => {
    expect(normalizeCloseReason({ closeReason: "" })).toBe("");
  });

  it("normalizes missing close reasons to null", () => {
    expect(normalizeCloseReason({})).toBeNull();
    expect(normalizeCloseReason({ closeReason: null })).toBeNull();
  });

  it("reads phase as the session lifecycle field", () => {
    expect(sessionPhaseOf({ phase: "failed" })).toBe("failed");
    expect(sessionPhaseOf({})).toBe("");
  });

  it("treats terminal session phases as polling endpoints", () => {
    expect(isTerminalSessionPhase("completed")).toBe(true);
    expect(isTerminalSessionPhase("failed")).toBe(true);
    expect(isTerminalSessionPhase("running")).toBe(false);
  });

  it("adds model and auto-verify only when requested", () => {
    expect(
      buildStartSessionBody(
        { repoUrl: "https://github.com/acme/widgets", model: "claude-opus-4-8", autoVerify: true },
        2,
      ),
    ).toEqual({
      repoUrl: "https://github.com/acme/widgets",
      title: "Prod PR smoke test #2",
      model: "claude-opus-4-8",
      autoVerify: true,
    });

    expect(buildStartSessionBody({ repoUrl: "https://github.com/acme/widgets", autoVerify: false }, 1)).toEqual({
      repoUrl: "https://github.com/acme/widgets",
      title: "Prod PR smoke test #1",
    });
  });
});
