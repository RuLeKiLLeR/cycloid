import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfirmProvider, useConfirm } from "./ConfirmDialog";

let container: HTMLDivElement;
let root: Root;
let lastConfirm: ((opts?: { destructive?: boolean }) => Promise<boolean>) | null = null;

function Harness() {
  const confirm = useConfirm();
  lastConfirm = (opts) => confirm({ message: "Are you sure?", ...opts });
  return null;
}

function mount() {
  act(() => {
    root.render(
      <ConfirmProvider>
        <Harness />
      </ConfirmProvider>,
    );
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  lastConfirm = null;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function queryDialog() {
  return document.querySelector('[role="alertdialog"]');
}

function clickButtonByText(text: string) {
  const button = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === text);
  if (!button) throw new Error(`button "${text}" not found`);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("ConfirmDialog", () => {
  it("opens a dialog and resolves true when confirmed", async () => {
    mount();
    expect(queryDialog()).toBeNull();
    let result: Promise<boolean>;
    act(() => {
      result = lastConfirm!();
    });
    expect(queryDialog()).not.toBeNull();
    clickButtonByText("Confirm");
    await expect(result!).resolves.toBe(true);
    expect(queryDialog()).toBeNull();
  });

  it("resolves false when cancelled", async () => {
    mount();
    let result: Promise<boolean>;
    act(() => {
      result = lastConfirm!();
    });
    clickButtonByText("Cancel");
    await expect(result!).resolves.toBe(false);
    expect(queryDialog()).toBeNull();
  });

  it("resolves false on Escape", async () => {
    mount();
    let result: Promise<boolean>;
    act(() => {
      result = lastConfirm!();
    });
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await expect(result!).resolves.toBe(false);
    expect(queryDialog()).toBeNull();
  });

  it("resolves true on Enter when focus is not on a button", async () => {
    mount();
    let result: Promise<boolean>;
    act(() => {
      result = lastConfirm!();
    });
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await expect(result!).resolves.toBe(true);
    expect(queryDialog()).toBeNull();
  });

  it("does not confirm when Enter fires on the focused Cancel button", async () => {
    mount();
    let result: Promise<boolean>;
    act(() => {
      result = lastConfirm!();
    });
    const cancel = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Cancel");
    if (!cancel) throw new Error("Cancel button not found");
    act(() => {
      cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    // The document handler must yield to the focused button, so the dialog
    // stays open rather than resolving as confirmed.
    expect(queryDialog()).not.toBeNull();
    clickButtonByText("Cancel");
    await expect(result!).resolves.toBe(false);
  });

  it("resolves the first promise as false when a second confirm replaces it", async () => {
    mount();
    let first: Promise<boolean>;
    let second: Promise<boolean>;
    act(() => {
      first = lastConfirm!();
    });
    act(() => {
      second = lastConfirm!();
    });
    await expect(first!).resolves.toBe(false);
    expect(queryDialog()).not.toBeNull();
    clickButtonByText("Confirm");
    await expect(second!).resolves.toBe(true);
  });
});
