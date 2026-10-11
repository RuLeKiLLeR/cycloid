export type MemoryReviewCohortCoverageStatus = "complete" | "partial" | "unknown";

export interface MemoryReviewCohortFilters {
  businessId?: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
}

export interface MemoryReviewCohortQuery {
  name: "summary" | "review" | "root_causes" | "lifecycle_states";
  sql: string;
  params: string[];
}

export interface LifecycleScopeFailures {
  lifecycle: number;
  superseded: number;
  expired: number;
  rejected: number;
  stale_memory: number;
  supersession_missing: number;
  provenance_missing: number;
  scope: number;
}

export interface MemoryReviewCohortReport {
  generated_total: number;
  active_total: number;
  observed_recalled: number;
  never_observed_recalled: number;
  reviewed_useful: number;
  reviewed_not_useful: number;
  false_positive: number;
  false_positive_hurt: number;
  never_observed_recalled_rate: number | null;
  recalled_not_useful_rate: number | null;
  false_positive_rate: number | null;
  false_positive_hurt_rate: number | null;
  root_cause_distribution: Record<string, number>;
  lifecycle_scope_failures: LifecycleScopeFailures;
  coverage_status: MemoryReviewCohortCoverageStatus;
  coverage_notes: string[];
}

interface NormalizedFilters {
  businessId: string | null;
  repoOwner: string | null;
  repoName: string | null;
  repoScopeId: string | null;
}

interface QueryFragment {
  sql: string;
  params: string[];
  repoMemoriesOmittedForBusinessOnly: boolean;
}

export interface SummaryRow {
  generatedTotal: number | null;
  activeTotal: number | null;
  observedRecalled: number | null;
  neverObservedRecalled: number | null;
  explicitRecallEvents: number | null;
  promptLinkedRecallEvents: number | null;
  historicalRecallEvents: number | null;
}

export interface ReviewSummaryRow {
  reviewedUseful: number | null;
  reviewedNotUseful: number | null;
  falsePositive: number | null;
  falsePositiveHurt: number | null;
  reviewedItems: number | null;
  reviewedMemories: number | null;
  reviewedRecalls: number | null;
}

export interface RootCauseRow {
  rootCause: string | null;
  count: number | null;
}

export interface LifecycleStateRow {
  lifecycleState: string | null;
  count: number | null;
}

export interface MemoryReviewCohortQueryRows {
  summary: SummaryRow[];
  review: ReviewSummaryRow[];
  root_causes: RootCauseRow[];
  lifecycle_states: LifecycleStateRow[];
}

export async function getMemoryReviewCohortReport(
  db: D1Database,
  input: MemoryReviewCohortFilters = {},
): Promise<MemoryReviewCohortReport> {
  const plan = buildMemoryReviewCohortQueryPlan(input);
  const statements = plan.queries.map((query) => db.prepare(query.sql).bind(...query.params));
  const results = await db.batch(statements);
  const [summaryResult, reviewResult, rootCauseResult, lifecycleResult] = results;
  if (!summaryResult || !reviewResult || !rootCauseResult || !lifecycleResult) {
    throw new Error("D1 cohort query batch returned an incomplete result set");
  }
  return buildMemoryReviewCohortReport(input, {
    summary: coerceRows<SummaryRow>(summaryResult.results),
    review: coerceRows<ReviewSummaryRow>(reviewResult.results),
    root_causes: coerceRows<RootCauseRow>(rootCauseResult.results),
    lifecycle_states: coerceRows<LifecycleStateRow>(lifecycleResult.results),
  });
}

export function buildMemoryReviewCohortQueryPlan(input: MemoryReviewCohortFilters = {}): {
  queries: MemoryReviewCohortQuery[];
  repoMemoriesOmittedForBusinessOnly: boolean;
} {
  const filters = normalizeFilters(input);
  const generated = buildGeneratedMemoryCte(filters);
  const reviewed = buildReviewedItemsCte(filters, generated);
  return {
    queries: [
      buildSummaryQuery(filters, generated),
      buildReviewSummaryQuery(reviewed),
      buildRootCauseQuery(reviewed),
      buildLifecycleStateQuery(reviewed),
    ],
    repoMemoriesOmittedForBusinessOnly: generated.repoMemoriesOmittedForBusinessOnly,
  };
}

export function buildMemoryReviewCohortReport(
  input: MemoryReviewCohortFilters,
  rows: MemoryReviewCohortQueryRows,
): MemoryReviewCohortReport {
  const generated = buildGeneratedMemoryCte(normalizeFilters(input));
  const summary = rows.summary[0] ?? null;
  const review = rows.review[0] ?? null;
  const rootCauseDistribution = buildRootCauseDistribution(rows.root_causes);
  const lifecycleDistribution = buildLifecycleDistribution(rows.lifecycle_states);

  const generatedTotal = numberValue(summary?.generatedTotal);
  const activeTotal = numberValue(summary?.activeTotal);
  const observedRecalled = numberValue(summary?.observedRecalled);
  const neverObservedRecalled = numberValue(summary?.neverObservedRecalled);
  const explicitRecallEvents = numberValue(summary?.explicitRecallEvents);
  const promptLinkedRecallEvents = numberValue(summary?.promptLinkedRecallEvents);
  const historicalRecallEvents = numberValue(summary?.historicalRecallEvents);
  const reviewedUseful = numberValue(review?.reviewedUseful);
  const reviewedNotUseful = numberValue(review?.reviewedNotUseful);
  const falsePositive = numberValue(review?.falsePositive);
  const falsePositiveHurt = numberValue(review?.falsePositiveHurt);
  const reviewedItems = numberValue(review?.reviewedItems);
  const reviewedMemories = numberValue(review?.reviewedMemories);
  const reviewedRecalls = numberValue(review?.reviewedRecalls);
  const reviewedUsefulnessItems = reviewedUseful + reviewedNotUseful;
  const lifecycleFailures =
    numberValue(lifecycleDistribution.superseded) +
    numberValue(lifecycleDistribution.expired) +
    numberValue(lifecycleDistribution.rejected) +
    numberValue(lifecycleDistribution.inactive);
  const lifecycleScopeFailures = buildLifecycleScopeFailures(
    rootCauseDistribution,
    lifecycleDistribution,
    lifecycleFailures,
  );
  const coverage = buildCoverage({
    generatedTotal,
    observedRecalled,
    explicitRecallEvents,
    promptLinkedRecallEvents,
    historicalRecallEvents,
    reviewedItems,
    reviewedMemories,
    repoMemoriesOmittedForBusinessOnly: generated.repoMemoriesOmittedForBusinessOnly,
  });

  return {
    generated_total: generatedTotal,
    active_total: activeTotal,
    observed_recalled: observedRecalled,
    never_observed_recalled: neverObservedRecalled,
    reviewed_useful: reviewedUseful,
    reviewed_not_useful: reviewedNotUseful,
    false_positive: falsePositive,
    false_positive_hurt: falsePositiveHurt,
    never_observed_recalled_rate: rate(neverObservedRecalled, generatedTotal),
    recalled_not_useful_rate: rate(reviewedNotUseful, reviewedUsefulnessItems),
    false_positive_rate: rate(falsePositive, reviewedRecalls),
    false_positive_hurt_rate: rate(falsePositiveHurt, reviewedRecalls),
    root_cause_distribution: rootCauseDistribution,
    lifecycle_scope_failures: lifecycleScopeFailures,
    coverage_status: coverage.status,
    coverage_notes: coverage.notes,
  };
}

function buildSummaryQuery(filters: NormalizedFilters, generated: QueryFragment): MemoryReviewCohortQuery {
  const usageFilters: string[] = [];
  const usageParams: string[] = [];
  if (filters.businessId) {
    usageFilters.push(
      `EXISTS (
        SELECT 1
        FROM session_index si
        WHERE si.session_id = u.session_id
          AND si.business_id = ?
      )`,
    );
    usageParams.push(filters.businessId);
  }
  if (filters.repoOwner && filters.repoName) {
    usageFilters.push("(u.repo_owner IS NULL OR (u.repo_owner = ? AND u.repo_name = ?))");
    usageParams.push(filters.repoOwner, filters.repoName);
  }
  const usageWhere = usageFilters.length > 0 ? `AND ${usageFilters.join(" AND ")}` : "";
  return {
    name: "summary",
    sql: `${generated.sql},
recall_by_memory AS (
  SELECT
    g.memory_store,
    g.memory_id,
    COUNT(u.id) AS recall_count,
    SUM(
      CASE
        WHEN u.source IN ('recall', 'company_recall')
          AND u.prompt_id IS NOT NULL
          AND u.prompt_id != ''
          AND u.prompt_id != 'company-memory-recall'
          THEN 1
        ELSE 0
      END
    ) AS prompt_linked_recall_count,
    SUM(
      CASE
        WHEN u.source = 'company_bootstrap' OR u.prompt_id = 'company-memory-recall'
          THEN 1
        ELSE 0
      END
    ) AS historical_recall_count
  FROM generated_memories g
  LEFT JOIN memory_usage_events u
    ON u.memory_id = g.memory_id
   AND u.source IN ('recall', 'company_recall', 'company_bootstrap')
   ${usageWhere}
  GROUP BY g.memory_store, g.memory_id
)
SELECT
  COUNT(*) AS generatedTotal,
  SUM(CASE WHEN g.lifecycle_state = 'active' THEN 1 ELSE 0 END) AS activeTotal,
  SUM(CASE WHEN COALESCE(r.recall_count, 0) > 0 THEN 1 ELSE 0 END) AS observedRecalled,
  SUM(CASE WHEN COALESCE(r.recall_count, 0) = 0 THEN 1 ELSE 0 END) AS neverObservedRecalled,
  SUM(COALESCE(r.recall_count, 0)) AS explicitRecallEvents,
  SUM(COALESCE(r.prompt_linked_recall_count, 0)) AS promptLinkedRecallEvents,
  SUM(COALESCE(r.historical_recall_count, 0)) AS historicalRecallEvents
FROM generated_memories g
LEFT JOIN recall_by_memory r
  ON r.memory_store = g.memory_store
 AND r.memory_id = g.memory_id`,
    params: [...generated.params, ...usageParams],
  };
}

function buildReviewSummaryQuery(reviewed: QueryFragment): MemoryReviewCohortQuery {
  return {
    name: "review",
    sql: `${reviewed.sql}
SELECT
  (SELECT SUM(CASE WHEN usefulness = 'useful' THEN 1 ELSE 0 END) FROM reviewed_items) AS reviewedUseful,
  (SELECT SUM(CASE WHEN usefulness = 'not_useful' THEN 1 ELSE 0 END) FROM reviewed_items) AS reviewedNotUseful,
  (SELECT SUM(CASE WHEN prompt_outcome = 'false_positive' THEN 1 ELSE 0 END) FROM reviewed_recalls) AS falsePositive,
  (
    SELECT SUM(CASE WHEN prompt_outcome = 'false_positive' AND effect = 'hurt' THEN 1 ELSE 0 END)
    FROM reviewed_recalls
  ) AS falsePositiveHurt,
  (SELECT COUNT(*) FROM reviewed_items) AS reviewedItems,
  (SELECT COUNT(DISTINCT memory_id) FROM reviewed_items) AS reviewedMemories,
  (SELECT COUNT(*) FROM reviewed_recalls) AS reviewedRecalls`,
    params: reviewed.params,
  };
}

function buildRootCauseQuery(reviewed: QueryFragment): MemoryReviewCohortQuery {
  return {
    name: "root_causes",
    sql: `${reviewed.sql}
SELECT
  lower(trim(CAST(j.value AS TEXT))) AS rootCause,
  COUNT(*) AS count
FROM reviewed_items i
JOIN json_each(
  CASE
    WHEN json_valid(COALESCE(i.root_causes_json, '')) THEN i.root_causes_json
    ELSE '[]'
  END
) j
WHERE trim(CAST(j.value AS TEXT)) != ''
GROUP BY lower(trim(CAST(j.value AS TEXT)))
ORDER BY count DESC, rootCause ASC`,
    params: reviewed.params,
  };
}

function buildLifecycleStateQuery(reviewed: QueryFragment): MemoryReviewCohortQuery {
  return {
    name: "lifecycle_states",
    sql: `${reviewed.sql}
SELECT
  lower(COALESCE(NULLIF(trim(lifecycle_state), ''), 'unknown')) AS lifecycleState,
  COUNT(*) AS count
FROM reviewed_items
GROUP BY lower(COALESCE(NULLIF(trim(lifecycle_state), ''), 'unknown'))
ORDER BY count DESC, lifecycleState ASC`,
    params: reviewed.params,
  };
}

function buildReviewedItemsCte(filters: NormalizedFilters, generated: QueryFragment): QueryFragment {
  const reviewFilters: string[] = [];
  const reviewParams: string[] = [];
  if (filters.businessId) {
    reviewFilters.push("r.business_id = ?");
    reviewParams.push(filters.businessId);
  }
  const where = reviewFilters.length > 0 ? `WHERE ${reviewFilters.join(" AND ")}` : "";
  const reviewedRecallFilters = [
    ...reviewFilters,
    `EXISTS (
    SELECT 1
    FROM reviewed_items i
    WHERE i.run_id = rr.run_id
      AND i.source = rr.source
  )`,
  ];
  const reviewedRecallsWhere = `WHERE ${reviewedRecallFilters.join(" AND ")}`;
  return {
    sql: `${generated.sql},
reviewed_items AS (
  SELECT
    i.run_id,
    i.memory_id,
    i.source,
    i.relevance,
    i.usefulness,
    i.effect,
    i.lifecycle_state,
    i.root_causes_json
  FROM generated_memories g
  JOIN memory_review_bot_item_results i
    ON i.memory_id = g.memory_id
  JOIN memory_review_bot_runs r
    ON r.id = i.run_id
  ${where}
),
reviewed_recalls AS (
  SELECT
    rr.prompt_outcome,
    rr.aggregate_effect AS effect
  FROM memory_review_bot_recall_results rr
  JOIN memory_review_bot_runs r
    ON r.id = rr.run_id
  ${reviewedRecallsWhere}
)`,
    params: [...generated.params, ...reviewParams, ...reviewParams],
    repoMemoriesOmittedForBusinessOnly: generated.repoMemoriesOmittedForBusinessOnly,
  };
}

function buildGeneratedMemoryCte(filters: NormalizedFilters): QueryFragment {
  const repoWhere: string[] = [];
  const repoParams: string[] = [];
  const factWhere: string[] = [];
  const factParams: string[] = [];
  const takeWhere: string[] = [];
  const takeParams: string[] = [];
  let repoMemoriesOmittedForBusinessOnly = false;

  if (filters.repoOwner && filters.repoName) {
    repoWhere.push("rm.repo_owner = ? AND rm.repo_name = ?");
    repoParams.push(filters.repoOwner, filters.repoName);
  } else if (filters.businessId) {
    repoWhere.push("0");
    repoMemoriesOmittedForBusinessOnly = true;
  }

  if (filters.businessId) {
    factWhere.push("f.business_id = ?");
    takeWhere.push("t.business_id = ?");
    factParams.push(filters.businessId);
    takeParams.push(filters.businessId);
  }

  if (filters.repoScopeId) {
    factWhere.push(`(
      lower(f.holder) IN (?, ?)
      OR EXISTS (
        SELECT 1
        FROM ingestion_events e
        WHERE e.id = f.source_event_id
          AND e.business_id = f.business_id
          AND e.scope_type = 'repo'
          AND lower(COALESCE(e.scope_id, '')) = ?
      )
      OR EXISTS (
        SELECT 1
        FROM memory_provenance p
        JOIN ingestion_events e
          ON e.id = p.source_event_id
         AND e.business_id = p.business_id
        WHERE p.business_id = f.business_id
          AND p.memory_kind = 'fact'
          AND p.memory_id = f.id
          AND e.scope_type = 'repo'
          AND lower(COALESCE(e.scope_id, '')) = ?
      )
    )`);
    factParams.push(filters.repoScopeId, `repo:${filters.repoScopeId}`, filters.repoScopeId, filters.repoScopeId);

    takeWhere.push(`(
      lower(t.holder) IN (?, ?)
      OR EXISTS (
        SELECT 1
        FROM memory_pages p
        WHERE p.id = t.page_id
          AND p.business_id = t.business_id
          AND p.page_type = 'repo'
          AND lower(p.slug) = ?
      )
      OR EXISTS (
        SELECT 1
        FROM memory_provenance p
        JOIN ingestion_events e
          ON e.id = p.source_event_id
         AND e.business_id = p.business_id
        WHERE p.business_id = t.business_id
          AND p.memory_kind = 'take'
          AND p.memory_id = t.id
          AND e.scope_type = 'repo'
          AND lower(COALESCE(e.scope_id, '')) = ?
      )
    )`);
    takeParams.push(filters.repoScopeId, `repo:${filters.repoScopeId}`, filters.repoScopeId, filters.repoScopeId);
  }

  return {
    sql: `WITH generated_memories AS (
  SELECT
    'repo' AS memory_store,
    rm.memory_id,
    rm.status AS lifecycle_state,
    rm.created_at_ms,
    rm.updated_at_ms
  FROM repo_memories rm
  ${whereSql(repoWhere)}

  UNION ALL

  SELECT
    'fact' AS memory_store,
    f.id AS memory_id,
    f.status AS lifecycle_state,
    f.created_at_ms,
    COALESCE(f.expired_at_ms, f.created_at_ms) AS updated_at_ms
  FROM memory_facts f
  ${whereSql(factWhere)}

  UNION ALL

  SELECT
    'take' AS memory_store,
    t.id AS memory_id,
    CASE WHEN t.active = 1 THEN 'active' ELSE 'inactive' END AS lifecycle_state,
    t.created_at_ms,
    t.created_at_ms AS updated_at_ms
  FROM memory_takes t
  ${whereSql(takeWhere)}
)`,
    params: [...repoParams, ...factParams, ...takeParams],
    repoMemoriesOmittedForBusinessOnly,
  };
}

function whereSql(clauses: string[]): string {
  return clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
}

function normalizeFilters(input: MemoryReviewCohortFilters): NormalizedFilters {
  const businessId = optionalTrimmed(input.businessId);
  const repoOwner = optionalTrimmed(input.repoOwner);
  const repoName = optionalTrimmed(input.repoName);
  if ((repoOwner && !repoName) || (!repoOwner && repoName)) {
    throw new Error("repo_owner and repo_name must be provided together");
  }
  const repoScopeId = repoOwner && repoName ? `${repoOwner.toLowerCase()}/${repoName.toLowerCase()}` : null;
  return { businessId, repoOwner, repoName, repoScopeId };
}

function buildRootCauseDistribution(rows: RootCauseRow[]): Record<string, number> {
  const distribution: Record<string, number> = {};
  for (const row of rows) {
    const key = row.rootCause?.trim();
    if (!key) continue;
    distribution[key] = (distribution[key] ?? 0) + numberValue(row.count);
  }
  return distribution;
}

function buildLifecycleDistribution(rows: LifecycleStateRow[]): Record<string, number> {
  const distribution: Record<string, number> = {};
  for (const row of rows) {
    const key = row.lifecycleState?.trim();
    if (!key) continue;
    distribution[key] = (distribution[key] ?? 0) + numberValue(row.count);
  }
  return distribution;
}

function buildLifecycleScopeFailures(
  rootCauseDistribution: Record<string, number>,
  lifecycleDistribution: Record<string, number>,
  lifecycleFailures: number,
): LifecycleScopeFailures {
  const provenanceMissing = numberValue(rootCauseDistribution.provenance_missing);
  const scopeRootCauseCount = Object.entries(rootCauseDistribution).reduce(
    (total, [rootCause, count]) => total + (rootCause.includes("scope") ? count : 0),
    0,
  );
  return {
    lifecycle: lifecycleFailures,
    superseded: numberValue(lifecycleDistribution.superseded),
    expired: numberValue(lifecycleDistribution.expired),
    rejected: numberValue(lifecycleDistribution.rejected),
    stale_memory: numberValue(rootCauseDistribution.stale_memory),
    supersession_missing: numberValue(rootCauseDistribution.supersession_missing),
    provenance_missing: provenanceMissing,
    scope: provenanceMissing + scopeRootCauseCount,
  };
}

function buildCoverage(input: {
  generatedTotal: number;
  observedRecalled: number;
  explicitRecallEvents: number;
  promptLinkedRecallEvents: number;
  historicalRecallEvents: number;
  reviewedItems: number;
  reviewedMemories: number;
  repoMemoriesOmittedForBusinessOnly: boolean;
}): { status: MemoryReviewCohortCoverageStatus; notes: string[] } {
  const notes: string[] = [];
  if (input.repoMemoriesOmittedForBusinessOnly) {
    notes.push(
      "repo_memories rows are omitted because repo_memories is repo-scoped and has no business_id; pass a repo filter to include repo memories.",
    );
  }
  if (input.generatedTotal === 0) {
    notes.push("No generated memories matched the selected business/repo filters.");
    return { status: "unknown", notes };
  }
  if (input.explicitRecallEvents === 0) {
    notes.push(
      "No explicit recall telemetry matched source recall, company_recall, or company_bootstrap; disabled recall/injection periods cannot be distinguished from never-recalled memories in V1.",
    );
    return { status: "unknown", notes };
  }
  if (input.promptLinkedRecallEvents === 0) {
    notes.push(
      "No prompt-linked recall/company_recall telemetry matched; observed recall counts are historical or bootstrap-only, and disabled recall/injection periods remain report-level caveats.",
    );
  }
  if (input.historicalRecallEvents > 0) {
    notes.push(
      "company_bootstrap and synthetic company-memory-recall rows are included as historical recall observations, not per-memory exposure labels.",
    );
  }
  if (input.reviewedItems === 0) {
    notes.push(
      "No memory_review_bot_item_results rows matched generated memories; review-quality rates are unavailable.",
    );
  } else if (input.reviewedMemories < input.observedRecalled) {
    notes.push(
      `Review coverage is partial: ${input.reviewedMemories} of ${input.observedRecalled} observed-recalled memories have item results.`,
    );
  }
  return { status: notes.length === 0 ? "complete" : "partial", notes };
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalTrimmed(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function coerceRows<T>(rows: unknown): T[] {
  return Array.isArray(rows) ? (rows as T[]) : [];
}
