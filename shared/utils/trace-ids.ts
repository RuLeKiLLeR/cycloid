export function normalizeTelemetryId(id: unknown): string | undefined {
  if (typeof id !== "string" || id.length === 0 || /^0+$/.test(id)) return undefined;
  return id;
}
