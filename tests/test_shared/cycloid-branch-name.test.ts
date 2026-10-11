import { describe, expect, it } from "vitest";

import {
  appendCollisionSuffix,
  buildCycloidBranchBaseNameFromSafeHint,
  buildCycloidBranchCollisionSuffix,
  buildSafeCycloidBranchHint,
  COLLISION_SUFFIX_LENGTH,
  prependTicketKeyToBranchHint,
} from "../../shared/utils/cycloid-branch-name.js";

describe("buildSafeCycloidBranchHint", () => {
  it("strips leading conversational filler from deterministic branch hints", () => {
    expect(buildSafeCycloidBranchHint("please make the images on this 4:3 aspect ratio")).toBe(
      "images-on-this-4-3-aspect-ratio",
    );
    expect(buildSafeCycloidBranchHint("can you just fix the queue for me")).toBe("fix-the-queue");
  });

  it.each([
    ["pls fix the header"],
    ["could you fix the header"],
    ["would you fix the header"],
    ["hey fix the header"],
    ["hi fix the header"],
    ["help me fix the header"],
    ["i want to fix the header"],
    ["i'd like to fix the header"],
    ["we need to fix the header"],
    ["let's fix the header"],
    ["lets fix the header"],
    ["go ahead and fix the header"],
    ["implement linear ticket fix the header"],
    ["implement ticket fix the header"],
  ])("strips %s", (prompt) => {
    expect(buildSafeCycloidBranchHint(prompt)).toBe("fix-the-header");
  });

  it("keeps the original text when filler stripping would empty the hint", () => {
    expect(buildSafeCycloidBranchHint("please for me")).toBe("please-for-me");
  });

  it("continues to redact sensitive deterministic branch hints", () => {
    expect(buildSafeCycloidBranchHint("please rotate production token abc1234567890abcdef")).toBe("");
  });

  it("redacts emails and opaque tokens before stripping conversational filler", () => {
    expect(buildSafeCycloidBranchHint("hi@example.com account issue")).toBe("account-issue");
    expect(buildSafeCycloidBranchHint("just-abcdef1234567890")).toBe("");
  });
});

describe("buildCycloidBranchBaseNameFromSafeHint", () => {
  it.each([
    ["fix prompt attachment path validation fallback handling", "fix-prompt-attachment-path-validation-fallback"],
    ["fix prompt attachment path validation feature fallback", "fix-prompt-attachment-path-validation-feature"],
    ["change for the deployed feature branch title generation", "change-for-the-deployed-feature-branch-title"],
    [
      "currently we have too much buttons going on if the transcript is long",
      "currently-we-have-too-much-buttons-going-on-if",
    ],
  ])("truncates %s at a word boundary", (hint, expected) => {
    expect(buildCycloidBranchBaseNameFromSafeHint(hint)).toBe(expected);
  });

  it("keeps a partial segment when dropping it would over-shorten the slug", () => {
    expect(buildCycloidBranchBaseNameFromSafeHint("shortword veryveryveryveryveryveryveryveryverylong suffix")).toBe(
      "shortword-veryveryveryveryveryveryveryveryverylo",
    );
  });
});

describe("buildCycloidBranchCollisionSuffix", () => {
  it("returns a deterministic short hex suffix", () => {
    const sessionId = "session-with-non-hex-tail";
    const suffix = buildCycloidBranchCollisionSuffix(sessionId);

    expect(suffix).toMatch(/^[0-9a-f]{4}$/);
    expect(suffix).toHaveLength(COLLISION_SUFFIX_LENGTH);
    expect(buildCycloidBranchCollisionSuffix(sessionId)).toBe(suffix);
  });

  it("mixes salt into the deterministic suffix", () => {
    const sessionId = "f2cd772c-1ef2-448f-9d94-d06e37a56486";

    expect(buildCycloidBranchCollisionSuffix(sessionId, 0)).not.toBe(buildCycloidBranchCollisionSuffix(sessionId, 1));
  });
});

describe("appendCollisionSuffix", () => {
  it("returns the suffix when the base is empty", () => {
    expect(appendCollisionSuffix("", "a1b2")).toBe("a1b2");
  });

  it("returns the base when the suffix is empty or unsanitizable", () => {
    expect(appendCollisionSuffix("feature-branch", "")).toBe("feature-branch");
    expect(appendCollisionSuffix("feature-branch", "!!!")).toBe("feature-branch");
  });

  it("falls back when both base and suffix are empty after sanitization", () => {
    expect(appendCollisionSuffix("", "")).toBe("session-work");
    expect(appendCollisionSuffix("!!!", "???")).toBe("session-work");
  });

  it("preserves the suffix within the branch length cap", () => {
    const base = "this-is-a-max-length-branch-slug-that-fills-all-characters";
    const result = appendCollisionSuffix(base, "a1b2");

    expect(result).toHaveLength(48);
    expect(result).toMatch(/-a1b2$/);
    expect(result.endsWith("-")).toBe(false);
  });
});

describe("prependTicketKeyToBranchHint", () => {
  it("prepends a lowercased key to a short hint", () => {
    expect(prependTicketKeyToBranchHint("arc-746", "stop-nulling-intent-summaries")).toBe(
      "arc-746-stop-nulling-intent-summaries",
    );
  });

  it("returns the hint unchanged when no key is provided", () => {
    expect(prependTicketKeyToBranchHint("", "fix-the-thing")).toBe("fix-the-thing");
    expect(prependTicketKeyToBranchHint(undefined, "fix-the-thing")).toBe("fix-the-thing");
  });

  it("returns the key alone when the hint is empty", () => {
    expect(prependTicketKeyToBranchHint("arc-746", "")).toBe("arc-746");
    expect(prependTicketKeyToBranchHint("arc-746", undefined)).toBe("arc-746");
  });

  it("does not double-prefix when the hint already begins with the key segment", () => {
    expect(prependTicketKeyToBranchHint("arc-746", "arc-746-already-prefixed")).toBe("arc-746-already-prefixed");
    expect(prependTicketKeyToBranchHint("arc-746", "arc-746")).toBe("arc-746");
  });

  it("removes embedded copies of the key before prefixing", () => {
    const hint = buildSafeCycloidBranchHint("Implement Linear ticket ARC-1529 - SEC-30 fix button styles");

    expect(prependTicketKeyToBranchHint("arc-1529", hint)).toBe("arc-1529-sec-30-fix-button-styles");
    expect(prependTicketKeyToBranchHint("arc-1529", "arc-1529-sec-30-arc-1529")).toBe("arc-1529-sec-30");
  });

  it("treats a numeric-suffix near-match as a distinct key (no false double-prefix)", () => {
    // `arc-7460-...` must NOT be treated as already-prefixed by `arc-746`.
    expect(prependTicketKeyToBranchHint("arc-746", "arc-7460-other")).toBe("arc-746-arc-7460-other");
  });

  it("preserves the key and truncates the concept tail when over the length cap", () => {
    const longHint = "this-is-a-very-long-concept-slug-that-exceeds-the-branch-slug-length-limit";
    const result = prependTicketKeyToBranchHint("arc-746", longHint);
    expect(result.startsWith("arc-746-")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(48);
    expect(result.endsWith("-")).toBe(false);
  });

  it("sanitizes a key passed with unsafe characters", () => {
    // Defensive: callers pass already-validated keys, but the helper must never emit
    // an unsanitized segment.
    expect(prependTicketKeyToBranchHint("ARC-746", "fix")).toBe("arc-746-fix");
  });
});
