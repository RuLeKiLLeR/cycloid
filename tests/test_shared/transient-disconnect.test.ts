import { describe, expect, it } from "vitest";

import {
  applyDisconnectMask,
  type DisconnectMask,
  isDisconnectMaskActive,
  type LifecycleView,
  nextDisconnectMask,
  TRANSIENT_DISCONNECT_VISIBILITY_MS,
} from "../../shared/session/transient-disconnect";

const T0 = 1_000_000;
const ready: LifecycleView = { phase: "review_listening", sandboxSubstate: "none" };
const reconnecting: LifecycleView = { phase: "running", sandboxSubstate: "reconnecting" };

describe("nextDisconnectMask", () => {
  it("activates on a live transition into reconnecting, holding the prior view", () => {
    const mask = nextDisconnectMask(null, ready, reconnecting, T0);
    expect(mask).toEqual({ since: T0, heldPhase: "review_listening", heldSubstate: "none" });
  });

  it("does not activate when the first observed view is already reconnecting", () => {
    expect(nextDisconnectMask(null, null, reconnecting, T0)).toBeNull();
  });

  it("does not activate when the previous view was already reconnecting", () => {
    expect(nextDisconnectMask(null, reconnecting, reconnecting, T0)).toBeNull();
  });

  it("keeps the existing mask while reconnecting persists", () => {
    const mask = nextDisconnectMask(null, ready, reconnecting, T0);
    expect(nextDisconnectMask(mask, reconnecting, reconnecting, T0 + 5_000)).toBe(mask);
  });

  it("clears the mask when the view leaves reconnecting", () => {
    const mask = nextDisconnectMask(null, ready, reconnecting, T0);
    expect(nextDisconnectMask(mask, reconnecting, ready, T0 + 2_000)).toBeNull();
  });

  it("clears the mask when the view disappears", () => {
    const mask = nextDisconnectMask(null, ready, reconnecting, T0);
    expect(nextDisconnectMask(mask, reconnecting, null, T0 + 2_000)).toBeNull();
  });

  it("re-activates for a second disconnect after a recovery", () => {
    let mask = nextDisconnectMask(null, ready, reconnecting, T0);
    mask = nextDisconnectMask(mask, reconnecting, ready, T0 + 2_000);
    expect(mask).toBeNull();
    mask = nextDisconnectMask(mask, ready, reconnecting, T0 + 60_000);
    expect(mask).toEqual({ since: T0 + 60_000, heldPhase: "review_listening", heldSubstate: "none" });
  });

  it("defaults a missing previous substate to none", () => {
    const mask = nextDisconnectMask(null, { phase: "running" }, reconnecting, T0);
    expect(mask).toEqual({ since: T0, heldPhase: "running", heldSubstate: "none" });
  });
});

describe("isDisconnectMaskActive", () => {
  const mask: DisconnectMask = { since: T0, heldPhase: "running", heldSubstate: "none" };

  it("is active within the visibility threshold", () => {
    expect(isDisconnectMaskActive(mask, T0)).toBe(true);
    expect(isDisconnectMaskActive(mask, T0 + TRANSIENT_DISCONNECT_VISIBILITY_MS - 1)).toBe(true);
  });

  it("expires at the visibility threshold", () => {
    expect(isDisconnectMaskActive(mask, T0 + TRANSIENT_DISCONNECT_VISIBILITY_MS)).toBe(false);
  });

  it("is inactive without a mask", () => {
    expect(isDisconnectMaskActive(null, T0)).toBe(false);
  });
});

describe("applyDisconnectMask", () => {
  it("holds the pre-disconnect phase and substate while active", () => {
    const mask = nextDisconnectMask(null, ready, reconnecting, T0);
    const view = { ...reconnecting, title: "t" };
    expect(applyDisconnectMask(view, mask, T0 + 2_000)).toEqual({
      phase: "review_listening",
      sandboxSubstate: "none",
      title: "t",
    });
  });

  it("returns the true view after expiry", () => {
    const mask = nextDisconnectMask(null, ready, reconnecting, T0);
    const view = { ...reconnecting };
    expect(applyDisconnectMask(view, mask, T0 + TRANSIENT_DISCONNECT_VISIBILITY_MS)).toBe(view);
  });

  it("returns the true view without a mask", () => {
    const view = { ...reconnecting };
    expect(applyDisconnectMask(view, null, T0)).toBe(view);
  });
});

// The visibility threshold must stay well under the 90s reconnect grace so a
// real outage is visible long before grace expiry fails the prompt.
it("visibility threshold is well below the sandbox reconnect grace", () => {
  expect(TRANSIENT_DISCONNECT_VISIBILITY_MS).toBeLessThan(90_000 / 2);
});
