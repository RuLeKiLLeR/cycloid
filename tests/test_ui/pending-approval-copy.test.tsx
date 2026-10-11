import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PENDING_APPROVAL_COPY } from "../../apps/ui/src/components/pending-approval-copy";
import { PendingApprovalShell } from "../../apps/ui/src/components/PendingApprovalShell";

const UI_SRC = join(__dirname, "../../apps/ui/src");

describe("PENDING_APPROVAL_COPY", () => {
  it("keeps the pending approval shell free of sign-in CTAs", () => {
    expect(PENDING_APPROVAL_COPY.pending).toEqual({
      title: "Waiting for approval",
      body: "Your Cycloid account is pending review. Email shivam@trycycloid.com for early access.",
    });
    expect(PENDING_APPROVAL_COPY.pending.body).not.toContain("sign in");
  });

  it("keeps the denied shell free of sign-in CTAs", () => {
    expect(PENDING_APPROVAL_COPY.denied).toEqual({
      title: "Access unavailable",
      body: "This account does not have access to Cycloid. Contact your administrator if you believe this is a mistake.",
    });
    expect(PENDING_APPROVAL_COPY.denied.body).not.toContain("sign in");
  });

  it("renders the React pending approval shell without the removed button", () => {
    const html = renderToStaticMarkup(createElement(PendingApprovalShell, { variant: "pending" }));

    expect(html).toContain("Waiting for approval");
    expect(html).not.toContain("Back to sign in");
    expect(html).not.toContain("public-shell__control");
  });

  it("keeps the manual public entry shell free of the removed button copy", () => {
    const publicEntry = readFileSync(join(UI_SRC, "public-main.ts"), "utf-8");

    expect(publicEntry).not.toContain("Back to sign in");
  });
});
