import { describe, expect, it } from "vitest";

import { GithubCheckAutomationPatchBody } from "../../apps/control-plane-worker/src/routes/github-check-automations";

describe("GitHub check automation patch input", () => {
  it("does not materialize omitted fields on an enabled-only update", () => {
    expect(GithubCheckAutomationPatchBody.parse({ enabled: false })).toEqual({ enabled: false });
  });

  it("preserves explicit nullable field updates", () => {
    expect(GithubCheckAutomationPatchBody.parse({ checkName: null, modelId: null, name: null })).toEqual({
      checkName: null,
      modelId: null,
      name: null,
    });
  });
});
