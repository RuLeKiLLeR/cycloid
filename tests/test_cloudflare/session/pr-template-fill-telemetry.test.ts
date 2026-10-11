import { describe, expect, it, vi } from "vitest";

import { logPrTemplateFillEmptySections } from "../../../apps/control-plane-worker/src/session/publish-service";

describe("logPrTemplateFillEmptySections", () => {
  it("logs bounded empty-section telemetry with session and repo context", () => {
    const info = vi.fn();
    logPrTemplateFillEmptySections(
      { info },
      {
        sections: [
          {
            index: 0,
            heading: "Summary",
            kind: "prose",
            text: "Updated the flow.",
            factRefs: null,
            emptyReason: null,
          },
          {
            index: 1,
            heading: "x".repeat(200),
            kind: "empty",
            text: null,
            factRefs: null,
            emptyReason: "y".repeat(300),
          },
        ],
      },
      { sessionId: "sess-1", promptId: "prompt-1", repoOwner: "trycycloid", repoName: "cycloid" },
    );

    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toEqual({
      event: "pr_template_fill.section_empty",
      sessionId: "sess-1",
      promptId: "prompt-1",
      repoOwner: "trycycloid",
      repoName: "cycloid",
      heading: "x".repeat(120),
      emptyReason: "y".repeat(240),
    });
  });

  it("logs each empty section and normalizes null empty reasons", () => {
    const info = vi.fn();
    logPrTemplateFillEmptySections(
      { info },
      {
        sections: [
          {
            index: 0,
            heading: "Implementation",
            kind: "empty",
            text: null,
            factRefs: null,
            emptyReason: null,
          },
          {
            index: 1,
            heading: "Testing",
            kind: "empty",
            text: null,
            factRefs: null,
            emptyReason: "No test section content.",
          },
        ],
      },
      { sessionId: "sess-2", promptId: "prompt-2", repoOwner: "trycycloid", repoName: "cycloid" },
    );

    expect(info).toHaveBeenCalledTimes(2);
    expect(info.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        heading: "Implementation",
        emptyReason: "",
      }),
    );
    expect(info.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        heading: "Testing",
        emptyReason: "No test section content.",
      }),
    );
  });
});
