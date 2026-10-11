import { describe, expect, it, vi } from "vitest";

import { isNewSessionShortcut } from "../../apps/ui/src/utils/keyboard";

/** Create a minimal mock KeyboardEvent for testing (no DOM required). */
function mockKeyEvent(
  overrides: Partial<{
    altKey: boolean;
    code: string;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    target: { tagName?: string; isContentEditable?: boolean };
  }> = {},
): KeyboardEvent {
  return {
    altKey: true,
    code: "KeyN",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    target: { tagName: "DIV", isContentEditable: false },
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent;
}

describe("isNewSessionShortcut", () => {
  it("returns true for Alt+N on a non-editable element", () => {
    expect(isNewSessionShortcut(mockKeyEvent())).toBe(true);
  });

  it("returns false without altKey", () => {
    expect(isNewSessionShortcut(mockKeyEvent({ altKey: false }))).toBe(false);
  });

  it("returns false for wrong key code", () => {
    expect(isNewSessionShortcut(mockKeyEvent({ code: "KeyM" }))).toBe(false);
    expect(isNewSessionShortcut(mockKeyEvent({ code: "KeyA" }))).toBe(false);
    expect(isNewSessionShortcut(mockKeyEvent({ code: "Enter" }))).toBe(false);
  });

  it("returns false when Ctrl is also held", () => {
    expect(isNewSessionShortcut(mockKeyEvent({ ctrlKey: true }))).toBe(false);
  });

  it("returns false when Meta (Cmd) is also held", () => {
    expect(isNewSessionShortcut(mockKeyEvent({ metaKey: true }))).toBe(false);
  });

  it("returns false when Shift is also held", () => {
    expect(isNewSessionShortcut(mockKeyEvent({ shiftKey: true }))).toBe(false);
  });

  it("returns false when focus is on an INPUT element", () => {
    expect(isNewSessionShortcut(mockKeyEvent({ target: { tagName: "INPUT" } }))).toBe(false);
  });

  it("returns false when focus is on a TEXTAREA element", () => {
    expect(isNewSessionShortcut(mockKeyEvent({ target: { tagName: "TEXTAREA" } }))).toBe(false);
  });

  it("returns false when focus is on a contentEditable element", () => {
    expect(isNewSessionShortcut(mockKeyEvent({ target: { tagName: "DIV", isContentEditable: true } }))).toBe(false);
  });

  it("returns true for non-editable SPAN", () => {
    expect(isNewSessionShortcut(mockKeyEvent({ target: { tagName: "SPAN" } }))).toBe(true);
  });

  it("returns true for BUTTON target", () => {
    expect(isNewSessionShortcut(mockKeyEvent({ target: { tagName: "BUTTON" } }))).toBe(true);
  });
});
