import { isRecord } from "../../../../shared/utils/type-guards.js";

export { asNonEmptyString } from "../../../../shared/utils/type-guards.js";

export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function unknownFields(input: Record<string, unknown>, allowed: readonly string[]): string[] {
  const allowedSet = new Set(allowed);
  return Object.keys(input).filter((key) => !allowedSet.has(key));
}
