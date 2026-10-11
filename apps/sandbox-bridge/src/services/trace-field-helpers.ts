export function recordField(value: unknown, key?: string): Record<string, unknown> | undefined {
  const target =
    key === undefined ? value : value && typeof value === "object" ? (value as Record<string, unknown>)[key] : null;
  return target && typeof target === "object" && !Array.isArray(target)
    ? (target as Record<string, unknown>)
    : undefined;
}

export function arrayField(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringField(value: unknown, key: string): string | null {
  const record = recordField(value);
  const field = record?.[key];
  return typeof field === "string" && field.trim() ? field.trim().slice(0, 1_000) : null;
}

export function numberField(value: unknown, key: string): number | null {
  const record = recordField(value);
  const field = record?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : null;
}

export function booleanField(value: unknown, key: string): boolean | null {
  const record = recordField(value);
  const field = record?.[key];
  return typeof field === "boolean" ? field : null;
}

/**
 * Extracts the sorted, de-duplicated candidate memory ids from a retrieval
 * trace. Shared by the repo/company recall tools; `extraCandidates` folds in
 * per-tool candidate sources (e.g. repo selected/rejected candidates keyed on
 * `memoryId`), and `fallbackIds` is used only when no ids are otherwise found.
 */
export function extractDecisionTraceCandidateIds(
  retrievalTrace: Record<string, unknown> | undefined,
  options?: { extraCandidates?: unknown[]; fallbackIds?: string[] },
): string[] {
  const ids = new Set<string>();
  for (const candidate of arrayField(recordField(retrievalTrace)?.candidates)) {
    const id = stringField(candidate, "id");
    if (id) ids.add(id);
  }
  for (const candidate of options?.extraCandidates ?? []) {
    const id = stringField(candidate, "memoryId");
    if (id) ids.add(id);
  }
  const selector = recordField(retrievalTrace, "selector");
  for (const decision of [...arrayField(selector?.selected), ...arrayField(selector?.rejected)]) {
    const id = stringField(decision, "memoryId") ?? stringField(decision, "id");
    if (id) ids.add(id);
  }
  if (ids.size === 0 && options?.fallbackIds) {
    for (const id of options.fallbackIds) ids.add(id);
  }
  return [...ids].sort();
}

/**
 * Parameterized decision-trace builder shared by the repo and company recall
 * tools. The emitted field names and shape must stay byte-identical to what
 * each tool published before consolidation (downstream eval queries key on
 * them), so per-tool extras are opt-in: `extraInput` (symbols/tool), selector
 * latency/confidence toggles, and a prebuilt `repo` block.
 */
export function buildDecisionTrace(params: {
  toolName: string;
  traceId: string;
  intent: string;
  files: string[];
  candidateIds: string[];
  returnedIds: string[];
  returnedMemories: Array<Record<string, unknown>>;
  retrievalTrace: Record<string, unknown> | undefined;
  extraInput?: Record<string, unknown>;
  includeSelectorLatency?: boolean;
  includeSelectorConfidence?: boolean;
  repo?: Record<string, unknown>;
}): Record<string, unknown> {
  const trace = params.retrievalTrace;
  const selector = recordField(trace, "selector");
  return {
    toolName: params.toolName,
    traceId: params.traceId,
    intent: params.intent,
    files: params.files,
    ...(params.extraInput ?? {}),
    retrievalConfigVersion: stringField(trace, "retrievalConfigVersion"),
    query: stringField(trace, "query"),
    vectorAvailable: booleanField(trace, "vectorAvailable"),
    vectorUnavailableReason: stringField(trace, "vectorUnavailableReason"),
    fusionMode: stringField(trace, "fusionMode"),
    laneCounts: recordField(trace, "laneCounts") ?? {},
    candidateIds: params.candidateIds,
    returnedIds: params.returnedIds,
    returnedMemories: params.returnedMemories,
    selectorStatus: stringField(trace, "selectorStatus"),
    ...(params.includeSelectorLatency ? { selectorLatencyMs: numberField(trace, "selectorLatencyMs") } : {}),
    selector: {
      selected: compactSelectorDecisions(arrayField(selector?.selected)),
      rejected: compactSelectorDecisions(arrayField(selector?.rejected)),
      emptyReason: stringField(selector, "emptyReason"),
      failureReason: stringField(selector, "failureReason"),
      ...(params.includeSelectorConfidence ? { confidence: numberField(selector, "confidence") } : {}),
    },
    ...(params.repo ? { repo: params.repo } : {}),
  };
}

export function compactSelectorDecisions(entries: unknown[]): Array<Record<string, unknown>> {
  return entries.slice(0, 30).flatMap((entry): Array<Record<string, unknown>> => {
    const record = recordField(entry);
    const memoryId = stringField(record, "memoryId") ?? stringField(record, "id");
    if (!memoryId) return [];
    return [
      {
        memoryId,
        rejectReason: stringField(record, "rejectReason"),
        score: numberField(record, "score"),
      },
    ];
  });
}
