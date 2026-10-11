import { checkToolSafety, type ToolSafetyOptions } from "../utils/protection.js";

/**
 * In-process tool-safety gate for the Claude Code backend. Replaces the external
 * `PreToolUse` hook subprocess: the SDK calls `canUseTool(toolName, input)` before
 * every tool execution (built-in, `mcp__*`, and sub-agent tools), and this helper
 * decides allow/deny by reusing the same `checkToolSafety` rules as Codex.
 *
 * Platform-owned by construction — it runs inside our bridge process, with no
 * customer-repointable env or `--settings` file, so a customer can't disable it.
 */

/**
 * Decision returned to the SDK `canUseTool` callback. Structurally a subset of the
 * SDK `PermissionResult` (allow | deny) — kept local so this module stays pure and
 * independently testable without importing the SDK.
 */
export type CanUseToolDecision = { behavior: "allow" } | { behavior: "deny"; message: string };

/**
 * Decide allow/deny for one tool call. Fail closed (deny) on anything we cannot
 * clear — a missing/invalid tool name, a non-object input (`checkToolSafety`
 * requires `Record<string, unknown>`; see utils/protection.ts), a rule violation,
 * or ANY thrown error — matching the old hook's exit-2 semantics. Allow only on a
 * known tool with a well-formed input and no violation.
 */
export function resolveCanUseToolDecision(
  toolName: unknown,
  input: unknown,
  options: ToolSafetyOptions = {},
): CanUseToolDecision {
  if (typeof toolName !== "string" || toolName.length === 0) {
    return { behavior: "deny", message: "missing or invalid tool name; blocking" };
  }
  const isPlainObject =
    input !== null &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    (Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null);
  if (!isPlainObject) {
    return { behavior: "deny", message: "missing or invalid tool input; blocking" };
  }
  try {
    const violation = checkToolSafety(toolName, input as Record<string, unknown>, options);
    return violation ? { behavior: "deny", message: violation.message } : { behavior: "allow" };
  } catch (err) {
    return { behavior: "deny", message: `evaluation error; blocking: ${String(err)}` };
  }
}
