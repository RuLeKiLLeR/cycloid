import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StatusChip } from "./StatusChip";

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

describe("StatusChip", () => {
  it("renders a filled pill for the default variant", () => {
    act(() => {
      root.render(<StatusChip status="ready-for-review" />);
    });
    const chip = container.querySelector("span")!;
    expect(chip.className).toContain("status-pill");
    expect(container.textContent).toContain("Ready for review");
    expect(container.querySelector(".status-dot")).not.toBeNull();
  });

  it("renders a bare toned dot and muted label for the dot variant", () => {
    act(() => {
      root.render(<StatusChip status="done" variant="dot" />);
    });
    const chip = container.querySelector("span")!;
    // No filled pill geometry in the dot variant.
    expect(chip.className).not.toContain("status-pill");
    expect(chip.className).not.toContain("border");
    expect(chip.className).toContain("text-text-muted");
    // Still shows the toned status dot and the label.
    expect(container.querySelector(".status-dot")).not.toBeNull();
    expect(container.textContent).toContain("Done");
  });

  it("honors the label override in the dot variant", () => {
    act(() => {
      root.render(<StatusChip status="done" variant="dot" label="Merged" />);
    });
    expect(container.textContent).toContain("Merged");
    expect(container.textContent).not.toContain("Done");
  });
});
