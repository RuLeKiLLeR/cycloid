import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PublicAccessShell } from "./PublicAccessShell";

describe("PublicAccessShell", () => {
  it("shows the GitHub CTA label when idle", () => {
    const html = renderToStaticMarkup(createElement(PublicAccessShell, { actionLabel: "Completing sign in" }));
    expect(html).toContain("Continue with GitHub");
    expect(html).not.toContain("Completing sign in");
  });

  it("surfaces the pending actionLabel while a sign-in is completing", () => {
    const html = renderToStaticMarkup(
      createElement(PublicAccessShell, { actionLabel: "Completing sign in", pending: true }),
    );
    expect(html).toContain("Completing sign in");
    expect(html).not.toContain("Continue with GitHub");
  });

  it("uses actionLabel for the retry control", () => {
    const html = renderToStaticMarkup(
      createElement(PublicAccessShell, { actionLabel: "Try again", onRetry: () => {} }),
    );
    expect(html).toContain("Try again");
    expect(html).not.toContain("Continue with GitHub");
    expect(html).not.toContain("/auth/github");
  });

  it("can render a neutral pending state without a provider CTA", () => {
    const html = renderToStaticMarkup(
      createElement(PublicAccessShell, { actionLabel: "Checking access", pending: true, showAction: false }),
    );
    expect(html).toContain("Checking access");
    expect(html).not.toContain("Continue with GitHub");
    expect(html).not.toContain("/auth/github");
  });
});
