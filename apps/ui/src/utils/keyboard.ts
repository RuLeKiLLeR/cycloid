/**
 * Returns true if the keyboard event should trigger the "new session" shortcut.
 * Alt+N (Option+N on macOS) when not focused on an editable element.
 *
 * Uses `e.code` (physical key) instead of `e.key` because Option+N on macOS
 * produces a dead key / special character, making `e.key` unreliable.
 */
export function isNewSessionShortcut(e: KeyboardEvent): boolean {
  if (!e.altKey || e.code !== "KeyN") return false;
  if (e.ctrlKey || e.metaKey || e.shiftKey) return false;
  const el = e.target as HTMLElement;
  const tag = el?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return false;
  return true;
}

/** Detect macOS for shortcut display labels */
const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

/** Human-readable shortcut label for the new session shortcut */
export const NEW_SESSION_SHORTCUT_LABEL = IS_MAC ? "\u2325N" : "Alt+N";
