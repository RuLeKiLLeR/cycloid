import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AUTOMATION_TEMPLATE_CATEGORIES, SCHEDULED_AUTOMATION_TEMPLATES } from "../../constants/automationTemplates";
import { TemplateGallery } from "./TemplateGallery";

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

function render(onUse: (template: unknown) => void = () => {}) {
  act(() => {
    root.render(<TemplateGallery onUse={onUse} />);
  });
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Buttons in the gallery are filter segments plus one per scheduled template. */
function templateButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-label^="Use template:"]'));
}

describe("TemplateGallery", () => {
  it("renders every category group with its templates", () => {
    render();
    const headings = Array.from(container.querySelectorAll("h3")).map((h) => h.textContent);
    expect(headings).toEqual([...AUTOMATION_TEMPLATE_CATEGORIES]);
    for (const template of SCHEDULED_AUTOMATION_TEMPLATES) {
      expect(container.textContent).toContain(template.title);
      expect(container.textContent).toContain(template.outcome);
    }
  });

  it("derives each scheduled card's trigger label from its real preset", () => {
    render();
    // Spot-check the two preset shapes: weekly (Monday 09:00) and daily (03:00).
    expect(container.textContent).toContain("Mondays at 09:00 UTC");
    expect(container.textContent).toContain("Daily at 03:00 UTC");
  });

  it("hides connector chips while GitHub is the only connector value", () => {
    render();
    // Every template's connector is GitHub today, so the chip is pure noise;
    // it returns once a second connector joins AUTOMATION_TEMPLATE_CONNECTORS.
    expect(container.textContent).not.toContain("GitHub");
  });

  it("seeds the create flow from every available template", () => {
    const onUse = vi.fn();
    render(onUse);

    const buttons = templateButtons();
    expect(buttons).toHaveLength(SCHEDULED_AUTOMATION_TEMPLATES.length);

    click(buttons[0]);
    expect(onUse).toHaveBeenCalledTimes(1);
    expect(onUse).toHaveBeenCalledWith(SCHEDULED_AUTOMATION_TEMPLATES[0]);
  });

  it("does not advertise unavailable roadmap triggers", () => {
    render();
    expect(container.textContent).not.toContain("not yet available");
    expect(container.textContent).not.toContain("On check-run failure");
  });

  it("filters templates by category", () => {
    render();
    const securityFilter = Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="radio"]')).find(
      (el) => el.textContent === "Security",
    );
    expect(securityFilter).toBeDefined();
    click(securityFilter!);

    const headings = Array.from(container.querySelectorAll("h3")).map((h) => h.textContent);
    expect(headings).toEqual(["Security"]);
    expect(container.textContent).toContain("Secret scan");
    expect(container.textContent).not.toContain("Dependency bumps");
  });
});
