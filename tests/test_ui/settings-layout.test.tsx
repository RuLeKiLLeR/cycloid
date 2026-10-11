import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  SettingsField,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  SettingsSkeleton,
} from "../../apps/ui/src/components/settings/SettingsLayout";

function countTag(html: string, tag: string): number {
  return html.split(`<${tag}`).length - 1;
}

describe("SettingsRow", () => {
  it("renders a title-only row with no description, hint, error, or badge layers", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsRow, { title: "Respond on PRs", control: createElement("button", null, "toggle") }),
    );
    expect(html).toContain("Respond on PRs");
    expect(html).not.toContain('role="alert"');
    // Title renders in a <span> (not <p>) so a caller passing block content can't
    // produce invalid <p>-nested markup; with no description/hint/error there are
    // no secondary <p> layers.
    expect(countTag(html, "p")).toBe(0);
  });

  it("renders the description when provided", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsRow, {
        title: "Respond on PRs",
        description: "Cycloid keeps working on the PRs you opened.",
        control: createElement("button", null, "toggle"),
      }),
    );
    expect(html).toContain("Cycloid keeps working on the PRs you opened.");
    // Only the description is a <p>; the title is a <span>.
    expect(countTag(html, "p")).toBe(1);
  });

  it("renders a status badge inline after the title", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsRow, {
        title: "GitHub",
        badge: createElement("span", { role: "status" }, "Connected"),
        control: createElement("button", null, "manage"),
      }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Connected");
  });

  it("forwards a badge's role and aria-label through the row's badge slot", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsRow, {
        title: "Datadog",
        badge: createElement("span", { role: "alert", "aria-label": "Health failed" }, "Failed"),
        control: createElement("button", null, "manage"),
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-label="Health failed"');
    expect(html).toContain("Failed");
  });

  it("renders errors with role=alert", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsRow, {
        title: "API key",
        error: "Invalid key",
        control: createElement("input"),
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Invalid key");
  });
});

describe("SettingsSection", () => {
  it("omits the description paragraph when none is given", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsSection, { title: "Account", children: createElement("div", null, "body") }),
    );
    expect(html).toContain("Account");
    expect(html).toContain("body");
    // Section title is a heading; with no description there is no secondary <p>.
    expect(countTag(html, "p")).toBe(0);
  });

  it("uses page and section heading levels from the settings hierarchy", () => {
    const page = renderToStaticMarkup(createElement(SettingsPageHeader, { title: "Settings" }));
    const section = renderToStaticMarkup(
      createElement(SettingsSection, { title: "Preferences", children: createElement("div", null, "body") }),
    );
    expect(page).toContain('class="font-display text-3xl');
    expect(section).toContain('<h2 class="text-xl font-medium text-text-primary"');
  });

  it("leaves default sections unframed and frames only explicit tools", () => {
    const unframed = renderToStaticMarkup(
      createElement(SettingsSection, { title: "Account", children: createElement("div", null, "body") }),
    );
    const framed = renderToStaticMarkup(
      createElement(SettingsSection, { title: "Account", framed: true, children: createElement("div", null, "body") }),
    );
    expect(unframed).not.toContain("mt-3 overflow-hidden border border-border bg-surface-1");
    expect(unframed).not.toContain('class="mt-4 border');
    expect(framed).toContain("mt-3 overflow-hidden border border-border bg-surface-1");
  });
});

describe("settings feedback", () => {
  it("announces field errors", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsField, {
        label: "Repository",
        error: "Choose a repository.",
        children: createElement("input"),
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Choose a repository.");
  });

  it("exposes skeleton loading state while hiding its visual placeholders", () => {
    const html = renderToStaticMarkup(createElement(SettingsSkeleton));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Loading settings"');
    expect(html).toContain('aria-hidden="true"');
  });
});
