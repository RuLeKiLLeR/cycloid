import { describe, expect, it } from "vitest";

import { buildSessionFilterText } from "../../apps/ui/src/utils/session-filter";

describe("session filtering", () => {
  it("includes title and repo in searchable session text", () => {
    expect(
      buildSessionFilterText({
        sessionId: "session-1",
        title: "Fix auth redirect",
        repoOwner: "acme",
        repoName: "widget",
      }),
    ).toBe("fix auth redirect session-1 acme widget acme/widget");
  });

  it("handles sessions without optional title metadata", () => {
    expect(
      buildSessionFilterText({
        sessionId: "session-2",
        title: null,
      }),
    ).toBe("session-2");
  });

  it("searches exact automation provenance without guessing legacy automation rows", () => {
    expect(
      buildSessionFilterText({
        sessionId: "session-alert",
        title: "Investigate latency",
        initiationMode: "automation",
        entrypoint: "slack_automation",
      }),
    ).toContain("slack alert");
    expect(
      buildSessionFilterText({
        sessionId: "session-legacy",
        title: null,
        initiationMode: "automation",
        entrypoint: null,
      }),
    ).not.toContain("scheduled");
  });
});
