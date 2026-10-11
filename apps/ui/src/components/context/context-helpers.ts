import type { BadgeTone } from "../ui";

/**
 * Badge tone for an MCP server validation status. Only two hues are allowed:
 * live (violet) for an actively-validating server, error for a failed one.
 * Valid and untested read grayscale — the label carries the state.
 */
export function mcpValidationTone(status: string): BadgeTone {
  switch (status) {
    case "invalid":
      return "error";
    case "validating":
      return "accent";
    case "valid":
    default:
      return "default";
  }
}

/** Human label for a transport, keeping acronyms uppercase per copy rules. */
export function transportLabel(transport: string): string {
  switch (transport) {
    case "http":
      return "HTTP";
    case "sse":
      return "SSE";
    case "stdio":
      return "stdio";
    default:
      return transport;
  }
}

/** Split a `owner/name` repo full name into its parts. */
export function splitRepoFullName(fullName: string): { owner: string; name: string } | null {
  const slash = fullName.indexOf("/");
  if (slash <= 0 || slash >= fullName.length - 1) return null;
  return { owner: fullName.slice(0, slash), name: fullName.slice(slash + 1) };
}
