import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SsoOrg } from "../../../../shared/types/bootstrap";
import { SsoOrgsNotice } from "./SsoOrgsNotice";

function org(overrides: Partial<SsoOrg> = {}): SsoOrg {
  return {
    orgId: 1,
    login: "mialabs",
    authorizeUrl: "https://github.com/orgs/mialabs/sso",
    ...overrides,
  };
}

function render(ssoOrgs: SsoOrg[]): string {
  return renderToStaticMarkup(<SsoOrgsNotice ssoOrgs={ssoOrgs} onRefresh={() => {}} refreshing={false} />);
}

describe("SsoOrgsNotice", () => {
  it("renders nothing without SSO orgs", () => {
    expect(render([])).toBe("");
  });

  it("renders a single org as one row without a duplicate heading", () => {
    const html = render([org()]);
    expect(html).toContain("mialabs");
    expect(html).toContain("requires SSO authorization");
    expect(html).not.toContain("needs SSO authorization");
    expect(html).toContain("Authorize");
    expect(html).toContain('href="https://github.com/orgs/mialabs/sso"');
    expect(html).toContain("Refresh repositories");
  });

  it("renders a counted heading plus one row per org for multiple orgs", () => {
    const html = render([org(), org({ orgId: 2, login: "acme" })]);
    expect(html).toContain("2 organizations need SSO authorization");
    expect(html).toContain("mialabs");
    expect(html).toContain("acme");
  });

  it("omits the Authorize action when no authorize URL exists", () => {
    const html = render([org({ authorizeUrl: null })]);
    expect(html).not.toContain("Authorize");
  });

  it("renders the Authorize action for same-origin relative paths", () => {
    const html = render([org({ authorizeUrl: "/auth/github/sso?org=mialabs" })]);
    expect(html).toContain("Authorize");
    expect(html).toContain('href="/auth/github/sso?org=mialabs"');
  });

  it("omits the Authorize action for non-HTTPS or protocol-relative URLs", () => {
    expect(render([org({ authorizeUrl: "http://github.com/orgs/mialabs/sso" })])).not.toContain("Authorize");
    expect(render([org({ authorizeUrl: "//evil.example.com/sso" })])).not.toContain("Authorize");
  });
});
