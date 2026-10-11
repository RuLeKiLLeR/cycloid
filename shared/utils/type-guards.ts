/**
 * Returns true when `value` is a non-null, non-array object — i.e. a plain
 * record / dictionary.  Useful for safely narrowing `unknown` API payloads.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function nonNegNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => asNonEmptyString(entry)).filter((entry): entry is string => !!entry)
    : [];
}
