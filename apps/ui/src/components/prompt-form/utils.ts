export function formatReasoningEffortLabel(value: string | undefined) {
  if (!value) return "auto";
  if (value === "medium") return "med";
  return value;
}

export function capitalizeLabel(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

/**
 * Whether a textarea keydown should send the prompt, matching the composer
 * convention used by Slack, ChatGPT/Codex, Discord, and Linear:
 *   - Enter (optionally with Cmd/Ctrl) sends.
 *   - Shift+Enter inserts a newline.
 *   - Enter is ignored while an IME composition is active, so committing a
 *     CJK/accent candidate with Enter never sends a half-typed prompt.
 */
export function isSubmitKeydown(event: {
  key: string;
  shiftKey: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean };
}): boolean {
  if (event.key !== "Enter") return false;
  if (event.shiftKey) return false;
  // `isComposing` covers modern browsers; keyCode 229 is the legacy signal some
  // IMEs still emit for the composition-commit Enter.
  if (event.nativeEvent?.isComposing || event.keyCode === 229) return false;
  return true;
}
