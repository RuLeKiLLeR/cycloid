import { describe, expect, it } from "vitest";

import type { SessionMetadata } from "../../apps/ui/src/types.js";
import { buildInitialSession } from "../../apps/ui/src/utils/session-seed.js";
import { displayStatusFromPhase } from "../../shared/session/display-status";

const META: SessionMetadata = {
  sessionId: "sess-123",
  phase: "running",
  displayStatus: displayStatusFromPhase("running"),
  prUrl: "https://github.com/org/repo/pull/1",
  createdAt: 1700000000,
  model: { providerID: "openai", modelID: "gpt-5.4-mini" },
  title: "Fix the widget",
  ownerLogin: "alice",
  ownerAvatarUrl: "https://avatars.example.com/alice",
};

const SESSIONS: SessionMetadata[] = [
  META,
  {
    sessionId: "sess-456",
    phase: "idle",
    displayStatus: displayStatusFromPhase("idle"),
    prUrl: null,
    createdAt: 1700000001,
    model: null,
    title: null,
  },
];

describe("buildInitialSession", () => {
  it("returns a SessionDetail seeded from matching metadata", () => {
    const result = buildInitialSession(SESSIONS, "sess-123");
    expect(result).toEqual({
      ...META,
      queueLength: 0,
      repoUrl: null,
      publishStatus: "not_started",
      outcome: null,
      lastBranch: null,
      baseBranch: null,
    });
  });

  it("returns undefined when sessionId is undefined", () => {
    expect(buildInitialSession(SESSIONS, undefined)).toBeUndefined();
  });

  it("returns undefined when sessionId is not found in the list", () => {
    expect(buildInitialSession(SESSIONS, "sess-999")).toBeUndefined();
  });

  it("returns undefined when sessions list is empty", () => {
    expect(buildInitialSession([], "sess-123")).toBeUndefined();
  });

  it("works for a session with minimal metadata (nulls)", () => {
    const result = buildInitialSession(SESSIONS, "sess-456");
    expect(result).toEqual({
      sessionId: "sess-456",
      phase: "idle",
      displayStatus: displayStatusFromPhase("idle"),
      prUrl: null,
      createdAt: 1700000001,
      model: null,
      title: null,
      queueLength: 0,
      repoUrl: null,
      publishStatus: "not_started",
      outcome: null,
      lastBranch: null,
      baseBranch: null,
    });
  });
});
