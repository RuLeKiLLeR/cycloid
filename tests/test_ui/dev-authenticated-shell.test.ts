import { describe, expect, it, vi } from "vitest";

import {
  DEV_AUTHENTICATED_SHELL_PATH,
  rememberDevAuthenticatedPath,
  restoreDevAuthenticatedPath,
} from "../../apps/ui/src/dev-authenticated-shell";

const DEV_AUTHENTICATED_PATH_STORAGE_KEY = "public-shell-dev-authenticated-path";

function createStorage(initial: Record<string, string> = {}) {
  const values = { ...initial };
  return {
    getItem: vi.fn((key: string) => values[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete values[key];
    }),
    value(key: string) {
      return values[key] ?? null;
    },
  };
}

describe("dev authenticated shell path handoff", () => {
  it("restores a direct session link after the Vite dev authenticated-shell redirect", () => {
    const storage = createStorage();
    const history = { state: { existing: true }, replaceState: vi.fn() };

    rememberDevAuthenticatedPath(storage, {
      pathname: "/sessions/ffb037a0-81de-4e4b-ae53-a8da44115114",
      search: "?tab=files",
      hash: "#turn-2",
    });
    restoreDevAuthenticatedPath(storage, { pathname: DEV_AUTHENTICATED_SHELL_PATH, search: "", hash: "" }, history);

    expect(storage.setItem).toHaveBeenCalledWith(
      DEV_AUTHENTICATED_PATH_STORAGE_KEY,
      "/sessions/ffb037a0-81de-4e4b-ae53-a8da44115114?tab=files#turn-2",
    );
    expect(storage.removeItem).toHaveBeenCalledWith(DEV_AUTHENTICATED_PATH_STORAGE_KEY);
    expect(history.replaceState).toHaveBeenCalledWith(
      history.state,
      "",
      "/sessions/ffb037a0-81de-4e4b-ae53-a8da44115114?tab=files#turn-2",
    );
  });

  it("does not store or restore unsafe shell paths", () => {
    const storage = createStorage({ [DEV_AUTHENTICATED_PATH_STORAGE_KEY]: "//evil.test/sessions/s-1" });
    const history = { state: null, replaceState: vi.fn() };

    rememberDevAuthenticatedPath(storage, { pathname: DEV_AUTHENTICATED_SHELL_PATH, search: "", hash: "" });
    restoreDevAuthenticatedPath(storage, { pathname: DEV_AUTHENTICATED_SHELL_PATH, search: "", hash: "" }, history);

    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).toHaveBeenCalledWith(DEV_AUTHENTICATED_PATH_STORAGE_KEY);
    expect(history.replaceState).not.toHaveBeenCalled();
  });

  it("leaves normal authenticated routes alone after the redirect has completed", () => {
    const storage = createStorage({ [DEV_AUTHENTICATED_PATH_STORAGE_KEY]: "/sessions/s-1" });
    const history = { state: null, replaceState: vi.fn() };

    restoreDevAuthenticatedPath(storage, { pathname: "/sessions/s-1", search: "", hash: "" }, history);

    expect(storage.getItem).not.toHaveBeenCalled();
    expect(history.replaceState).not.toHaveBeenCalled();
    expect(storage.value(DEV_AUTHENTICATED_PATH_STORAGE_KEY)).toBe("/sessions/s-1");
  });
});
