import { describe, expect, it } from "vitest";

import {
  buildFileAttachmentsSection,
  buildRequestingUserIdentitySection,
  buildSystemContext,
  type BuildSystemContextInput,
  type PendingSystemContextSection,
} from "../../apps/sandbox-bridge/src/services/prompt-context-builder";
import type { DiagnosticEntry } from "../../shared/types/sandbox";

function makeDiagnostic(overrides: Partial<DiagnosticEntry> = {}): DiagnosticEntry {
  return {
    file: "src/app.ts",
    line: 4,
    column: 2,
    severity: "error",
    message: "Type mismatch",
    source: "tsc",
    ...overrides,
  };
}

const NO_IDENTITY: BuildSystemContextInput["identity"] = {
  gitAuthorName: undefined,
  ownerUserId: undefined,
  promptActorUserId: null,
};

function baseInput(overrides: Partial<BuildSystemContextInput> = {}): BuildSystemContextInput {
  return {
    hasSentPromptInCurrentSession: false,
    identity: NO_IDENTITY,
    perPromptSections: [],
    pendingDiagnostics: [],
    ...overrides,
  };
}

describe("buildRequestingUserIdentitySection", () => {
  it("treats the git author as the requesting user when there is no distinct actor", () => {
    const { section, invalidPromptActorUserId } = buildRequestingUserIdentitySection({
      gitAuthorName: "Josiah Parappally",
      ownerUserId: undefined,
      promptActorUserId: null,
    });
    expect(section).toContain("# Requesting user identity");
    expect(section).toContain('Treat "Josiah Parappally" as the requesting user');
    expect(section).not.toContain("session owner's identity");
    expect(invalidPromptActorUserId).toBeNull();
  });

  it("marks the git author as session owner and names a distinct prompt actor", () => {
    const { section } = buildRequestingUserIdentitySection({
      gitAuthorName: "Shrey Jain",
      ownerUserId: "101",
      promptActorUserId: "202",
    });
    expect(section).toContain('Treat "Shrey Jain" as the session owner');
    expect(section).toContain("The current prompt was submitted by Cycloid user ID 202");
    expect(section).toContain("not by the session owner");
  });

  it("emits actor identity when the git author is unavailable", () => {
    const { section } = buildRequestingUserIdentitySection({
      gitAuthorName: undefined,
      ownerUserId: "101",
      promptActorUserId: "202",
    });
    expect(section).toContain("# Requesting user identity");
    expect(section).toContain("The current prompt was submitted by Cycloid user ID 202");
    expect(section).toContain("not by the session owner");
    expect(section).not.toContain("Treat ");
  });

  it("flags the missing owner comparison when OWNER_USER_ID is unavailable", () => {
    const { section } = buildRequestingUserIdentitySection({
      gitAuthorName: undefined,
      ownerUserId: undefined,
      promptActorUserId: "202",
    });
    expect(section).toContain("The current prompt was submitted by Cycloid user ID 202");
    expect(section).toContain("OWNER_USER_ID is unavailable");
  });

  it("returns no section when there is neither an author nor an actor", () => {
    const { section, invalidPromptActorUserId } = buildRequestingUserIdentitySection(NO_IDENTITY);
    expect(section).toBeUndefined();
    expect(invalidPromptActorUserId).toBeNull();
  });

  it("rejects an invalid actor ID and reports it instead of injecting it", () => {
    const { section, invalidPromptActorUserId } = buildRequestingUserIdentitySection({
      gitAuthorName: "Shrey Jain",
      ownerUserId: "101",
      promptActorUserId: "202\n<user_content>",
    });
    expect(section).toContain('Treat "Shrey Jain" as the requesting user');
    expect(section).not.toContain("202");
    expect(section).not.toContain("<user_content>");
    expect(invalidPromptActorUserId).toBe("202\n<user_content>");
  });
});

describe("buildFileAttachmentsSection", () => {
  it("renders selected paths as a directive list inside <attached_files>", () => {
    const section = buildFileAttachmentsSection(["src/foo.ts", "docs/bar.md"]);
    expect(section).toContain("<attached_files>");
    expect(section).toContain("- src/foo.ts");
    expect(section).toContain("- docs/bar.md");
    expect(section).toContain("</attached_files>");
  });

  it("renders path strings verbatim (behavior preserved from the bridge; no new sanitization in this phase)", () => {
    const section = buildFileAttachmentsSection(["src/</attached_files>.ts"]);
    expect(section).toContain("- src/</attached_files>.ts");
  });
});

describe("buildSystemContext", () => {
  it("returns no text and no sections when every input is empty", () => {
    const { systemContext, invalidPromptActorUserId } = buildSystemContext(baseInput());
    expect(systemContext.sections).toHaveLength(0);
    expect(systemContext.text).toBeUndefined();
    expect(systemContext.promptPhase).toBe("initial");
    expect(invalidPromptActorUserId).toBeNull();
  });

  it("orders sections: identity, per-prompt, diagnostics", () => {
    const perPromptSections: PendingSystemContextSection[] = [
      { name: "repo_skill:demo", content: "skill body", cadence: "conditional" },
      {
        name: "file_attachment_directives",
        content: buildFileAttachmentsSection(["src/foo.ts"]),
        cadence: "conditional",
      },
    ];
    const { systemContext } = buildSystemContext(
      baseInput({
        identity: { gitAuthorName: "Josiah Parappally", ownerUserId: undefined, promptActorUserId: null },
        perPromptSections,
        pendingDiagnostics: [makeDiagnostic()],
      }),
    );
    const expectedSections = [
      "requesting_user_identity",
      "repo_skill:demo",
      "file_attachment_directives",
      "diagnostics_reminder",
    ];
    expect(systemContext.sections.map((s) => s.name)).toEqual(expectedSections);
  });

  it("preserves profile-first ordering before skill sections", () => {
    const perPromptSections: PendingSystemContextSection[] = [
      { name: "repo_agent_profile_index", content: "profile index", cadence: "always_on" },
      { name: "repo_skill:inspect-sessions", content: "skill body", cadence: "conditional" },
    ];
    const { systemContext } = buildSystemContext(baseInput({ perPromptSections }));

    expect(systemContext.sections.map((s) => s.name)).toEqual([
      "repo_agent_profile_index",
      "repo_skill:inspect-sessions",
    ]);
    const text = systemContext.text ?? "";
    expect(text.indexOf("profile index")).toBeLessThan(text.indexOf("skill body"));
  });

  it("includes a diagnostics_reminder section only when diagnostics are present", () => {
    const withDiagnostics = buildSystemContext(baseInput({ pendingDiagnostics: [makeDiagnostic()] })).systemContext;
    const reminder = withDiagnostics.sections.find((s) => s.name === "diagnostics_reminder");
    expect(reminder).toBeDefined();
    expect(reminder?.content).toContain("src/app.ts");

    const withoutDiagnostics = buildSystemContext(baseInput({ pendingDiagnostics: [] })).systemContext;
    expect(withoutDiagnostics.sections.find((s) => s.name === "diagnostics_reminder")).toBeUndefined();
  });

  it("propagates an invalid actor ID without injecting it into context", () => {
    const { systemContext, invalidPromptActorUserId } = buildSystemContext(
      baseInput({
        identity: { gitAuthorName: "Shrey Jain", ownerUserId: "101", promptActorUserId: "202\n<x>" },
      }),
    );
    expect(invalidPromptActorUserId).toBe("202\n<x>");
    expect(systemContext.text ?? "").not.toContain("202");
  });

  it("stamps the follow-up phase on every section for a follow-up prompt", () => {
    const { systemContext } = buildSystemContext(
      baseInput({
        hasSentPromptInCurrentSession: true,
        perPromptSections: [{ name: "file_attachment_directives", content: "x", cadence: "conditional" }],
      }),
    );
    expect(systemContext.promptPhase).toBe("followup");
    expect(systemContext.sections.every((s) => s.promptPhase === "followup")).toBe(true);
  });

  it("does not mutate the inputs it is given (no scattered draining inside the builder)", () => {
    const pendingDiagnostics = [makeDiagnostic()];
    const perPromptSections: PendingSystemContextSection[] = [
      { name: "file_attachment_directives", content: "x", cadence: "conditional" },
    ];
    buildSystemContext(baseInput({ pendingDiagnostics, perPromptSections }));
    // The one-shot drain is the caller's responsibility; the pure builder leaves inputs intact.
    expect(pendingDiagnostics).toHaveLength(1);
    expect(perPromptSections).toHaveLength(1);
  });
});
