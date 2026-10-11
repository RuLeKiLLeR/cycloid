import { act, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserSettings } from "../types";
import { getNextPlanModeSetting, HomeHeroLayout, persistPlanModeToggle } from "./HomePage";

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

const INITIAL_SETTINGS: UserSettings = {
  defaultPrDraft: false,
  autoVerifyEnabled: true,
  automaticReviewsEnabled: false,
  planMode: "off",
  planApprovalRequired: false,
  settingsProfile: "custom",
  useCodexSubscription: false,
  defaultModel: null,
  defaultRepo: null,
};

function stateHarness(initial: UserSettings) {
  let current: UserSettings | null = initial;
  const setSettings = vi.fn((update: SetStateAction<UserSettings | null>) => {
    current = typeof update === "function" ? update(current) : update;
  }) as Dispatch<SetStateAction<UserSettings | null>>;

  return {
    get current() {
      return current;
    },
    setSettings,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("persistPlanModeToggle", () => {
  it("persists the optimistic value and commits authoritative settings", async () => {
    const state = stateHarness(INITIAL_SETTINGS);
    const requestSequenceRef = { current: 0 } as MutableRefObject<number>;
    const authoritative = {
      ...INITIAL_SETTINGS,
      planMode: "auto" as const,
      defaultRepo: "trycycloid/cycloid",
    };
    const persist = vi.fn(async () => {
      expect(state.current).toEqual({ ...INITIAL_SETTINGS, planMode: "auto" });
      return authoritative;
    });
    const onError = vi.fn();

    await persistPlanModeToggle({
      next: "auto",
      previous: "off",
      setSettings: state.setSettings,
      persist,
      onError,
      requestSequenceRef,
    });

    expect(persist).toHaveBeenCalledWith({ planMode: "auto" });
    expect(state.current).toBe(authoritative);
    expect(state.setSettings).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it("rolls back and reports the error when persistence fails", async () => {
    const initial = { ...INITIAL_SETTINGS, planMode: "on" as const };
    const state = stateHarness(initial);
    const requestSequenceRef = { current: 0 } as MutableRefObject<number>;
    const persist = vi.fn(async () => {
      expect(state.current).toEqual({ ...initial, planMode: "off" });
      throw new Error("save failed");
    });
    const onError = vi.fn();

    await persistPlanModeToggle({
      next: "off",
      previous: "on",
      setSettings: state.setSettings,
      persist,
      onError,
      requestSequenceRef,
    });

    expect(persist).toHaveBeenCalledWith({ planMode: "off" });
    expect(state.current).toEqual(initial);
    expect(state.setSettings).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("ignores a stale failure after a newer toggle succeeds", async () => {
    const state = stateHarness(INITIAL_SETTINGS);
    const requestSequenceRef = { current: 0 } as MutableRefObject<number>;
    const first = deferred<UserSettings>();
    const second = deferred<UserSettings>();
    const authoritative = {
      ...INITIAL_SETTINGS,
      planMode: "on" as const,
      defaultRepo: "trycycloid/cycloid",
    };
    const persist = vi.fn(async (_patch: Partial<UserSettings>) => INITIAL_SETTINGS);
    persist.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const onError = vi.fn();

    const firstSave = persistPlanModeToggle({
      next: "auto",
      previous: "off",
      setSettings: state.setSettings,
      persist,
      onError,
      requestSequenceRef,
    });
    const secondSave = persistPlanModeToggle({
      next: "on",
      previous: "auto",
      setSettings: state.setSettings,
      persist,
      onError,
      requestSequenceRef,
    });

    expect(state.current).toEqual({ ...INITIAL_SETTINGS, planMode: "on" });

    second.resolve(authoritative);
    await secondSave;
    first.reject(new Error("stale failure"));
    await firstSave;

    expect(persist.mock.calls).toEqual([[{ planMode: "auto" }], [{ planMode: "on" }]]);
    expect(state.current).toBe(authoritative);
    expect(state.setSettings).toHaveBeenCalledTimes(3);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("plan mode setting derivation", () => {
  it("cycles off to auto to on to off", () => {
    expect(getNextPlanModeSetting("off")).toBe("auto");
    expect(getNextPlanModeSetting("auto")).toBe("on");
    expect(getNextPlanModeSetting("on")).toBe("off");
  });
});

describe("home hero layout", () => {
  it("keeps hero notices above the composer at the aligned width", () => {
    act(() => {
      root.render(
        <HomeHeroLayout
          heading="Build something"
          notices={<div data-testid="home-hero-notices" />}
          composer={<textarea aria-label="Prompt" />}
        >
          <div />
        </HomeHeroLayout>,
      );
    });

    const notices = container.querySelector('[data-testid="home-hero-notices"]');
    const composer = container.querySelector('[data-testid="home-composer"]');
    expect(notices).not.toBeNull();
    expect(composer).not.toBeNull();
    expect(notices!.compareDocumentPosition(composer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const hero = composer!.parentElement;
    expect(hero).toBe(notices!.parentElement);
    expect(hero?.classList.contains("max-w-[58rem]")).toBe(true);
    expect(composer?.classList.contains("relative")).toBe(true);
    expect(composer?.classList.contains("z-10")).toBe(true);
  });
});
