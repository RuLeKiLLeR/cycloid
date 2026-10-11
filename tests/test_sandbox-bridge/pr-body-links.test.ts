import { describe, expect, it } from "vitest";

import { stripLlmAuthoredAbsoluteUrls } from "../../apps/sandbox-bridge/src/utils/pr-body-links.js";

describe("pr-body link utilities", () => {
  it("strips markdown image links from LLM-authored prose without leaving empty image syntax", () => {
    const stripped = stripLlmAuthoredAbsoluteUrls(
      "See ![screenshot](https://ci.internal/shot.png) and [preview](https://ci.internal/preview).",
    );

    expect(stripped).toBe("See screenshot and preview.");
  });
});
