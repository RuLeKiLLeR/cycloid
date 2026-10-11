export type ApplyPatchOutcome =
  | "applied"
  | "match_failed"
  | "invalid_patch"
  | "io_error"
  | "empty_patch"
  | "tool_error_other"
  | "unknown_nonprogress";

export function classifyApplyPatchTerminalOutcome(params: {
  status: string | undefined;
  output?: unknown;
  error?: unknown;
}): ApplyPatchOutcome {
  const { status, output, error } = params;
  const outputText = typeof output === "string" ? output : "";
  const errorText = typeof error === "string" ? error : "";

  if (status === "completed" && outputText.trimStart().startsWith("Success.")) {
    return "applied";
  }

  if (status === "error") {
    if (errorText.includes("Failed to find expected lines in ") || errorText.includes("Failed to find context '")) {
      return "match_failed";
    }
    if (errorText.includes("Invalid patch: ") || errorText.includes("Invalid patch hunk on line ")) {
      return "invalid_patch";
    }
    if (
      errorText.includes("Failed to read file to update ") ||
      errorText.includes("Failed to write file ") ||
      errorText.includes("Failed to delete file ") ||
      errorText.includes("Failed to remove original ") ||
      errorText.includes("Failed to create parent directories for ") ||
      errorText.includes("path is a directory")
    ) {
      return "io_error";
    }
    if (errorText.includes("No files were modified.")) {
      return "empty_patch";
    }
    if (errorText.length > 0) {
      return "tool_error_other";
    }
  }

  return "unknown_nonprogress";
}
