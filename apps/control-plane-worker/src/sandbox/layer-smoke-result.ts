export function readSmokeStatus(smokeResultJson: string): "passed" | "failed" | null {
  const parsed = parseSmokeResult(smokeResultJson);
  if (!parsed) return null;
  return parsed.ok === true ? "passed" : parsed.ok === false ? "failed" : null;
}

export function parseSmokeResult(smokeResultJson: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(smokeResultJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
