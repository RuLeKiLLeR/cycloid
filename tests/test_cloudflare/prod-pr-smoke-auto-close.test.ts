import { describe, expect, it } from "vitest";

import { isProdPrSmokeSessionForAutoClose } from "../../apps/control-plane-worker/src/session/publish-service";

describe("prod PR smoke auto-close guard", () => {
  it("matches only prod smoke sessions on the verification prod repo", () => {
    expect(
      isProdPrSmokeSessionForAutoClose({
        title: "Prod PR smoke test #1",
        repoOwner: "jeman-verification",
        repoName: "verification-prod",
      }),
    ).toBe(true);
  });

  it("does not match normal sessions on the same repo", () => {
    expect(
      isProdPrSmokeSessionForAutoClose({
        title: "Fix checkout flow",
        repoOwner: "jeman-verification",
        repoName: "verification-prod",
      }),
    ).toBe(false);
  });

  it("does not match smoke-like titles on other repos", () => {
    expect(
      isProdPrSmokeSessionForAutoClose({
        title: "Prod PR smoke test #1",
        repoOwner: "trycycloid",
        repoName: "cycloid",
      }),
    ).toBe(false);
  });
});
