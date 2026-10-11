import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SsoOrg } from "../../../../../shared/types/bootstrap";
import { HeroNoticeStack } from "./HeroNoticeStack";

const org = (overrides: Partial<SsoOrg> = {}): SsoOrg => ({
  orgId: 1,
  login: "mialabs",
  authorizeUrl: "/auth/github/sso?org=mialabs",
  ...overrides,
});

const integration = (id: "linear" | "notion", label: string) => ({ id, label });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(props: Partial<ComponentProps<typeof HeroNoticeStack>> = {}) {
  const defaults: ComponentProps<typeof HeroNoticeStack> = {
    ssoOrgs: [],
    onRefreshRepos: () => {},
    refreshingRepos: false,
    missingDefaultRepo: false,
    missingModelKey: false,
    disconnectedIntegrationWarnings: [],
    ...props,
  };

  act(() => {
    root.render(
      <MemoryRouter>
        <HeroNoticeStack {...defaults} />
      </MemoryRouter>,
    );
  });
}

describe("HeroNoticeStack", () => {
  it("renders nothing when there are no collapsible notices", () => {
    render();

    expect(container.textContent).toBe("");
  });

  it("renders one active notice directly without a summary button", () => {
    render({ ssoOrgs: [org()] });

    expect(container.textContent).toContain("mialabs requires SSO authorization");
    expect(container.querySelector("button[aria-expanded]")).toBeNull();
  });

  it("uses the generic SSO fragment for a single organization without a login", () => {
    render({ ssoOrgs: [org({ login: null, authorizeUrl: null })] });

    expect(container.textContent).toContain("An organization requires SSO authorization");
    expect(container.querySelector("button[aria-expanded]")).toBeNull();
  });

  it("renders each other single notice directly", () => {
    render({ missingModelKey: true });
    expect(container.textContent).toContain("1 setup step left");
    expect(container.querySelector("a[href='/settings/preferences']")).not.toBeNull();

    act(() =>
      root.render(
        <MemoryRouter>
          <HeroNoticeStack
            disconnectedIntegrationWarnings={[integration("notion", "Notion")]}
            ssoOrgs={[]}
            onRefreshRepos={() => {}}
            refreshingRepos={false}
            missingDefaultRepo={false}
            missingModelKey={false}
          />
        </MemoryRouter>,
      ),
    );
    expect(container.textContent).toContain("Notion disconnected");
    expect(container.querySelector("a[href='/settings/integrations']")).not.toBeNull();
    expect(container.querySelector("button[aria-expanded]")).toBeNull();
  });

  it("collapses multiple notices and expands them with accessible disclosure wiring", () => {
    render({
      ssoOrgs: [org()],
      missingModelKey: true,
      disconnectedIntegrationWarnings: [integration("notion", "Notion")],
    });

    const summary = container.querySelector<HTMLButtonElement>("button");
    expect(summary).not.toBeNull();
    expect(summary?.textContent).toContain("3 notices need attention");
    expect(summary?.textContent).toContain("mialabs SSO");
    expect(summary?.textContent).toContain("1 setup step");
    expect(summary?.textContent).toContain("Notion disconnected");
    expect(summary?.getAttribute("aria-expanded")).toBe("false");
    expect(summary?.getAttribute("role")).toBeNull();
    expect(container.querySelector("[role='status']")?.textContent).toContain("Notion disconnected");
    expect(container.querySelector("[role='alert']")?.textContent).toContain("Notion disconnected");
    expect(container.textContent).not.toContain("mialabs requires SSO authorization");

    act(() => summary?.click());

    const panelId = summary?.getAttribute("aria-controls");
    const panel = panelId ? document.getElementById(panelId) : null;
    expect(summary?.getAttribute("aria-expanded")).toBe("true");
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain("mialabs requires SSO authorization");
    expect(panel?.textContent).toContain("1 setup step left");
    expect(panel?.textContent).toContain("Notion disconnected");
    expect(panel?.querySelector("a[href='/auth/github/sso?org=mialabs']")).not.toBeNull();
    expect(panel?.querySelector("a[href='/settings/preferences']")).not.toBeNull();
    expect(panel?.querySelector("a[href='/settings/integrations']")).not.toBeNull();
  });

  it("summarizes multiple SSO organizations and disconnected integrations", () => {
    render({
      ssoOrgs: [org(), org({ orgId: 2, login: "acme" })],
      disconnectedIntegrationWarnings: [integration("linear", "Linear"), integration("notion", "Notion")],
    });

    expect(container.textContent).toContain("2 notices need attention");
    expect(container.textContent).toContain("2 orgs need SSO");
    expect(container.textContent).toContain("2 integrations disconnected");
  });
});
