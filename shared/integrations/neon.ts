export type NeonBranchCredentialConfig = {
  projectId: string;
  parentBranchId?: string;
};

function normalizeNeonConfigValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function buildNeonBranchCredentialConfig(input: {
  projectId: string | null | undefined;
  parentBranchId: string | null | undefined;
}): NeonBranchCredentialConfig | null {
  const projectId = normalizeNeonConfigValue(input.projectId);
  const parentBranchId = normalizeNeonConfigValue(input.parentBranchId);
  if (!projectId) return null;
  return { projectId, ...(parentBranchId ? { parentBranchId } : {}) };
}

export function serializeNeonBranchCredentialConfig(config: NeonBranchCredentialConfig): string {
  return JSON.stringify({
    projectId: config.projectId,
    ...(config.parentBranchId ? { parentBranchId: config.parentBranchId } : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseNeonBranchCredentialConfig(value: string | null | undefined): NeonBranchCredentialConfig | null {
  const raw = value?.trim() ?? "";
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  return buildNeonBranchCredentialConfig({
    projectId: typeof parsed.projectId === "string" ? parsed.projectId : null,
    parentBranchId: typeof parsed.parentBranchId === "string" ? parsed.parentBranchId : null,
  });
}
