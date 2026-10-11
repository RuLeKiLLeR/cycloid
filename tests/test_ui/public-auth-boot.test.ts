import { describe, expect, it } from "vitest";

import { resolvePublicAuthBootAction } from "../../apps/ui/src/public-auth-boot";

describe("public auth boot decision", () => {
  it("enables sign in only after explicit unauthenticated auth", () => {
    expect(resolvePublicAuthBootAction({ status: "unauthenticated" }, 0, 2)).toBe("enable_sign_in");
  });

  it("keeps checking on transient auth", () => {
    expect(resolvePublicAuthBootAction({ status: "transient" }, 0, 2)).toBe("keep_checking");
  });

  it("reloads authenticated public shells within the retry bound", () => {
    expect(resolvePublicAuthBootAction({ status: "authenticated", value: undefined }, 1, 2)).toBe("reload_app");
  });

  it("keeps a neutral shell when authenticated reloads are exhausted", () => {
    expect(resolvePublicAuthBootAction({ status: "authenticated", value: undefined }, 2, 2)).toBe("keep_checking");
  });
});
