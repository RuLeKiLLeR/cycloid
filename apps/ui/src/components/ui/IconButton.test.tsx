import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CloseIcon } from "../icons";
import { IconButton } from "./IconButton";

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

describe("IconButton", () => {
  it("names the control from the required label (aria-label + title)", () => {
    act(() =>
      root.render(
        <IconButton label="Dismiss" onClick={vi.fn()}>
          <CloseIcon />
        </IconButton>,
      ),
    );
    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("Dismiss");
    expect(button?.getAttribute("title")).toBe("Dismiss");
    expect(button?.getAttribute("type")).toBe("button");
  });

  it("lets a caller override the title while keeping the aria-label", () => {
    act(() =>
      root.render(
        <IconButton label="Copy session ID" title="Copied">
          <CloseIcon />
        </IconButton>,
      ),
    );
    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("Copy session ID");
    expect(button?.getAttribute("title")).toBe("Copied");
  });

  it("renders the 28px ghost square with the extended hit area by default", () => {
    act(() =>
      root.render(
        <IconButton label="Dismiss">
          <CloseIcon />
        </IconButton>,
      ),
    );
    const button = container.querySelector("button");
    // Visible geometry rides the control ladder; .hit-area-40 pads the pointer
    // target to >=40x40 via ::after (no arbitrary min-h/min-w literals).
    expect(button?.className).toContain("control-sm");
    expect(button?.className).toContain("w-7");
    expect(button?.className).toContain("hit-area-40");
    expect(button?.className).toContain("btn-press");
  });

  it("maps size='md' onto control-md", () => {
    act(() =>
      root.render(
        <IconButton label="Dismiss" size="md">
          <CloseIcon />
        </IconButton>,
      ),
    );
    const button = container.querySelector("button");
    expect(button?.className).toContain("control-md");
    expect(button?.className).toContain("w-9");
  });

  it("honors disabled with the kit disabled treatment", () => {
    const onClick = vi.fn();
    act(() =>
      root.render(
        <IconButton label="Dismiss" disabled onClick={onClick}>
          <CloseIcon />
        </IconButton>,
      ),
    );
    const button = container.querySelector("button");
    expect(button?.disabled).toBe(true);
    expect(button?.className).toContain("disabled:opacity-40");
    act(() => button?.click());
    expect(onClick).not.toHaveBeenCalled();
  });
});
