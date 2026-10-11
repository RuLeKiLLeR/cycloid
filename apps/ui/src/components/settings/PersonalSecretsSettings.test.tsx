import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfirmProvider } from "../ConfirmDialog";
import { PersonalSecretsSettings } from "./PersonalSecretsSettings";

const mocks = vi.hoisted(() => ({
  fetchPersonalSecrets: vi.fn(),
  upsertPersonalSecret: vi.fn(),
  deletePersonalSecret: vi.fn(),
  importPersonalSecrets: vi.fn(),
}));

vi.mock("../../api/secrets", () => mocks);

// Let React know act() drives this environment (silences the act warning).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONFIG = {
  id: "secrets-1",
  keyNames: ["MY_TOKEN"],
  entries: [{ key: "MY_TOKEN", usageNote: null, sensitive: true }],
  createdAt: 1,
  updatedAt: 1,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchPersonalSecrets.mockResolvedValue(CONFIG);
  mocks.deletePersonalSecret.mockResolvedValue({
    secrets: { ...CONFIG, keyNames: [], entries: [], updatedAt: 2 },
    changed: true,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === text && !button.closest('[role="alertdialog"]'),
  ) as HTMLButtonElement | undefined;
}

function dialogButton(label: string): HTMLButtonElement | null {
  const dialog = container.querySelector('[role="alertdialog"]');
  return (
    ([...(dialog?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.trim() === label) as
      HTMLButtonElement | undefined) ?? null
  );
}

async function render() {
  await act(async () => {
    root.render(
      <ConfirmProvider>
        <PersonalSecretsSettings />
      </ConfirmProvider>,
    );
  });
  await flush();
}

describe("PersonalSecretsSettings", () => {
  it("lists stored secrets with masked values", async () => {
    await render();
    expect(container.textContent).toContain("MY_TOKEN");
    expect(container.textContent).toContain("••••••••");
  });

  it("does not delete a secret until the confirm dialog is confirmed", async () => {
    await render();
    const deleteButton = buttonByText("Delete");
    expect(deleteButton).toBeTruthy();

    // Cancelling the dialog must not fire the delete.
    await act(async () => {
      deleteButton!.click();
    });
    await flush();
    expect(mocks.deletePersonalSecret).not.toHaveBeenCalled();
    await act(async () => {
      dialogButton("Cancel")!.click();
    });
    await flush();
    expect(mocks.deletePersonalSecret).not.toHaveBeenCalled();
    expect(container.textContent).toContain("MY_TOKEN");

    // Confirming fires it and removes the row.
    await act(async () => {
      deleteButton!.click();
    });
    await flush();
    await act(async () => {
      dialogButton("Delete")!.click();
    });
    await flush();
    expect(mocks.deletePersonalSecret).toHaveBeenCalledWith("MY_TOKEN");
    expect(container.textContent).not.toContain("MY_TOKEN");
  });
});
