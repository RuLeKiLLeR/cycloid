export function promptResultBranch(result: unknown): string | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const branch = (result as { branch?: unknown }).branch;
  return typeof branch === "string" && branch.trim() ? branch.trim() : null;
}

export function promptResultDiffSummary(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const diffSummary = (result as { diffSummary?: unknown }).diffSummary;
  return typeof diffSummary === "string" && diffSummary.trim() ? diffSummary : undefined;
}

export function promptResultCommitSha(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const commitSha = (result as { commitSha?: unknown }).commitSha;
  return typeof commitSha === "string" && commitSha.trim() ? commitSha.trim() : undefined;
}
