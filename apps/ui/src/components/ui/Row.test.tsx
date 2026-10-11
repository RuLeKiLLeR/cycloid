import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Row, RowGroup } from "./Row";

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

describe("Row", () => {
  it("renders title, subtitle, leading, chips, and trailing slots", () => {
    act(() => {
      root.render(
        <Row
          leading={<span data-testid="dot" />}
          title="Fix login bug"
          subtitle="apps/ui"
          chips={<span data-testid="chip" />}
          trailing="2m ago"
        />,
      );
    });
    expect(container.textContent).toContain("Fix login bug");
    expect(container.textContent).toContain("apps/ui");
    expect(container.textContent).toContain("2m ago");
    expect(container.querySelector('[data-testid="dot"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chip"]')).not.toBeNull();
  });

  it("drops the chip rail to its own line below sm so the title keeps width", () => {
    act(() => {
      root.render(<Row title="Fix login bug" chips={<span data-testid="chip" />} trailing="2m ago" />);
    });
    const row = container.firstElementChild;
    expect(row?.className).toContain("max-sm:flex-wrap");
    const chipRail = container.querySelector('[data-slot="row-chips"]');
    expect(chipRail?.className).toContain("max-sm:w-full");
    expect(chipRail?.className).toContain("max-sm:order-last");
  });

  it("renders internal hrefs through the router link (no full page reload)", () => {
    act(() => {
      root.render(
        <MemoryRouter>
          <Row title="Open PR" href="/pr/1" />
        </MemoryRouter>,
      );
    });
    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("/pr/1");
  });

  it("renders absolute http(s) hrefs as a plain anchor", () => {
    act(() => {
      root.render(<Row title="Open PR on GitHub" href="https://github.com/acme/web/pull/1" />);
    });
    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("https://github.com/acme/web/pull/1");
  });

  it("renders as a button and fires onClick", () => {
    const onClick = vi.fn();
    act(() => {
      root.render(<Row title="Select session" onClick={onClick} />);
    });
    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    act(() => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("applies the selected surface", () => {
    act(() => {
      root.render(<Row title="Active" onClick={() => {}} selected />);
    });
    expect(container.querySelector("button")?.className).toContain("bg-surface-3");
  });

  it("renders a selection checkbox and reports changes", () => {
    const onCheckedChange = vi.fn();
    act(() => {
      root.render(<Row title="Pick me" selectable checked={false} onCheckedChange={onCheckedChange} />);
    });
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    act(() => {
      checkbox!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("applies the interactive hover-lift utility instead of a bare hover bg", () => {
    act(() => {
      root.render(<Row title="Hover me" onClick={() => {}} />);
    });
    const button = container.querySelector("button")!;
    expect(button.className).toContain("row-hover-lift");
    expect(button.className).not.toContain("hover:bg-surface-2");
  });
});

describe("RowGroup", () => {
  it("renders the count as a badge chip, not a run-on string", () => {
    act(() => {
      root.render(
        <RowGroup title="Needs attention" count={39}>
          <Row title="A" />
        </RowGroup>,
      );
    });
    // Group title and count are separate elements (not "Needs attention 39").
    const title = container.querySelector('[data-slot="row-group-title"]');
    expect(title?.textContent).toBe("Needs attention");
    expect(container.textContent).toContain("39");
    expect(title?.textContent).not.toContain("39");
  });

  it("does not wrap the body in a card by default", () => {
    act(() => {
      root.render(
        <RowGroup title="Group" count={1}>
          <Row title="A" />
        </RowGroup>,
      );
    });
    const bodies = Array.from(container.querySelectorAll("div")).filter((d) => d.className.includes("flex flex-col"));
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.every((d) => !d.className.includes("border-border"))).toBe(true);
  });

  it("wraps the body in a bordered surface-1 card with hairline separators when contained", () => {
    act(() => {
      root.render(
        <RowGroup title="Group" count={2} contained>
          <Row title="A" />
          <Row title="B" />
        </RowGroup>,
      );
    });
    const card = Array.from(container.querySelectorAll("div")).find(
      (d) => d.className.includes("rounded-lg") && d.className.includes("border-border"),
    );
    expect(card).toBeDefined();
    expect(card!.className).toContain("bg-surface-1");
    expect(card!.className).toContain("[&>*+*]:border-t");
  });
});
