import { afterEach, describe, expect, it } from "vitest";

import {
  assertUrlAllowed,
  maybeHandleKnownExternalFetch,
  resetBlockedTargetsForTest,
} from "../setup/vitest-network-guard";

describe("vitest network guard", () => {
  afterEach(() => {
    resetBlockedTargetsForTest();
  });

  it("treats relative URLs as local-only targets", () => {
    expect(() => assertUrlAllowed("/api/health")).not.toThrow();
    expect(() => assertUrlAllowed("./relative/path")).not.toThrow();
  });

  it("throws a descriptive error for unstubbed OpenAI tool names", async () => {
    await expect(
      maybeHandleKnownExternalFetch("https://api.openai.com/v1/responses", {
        body: JSON.stringify({
          text: {
            format: {
              name: "new_openai_tool",
            },
          },
        }),
      }),
    ).rejects.toThrow("missing stub for OpenAI tool: new_openai_tool");
  });
});
