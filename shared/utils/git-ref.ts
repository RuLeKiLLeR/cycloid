const MAX_GIT_REF_LENGTH = 250;

// Git-special characters forbidden in ref names (glob/rev syntax), plus backslash.
const FORBIDDEN_CHAR_PATTERN = /[~^:?*\[\\]/;

function hasControlCharOrSpace(ref: string): boolean {
  for (let i = 0; i < ref.length; i++) {
    const code = ref.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validates a branch name against `git check-ref-format --branch` semantics.
 *
 * Used at trust boundaries where a sandbox-supplied branch name later reaches
 * git as a leading positional argument (fetch/checkout), so this must reject
 * anything git would treat as a flag or path traversal. Reject-and-drop only;
 * never sanitize, because checkout needs the exact ref.
 */
export function isSafeGitRef(ref: string): boolean {
  if (!ref || ref.length > MAX_GIT_REF_LENGTH) return false;
  // `git check-ref-format --branch` rejects @ and the HEAD shorthand; allowing
  // either would let a respawn pass it as CHECKOUT_BRANCH and fail repo setup.
  if (ref === "@" || ref === "HEAD") return false;
  if (ref.startsWith("-") || ref.startsWith("/") || ref.endsWith("/")) return false;
  if (ref.endsWith(".")) return false;
  if (ref.includes("..") || ref.includes("@{") || ref.includes("//")) return false;
  if (hasControlCharOrSpace(ref) || FORBIDDEN_CHAR_PATTERN.test(ref)) return false;
  for (const segment of ref.split("/")) {
    if (segment.startsWith(".") || segment.endsWith(".lock")) return false;
  }
  return true;
}
