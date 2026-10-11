/**
 * Splits Codex-style path metadata lists while preserving ordinary filenames
 * that contain comma-space.
 */
export function splitDelimitedPathList(value: string): string[] {
  const hasTrailingSeparator = /,\s+$/.test(value);
  const trimmed = value.trim();
  if (!trimmed) return [];

  const rawParts = trimmed.split(/,\s+/);
  if (rawParts.length <= 1) {
    if (!hasTrailingSeparator) return [trimmed];
    return rawParts
      .map((part) => part.replace(/,+$/, ""))
      .map((part) => part.trim())
      .filter(Boolean);
  }

  const shouldSplit =
    hasTrailingSeparator ||
    rawParts.slice(1).some((part) => {
      const normalizedPart = part.replace(/,+$/, "").trim();
      return (
        normalizedPart.startsWith("/") ||
        normalizedPart.startsWith("./") ||
        normalizedPart.startsWith("../") ||
        normalizedPart.includes("/")
      );
    });

  if (!shouldSplit) return [trimmed];

  return rawParts
    .map((part) => part.replace(/,+$/, ""))
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Flattens edit-tool path inputs into path strings accepted by the tracker and
 * staging code.
 */
export function normalizePathInput(value: unknown): string[] {
  if (typeof value === "string") return splitDelimitedPathList(value);
  if (!Array.isArray(value)) return [];

  const paths: string[] = [];
  for (const item of value) {
    paths.push(...normalizePathInput(item));
  }
  return paths;
}
