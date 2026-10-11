import { describe, expect, it } from "vitest";

import { isSubmitKeydown } from "./utils";

type KeyLike = Parameters<typeof isSubmitKeydown>[0] & { ctrlKey?: boolean; metaKey?: boolean };

function key(over: Partial<KeyLike> & { key: string }): KeyLike {
  return { shiftKey: false, keyCode: 13, nativeEvent: { isComposing: false }, ...over };
}

describe("isSubmitKeydown — Slack/Codex composer convention", () => {
  it("plain Enter sends", () => {
    expect(isSubmitKeydown(key({ key: "Enter" }))).toBe(true);
  });

  it("Cmd/Ctrl+Enter still sends (kept for muscle memory)", () => {
    expect(isSubmitKeydown(key({ key: "Enter", metaKey: true }))).toBe(true);
    expect(isSubmitKeydown(key({ key: "Enter", ctrlKey: true }))).toBe(true);
  });

  it("Shift+Enter inserts a newline instead of sending", () => {
    expect(isSubmitKeydown(key({ key: "Enter", shiftKey: true }))).toBe(false);
  });

  it("Enter during an IME composition does not send (isComposing)", () => {
    expect(isSubmitKeydown(key({ key: "Enter", nativeEvent: { isComposing: true } }))).toBe(false);
  });

  it("Enter during an IME composition does not send (legacy keyCode 229)", () => {
    expect(isSubmitKeydown(key({ key: "Enter", keyCode: 229, nativeEvent: undefined }))).toBe(false);
  });

  it("other keys never send", () => {
    expect(isSubmitKeydown(key({ key: "a" }))).toBe(false);
    expect(isSubmitKeydown(key({ key: "Tab" }))).toBe(false);
  });
});
