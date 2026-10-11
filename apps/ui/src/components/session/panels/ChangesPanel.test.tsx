import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FileChange } from "../workbench";
import { ChangesPanel } from "./ChangesPanel";

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

function render(changes: FileChange[], prUrl: string | null) {
  act(() => {
    root.render(<ChangesPanel changes={changes} prUrl={prUrl} />);
  });
}

describe("Changes panel", () => {
  it("renders a calm empty state before any changes", () => {
    render([], null);
    expect(container.textContent).toContain("No changes yet.");
  });

  it("renders touched files without inferred line counts", () => {
    render([{ path: "src/a.ts", edits: 2 }], null);
    expect(container.textContent).toContain("src/a.ts");
    expect(container.textContent).toContain("Touched files (1)");
    expect(container.textContent).toContain("2 edits");
    expect(container.textContent).not.toContain("+");
  });

  it("links to the PR diff when the session has a published PR", () => {
    render([{ path: "src/a.ts", edits: 1 }], "https://github.com/trycycloid/cycloid/pull/42");
    const link = container.querySelector('a[href="https://github.com/trycycloid/cycloid/pull/42/files"]');
    expect(link?.textContent).toBe("View PR changes");
  });

  it("omits the PR diff link pre-publish", () => {
    render([{ path: "src/a.ts", edits: 1 }], null);
    expect(container.querySelector("a")).toBeNull();
  });
});
