// ARC-1330 lifecycle FSM — persistence for the append-only `pr_coordination_events`
// transition log (migration 0213). Pure DAO: append one row per committed
// transition, read the log in version order, and read the latest settle-dedup
// key. NO logic lives here — `dwell_ms` is computed by the spine (a later wave)
// and merely persisted here; the settle dedup DECISION belongs to a later wave's
// caller, this module only surfaces the latest stored key.
//
// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
// The `actor` value 'verification' is a kept verification-vocabulary site.

/**
 * In-memory shape of one `pr_coordination_events` row as read back. `metadata`
 * is JSON-parsed back to its stored object (or null). `dwellMs` and
 * `settleDedupKey` are nullable — the appender may omit them.
 */
export interface PrCoordinationEvent {
  sessionId: string;
  version: number;
  fromState: string;
  toState: string;
  event: string;
  at: number;
  actor: string;
  metadata: unknown | null;
  dwellMs: number | null;
  settleDedupKey: string | null;
}

/**
 * Append shape. `metadata` is JSON-stringified on write (NULL when undefined or
 * null). `dwellMs`/`settleDedupKey` default to null when omitted.
 */
export interface PrCoordinationEventInput {
  sessionId: string;
  version: number;
  fromState: string;
  toState: string;
  event: string;
  at: number;
  actor: string;
  metadata?: unknown;
  dwellMs?: number | null;
  settleDedupKey?: string | null;
}

/** Raw column shape as it comes back from SQLite (snake_case; metadata as TEXT). */
interface PrCoordinationEventRow {
  session_id: string;
  version: number;
  from_state: string;
  to_state: string;
  event: string;
  at: number;
  actor: string;
  metadata: string | null;
  dwell_ms: number | null;
  settle_dedup_key: string | null;
}

function rowToRecord(row: PrCoordinationEventRow): PrCoordinationEvent {
  return {
    sessionId: row.session_id,
    version: row.version,
    fromState: row.from_state,
    toState: row.to_state,
    event: row.event,
    at: row.at,
    actor: row.actor,
    metadata: row.metadata == null ? null : JSON.parse(row.metadata),
    dwellMs: row.dwell_ms,
    settleDedupKey: row.settle_dedup_key,
  };
}

/** Append one transition row. `metadata` is stored as JSON (NULL when absent). */
export async function appendPrCoordinationEvent(db: D1Database, input: PrCoordinationEventInput): Promise<void> {
  const metadata = input.metadata == null ? null : JSON.stringify(input.metadata);
  await db
    .prepare(
      `INSERT INTO pr_coordination_events (
        session_id, version, from_state, to_state, event, at, actor, metadata, dwell_ms, settle_dedup_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.sessionId,
      input.version,
      input.fromState,
      input.toState,
      input.event,
      input.at,
      input.actor,
      metadata,
      input.dwellMs ?? null,
      input.settleDedupKey ?? null,
    )
    .run();
}

/** Read the full transition log for a session in version-ascending order. */
export async function listPrCoordinationEvents(db: D1Database, sessionId: string): Promise<PrCoordinationEvent[]> {
  const result = await db
    .prepare(`SELECT * FROM pr_coordination_events WHERE session_id = ? ORDER BY version ASC`)
    .bind(sessionId)
    .all<PrCoordinationEventRow>();
  return (result.results ?? []).map(rowToRecord);
}
