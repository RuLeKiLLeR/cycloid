import { describe, expect, it } from "vitest";

import {
  buildSubmitPayload,
  getPlaceholder,
  isStatusDisabled,
  parseAtTokens,
  partitionFilesByKind,
  prepareImageSelectionCandidates,
} from "../../apps/ui/src/utils/prompt-form";

describe("parseAtTokens", () => {
  const cache = ["src/file1.ts", "src/file2.ts", "README.md"];

  it("returns matched paths from text", () => {
    expect(parseAtTokens("Check @src/file1.ts please", cache)).toEqual(["src/file1.ts"]);
  });

  it("dedupes repeated tokens", () => {
    expect(parseAtTokens("@src/file1.ts and @src/file1.ts again", cache)).toEqual(["src/file1.ts"]);
  });

  it("excludes paths not in cache", () => {
    expect(parseAtTokens("@src/file1.ts @does/not/exist.ts", cache)).toEqual(["src/file1.ts"]);
  });

  it("returns empty array when no @ tokens are present", () => {
    expect(parseAtTokens("no tokens here", cache)).toEqual([]);
  });

  it("returns empty array when cache is null", () => {
    expect(parseAtTokens("@anything.ts", null)).toEqual([]);
  });

  it("does not include @ symbol embedded mid-word (e.g. email-style)", () => {
    // Anchor: token must follow start-of-string or whitespace. "user@example.com" should not match.
    expect(parseAtTokens("user@src/file1.ts", cache)).toEqual([]);
  });

  it("returns empty array when no text matches any cache entry", () => {
    expect(parseAtTokens("@nonexistent.ts", cache)).toEqual([]);
  });
});

describe("isStatusDisabled", () => {
  it("returns true for stopped + stopMode=user (hard stop)", () => {
    expect(isStatusDisabled({ phase: "stopped", stopMode: "user" })).toBe(true);
  });

  it("returns false for stopped + stopMode=resumable (textarea enabled, prompt cold-spawns sandbox)", () => {
    expect(isStatusDisabled({ phase: "stopped", stopMode: "resumable" })).toBe(false);
  });

  it("returns true for archived phase", () => {
    expect(isStatusDisabled({ phase: "archived" })).toBe(true);
  });

  it("returns false for running + creating substate (sandbox spinning up)", () => {
    expect(isStatusDisabled({ phase: "running", sandboxSubstate: "creating" })).toBe(false);
  });

  it("returns false for idle phase", () => {
    expect(isStatusDisabled({ phase: "idle" })).toBe(false);
  });

  it("returns false for running phase", () => {
    expect(isStatusDisabled({ phase: "running" })).toBe(false);
  });

  it("returns false for completed phase (follow-up prompts allowed)", () => {
    expect(isStatusDisabled({ phase: "completed" })).toBe(false);
  });

  it("returns true for blocked phase", () => {
    expect(isStatusDisabled({ phase: "blocked" })).toBe(true);
  });

  it("returns true for failed phase", () => {
    expect(isStatusDisabled({ phase: "failed" })).toBe(true);
  });

  it("returns true for finalizing phase", () => {
    expect(isStatusDisabled({ phase: "finalizing" })).toBe(true);
  });

  it("returns false for waiting_for_input phase", () => {
    expect(isStatusDisabled({ phase: "waiting_for_input" })).toBe(false);
  });

  it("keeps the composer enabled while parked on a plan (Discuss channel)", () => {
    // A parked plan projects waiting_for_input; the composer must stay enabled
    // because it IS the Discuss channel. planApprovalPending never disables send.
    expect(isStatusDisabled({ phase: "waiting_for_input", planApprovalPending: true })).toBe(false);
  });
});

describe("getPlaceholder", () => {
  it("returns repo prompt when externally disabled", () => {
    expect(getPlaceholder({ phase: "idle" }, true)).toBe("Select a repo to start");
  });

  it("returns queued message for running + creating substate", () => {
    expect(getPlaceholder({ phase: "running", sandboxSubstate: "creating" }, false)).toBe(
      "Starting your environment… prompt will be queued",
    );
  });

  it("returns custom placeholder when provided", () => {
    expect(getPlaceholder({ phase: "running", sandboxSubstate: "creating" }, false, "Resuming session…")).toBe(
      "Resuming session…",
    );
  });

  it("returns queue message for running phase", () => {
    expect(getPlaceholder({ phase: "running" }, false)).toBe("Queue a follow-up prompt…");
  });

  it("returns disabled failure copy for failed phase", () => {
    expect(getPlaceholder({ phase: "failed" }, false)).toBe("Session failed - prompts are disabled");
  });

  it("returns attention copy for blocked phase", () => {
    expect(getPlaceholder({ phase: "blocked" }, false)).toBe("Cycloid is blocked and needs your attention");
  });

  it("returns stopped-by-user hint for stopped + stopMode=user", () => {
    expect(getPlaceholder({ phase: "stopped", stopMode: "user" }, false)).toBe(
      "Session was stopped by you. Click Resume to continue.",
    );
  });

  it("returns resume hint for stopped + stopMode=resumable", () => {
    expect(getPlaceholder({ phase: "stopped", stopMode: "resumable" }, false)).toBe(
      "Send a prompt to resume - a fresh environment will start.",
    );
  });

  it("returns not accepting message for archived phase", () => {
    expect(getPlaceholder({ phase: "archived" }, false)).toBe("Session is not accepting prompts");
  });

  it("returns default prompt for idle phase", () => {
    expect(getPlaceholder({ phase: "idle" }, false)).toBe("Enter a prompt…");
  });

  it("uses custom placeholder for idle phase when provided", () => {
    expect(getPlaceholder({ phase: "idle" }, false, "Ask anything")).toBe("Ask anything");
  });

  it("externalDisabled takes priority over phase", () => {
    expect(getPlaceholder({ phase: "running", sandboxSubstate: "creating" }, true)).toBe("Select a repo to start");
    expect(getPlaceholder({ phase: "running" }, true)).toBe("Select a repo to start");
  });

  it("swaps to the Discuss hint while parked on a plan", () => {
    // The park projects waiting_for_input; the composer routes to Discuss, so the
    // placeholder must steer there instead of the "answer the question" copy.
    expect(getPlaceholder({ phase: "waiting_for_input", planApprovalPending: true }, false)).toBe("Discuss the plan…");
  });

  it("keeps the question copy for a real pending question (not parked)", () => {
    expect(getPlaceholder({ phase: "waiting_for_input" }, false)).toBe(
      "Answer the question or queue a follow-up prompt…",
    );
  });
});

describe("prepareImageSelectionCandidates", () => {
  it("preserves provided file name", () => {
    const file = new File(["x"], "shot.png", { type: "image/png" });
    expect(prepareImageSelectionCandidates([file], 1234)).toEqual([
      { file, name: "shot.png", size: file.size, type: "image/png" },
    ]);
  });

  it("synthesizes a name when missing", () => {
    const file = new File(["x"], "", { type: "image/jpeg" });
    expect(prepareImageSelectionCandidates([file], 9999)[0]?.name).toBe("image-9999-0.jpeg");
  });

  it("infers an image media type for extension-only image files", () => {
    const file = new File(["x"], "shot.JPG", { type: "" });
    expect(prepareImageSelectionCandidates([file], 1234)[0]?.type).toBe("image/jpeg");
  });

  it("infers an image media type for generic browser file types", () => {
    const file = new File(["x"], "shot.png", { type: "application/octet-stream" });
    expect(prepareImageSelectionCandidates([file], 1234)[0]?.type).toBe("image/png");
  });
});

describe("partitionFilesByKind", () => {
  it("classifies files with allowed image media types as images", () => {
    const file = new File(["image"], "upload", { type: "image/png" });

    expect(partitionFilesByKind([file])).toEqual({ images: [file], nonImages: [] });
  });

  it("classifies files with image extensions as images when the media type is missing", () => {
    const file = new File(["image"], "shot.PNG", { type: "" });

    expect(partitionFilesByKind([file])).toEqual({ images: [file], nonImages: [] });
  });

  it("does not classify explicitly non-image media types by extension alone", () => {
    const file = new File(["image"], "shot.png", { type: "text/plain" });

    expect(partitionFilesByKind([file])).toEqual({ images: [], nonImages: [file] });
  });

  it("classifies text files as non-images", () => {
    const file = new File(["notes"], "notes.txt", { type: "text/plain" });

    expect(partitionFilesByKind([file])).toEqual({ images: [], nonImages: [file] });
  });

  it("classifies JSON files as non-images", () => {
    const file = new File(['{"ok":true}'], "data.json", { type: "application/json" });

    expect(partitionFilesByKind([file])).toEqual({ images: [], nonImages: [file] });
  });
});

describe("buildSubmitPayload", () => {
  const base = {
    prompt: "do something",
    skills: [] as string[],
    attachedFiles: [] as string[],
    uploadedFiles: [],
    uploadedImages: [],
    reasoningEffort: undefined,
    planMode: undefined,
  };

  it("omits empty optional arrays", () => {
    expect(buildSubmitPayload(base)).toEqual({
      prompt: "do something",
      skills: undefined,
      files: undefined,
      uploadedFiles: undefined,
      uploadedImages: undefined,
      reasoningEffort: undefined,
    });
  });
});
