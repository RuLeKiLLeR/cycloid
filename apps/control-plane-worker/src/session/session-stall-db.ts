import { TERMINAL_PHASES_ARRAY } from "../../../../shared/session/phase.js";

export interface ActiveVerificationAgeAggregate {
  count: number;
  stalledCount: number;
  oldestCreatedAt: number | null;
  oldestSessionId: string | null;
  unanchoredCount: number;
}

interface VerificationSessionAgeRow {
  session_id: string;
  created_at: string | number;
}

function parseCreatedAtMs(value: string | number): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? numeric : null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Reads live verification-session age from session_index, not the post-publish
 * PR spine. Verification sessions can remain in pre-publish `running` for their
 * whole multi-phase run, so FSM state dwell alone cannot enforce their total
 * ten-minute budget. Session ids stay in the structured warning only; metrics
 * aggregate at one low-cardinality verification cohort.
 */
export async function readActiveVerificationAge(
  db: D1Database,
  stalledBeforeMs: number,
): Promise<ActiveVerificationAgeAggregate> {
  const placeholders = TERMINAL_PHASES_ARRAY.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT session_id, created_at
       FROM session_index
       WHERE agent_role = 'verification'
         AND status != 'closed'
         AND status != 'archived'
         AND (rich_status IS NULL OR rich_status NOT IN (${placeholders}))`,
    )
    .bind(...TERMINAL_PHASES_ARRAY)
    .all<VerificationSessionAgeRow>();

  let oldestCreatedAt: number | null = null;
  let oldestSessionId: string | null = null;
  let stalledCount = 0;
  let unanchoredCount = 0;
  for (const row of result.results ?? []) {
    const createdAt = parseCreatedAtMs(row.created_at);
    if (createdAt === null) {
      unanchoredCount += 1;
      continue;
    }
    if (createdAt <= stalledBeforeMs) stalledCount += 1;
    if (oldestCreatedAt === null || createdAt < oldestCreatedAt) {
      oldestCreatedAt = createdAt;
      oldestSessionId = row.session_id;
    }
  }
  return {
    count: (result.results ?? []).length,
    stalledCount,
    oldestCreatedAt,
    oldestSessionId,
    unanchoredCount,
  };
}
