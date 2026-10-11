// ARC-1330 lifecycle FSM — persistence for the per-item review disposition store
// (migration 0214). Pure DAO: upsert one item's disposition, count the
// undispositioned actionable items for a PR, and list a PR's items. NO transition
// logic lives here — the spine (`applyEvent`, a later wave) maps the FSM's
// `register_review` / `inject_findings` worklist registrations and the epoch-terminal
// `disposition` side-effects onto these writes, and builds the `caught_up` snapshot
// from `countUndispositionedActionable`.
//
// This is the SINGLE authoritative item set the `caught_up` conjunction reads
// (Locked decision 1, design §13/SF15): `caught_up` requires every actionable item
// dispositioned, i.e. `countUndispositionedActionable(session, pr) === 0`.
//
// `disposition` is typed as a local string union (not imported from `fsm/types`) so
// this DAO stays a standalone persistence layer — mirroring `pr-coordination-db.ts`,
// which types its enum-ish columns loosely. The union is kept in lockstep with
// `fsm/types.ts` `Disposition` and the migration's CHECK constraint (both
// `none | fixed | replied | declined`).

/**
 * The per-item disposition. `none` = registered-but-undispositioned actionable (the
 * state `register_review` / `inject_findings` write); `fixed` / `replied` / `declined`
 * are the terminal stamps an epoch applies; `no_action_needed_informational` is the
 * terminal stamp the worklist noise gate (D4) applies to a known bot's purely-informational
 * output so it is counted as handled without prompting. Mirrors `fsm/types.ts` `Disposition`.
 */
export type ItemDisposition = "none" | "fixed" | "replied" | "declined" | "no_action_needed_informational";

/** In-memory shape of one `pr_review_item_dispositions` row. */
export interface PrReviewItemDisposition {
  sessionId: string;
  prUrl: string;
  sourceId: string;
  disposition: ItemDisposition;
  /** The triage reasoning. REQUIRED for `declined` (triage-with-basis, §13); else null. */
  basis: string | null;
  /** The epoch that stamped the terminal disposition (null while `none`). */
  epochId: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * The fields an upsert writes for one item. The key `(sessionId, prUrl, sourceId)`
 * identifies the row; `disposition` is required; `basis` / `epochId` default to null.
 */
export interface PrReviewItemDispositionUpsert {
  sessionId: string;
  prUrl: string;
  sourceId: string;
  disposition: ItemDisposition;
  basis?: string | null;
  epochId?: string | null;
}

/** Raw column shape as it comes back from SQLite (snake_case). */
interface PrReviewItemDispositionRow {
  session_id: string;
  pr_url: string;
  source_id: string;
  disposition: string;
  basis: string | null;
  epoch_id: string | null;
  created_at: number;
  updated_at: number;
}

interface PrReviewItemDispositionRegistration {
  sessionId: string;
  prUrl: string;
  sourceId: string;
}

const MAX_BATCH_STATEMENTS = 50;

function rowToRecord(row: PrReviewItemDispositionRow): PrReviewItemDisposition {
  return {
    sessionId: row.session_id,
    prUrl: row.pr_url,
    sourceId: row.source_id,
    disposition: row.disposition as ItemDisposition,
    basis: row.basis,
    epochId: row.epoch_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** True iff `basis` carries real triage reasoning (a non-blank string). */
function hasBasis(basis: string | null | undefined): boolean {
  return typeof basis === "string" && basis.trim().length > 0;
}

const REGISTER_DISPOSITION_IF_ABSENT_SQL = `INSERT INTO pr_review_item_dispositions (
  session_id, pr_url, source_id, disposition, basis, epoch_id, created_at, updated_at
) VALUES (?, ?, ?, 'none', NULL, NULL, ?, ?)
ON CONFLICT (session_id, pr_url, source_id) DO NOTHING`;

/**
 * Upsert one item's disposition (the single write primitive). On first write the row
 * is inserted with `created_at = updated_at = now`; a later write to the same
 * `(sessionId, prUrl, sourceId)` updates `disposition` / `basis` / `epoch_id` and bumps
 * `updated_at`, preserving `created_at`. `register_review` / `inject_findings` call this
 * with `disposition: "none"` (no basis/epoch); the epoch terminals call it with the
 * terminal stamp + owning `epochId`.
 *
 * REFUSES a `declined` write with no `basis` (`undefined`/`null`/blank): `epoch.declined`
 * is triage-with-basis (a reasoned classification + reply), never an unchecked self-signal
 * (design §13). Enforcing it here — at the single authoritative store boundary — closes the
 * soundness hole where a fix agent could self-decline real reviews to reach MERGE_READY.
 */
export async function upsertDisposition(
  db: D1Database,
  input: PrReviewItemDispositionUpsert,
  now: number,
): Promise<void> {
  if (input.disposition === "declined" && !hasBasis(input.basis)) {
    throw new Error(
      `upsertDisposition: a 'declined' disposition requires a non-empty basis (triage-with-basis, ARC-1330) ` +
        `for session=${input.sessionId} pr=${input.prUrl} source=${input.sourceId}`,
    );
  }
  const basis = input.basis ?? null;
  const epochId = input.epochId ?? null;
  await db
    .prepare(
      `INSERT INTO pr_review_item_dispositions (
        session_id, pr_url, source_id, disposition, basis, epoch_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_id, pr_url, source_id) DO UPDATE SET
        disposition = excluded.disposition,
        basis = excluded.basis,
        epoch_id = excluded.epoch_id,
        updated_at = excluded.updated_at`,
    )
    .bind(input.sessionId, input.prUrl, input.sourceId, input.disposition, basis, epochId, now, now)
    .run();
}

const UPSERT_DISPOSITION_SQL = `INSERT INTO pr_review_item_dispositions (
  session_id, pr_url, source_id, disposition, basis, epoch_id, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (session_id, pr_url, source_id) DO UPDATE SET
  disposition = excluded.disposition,
  basis = excluded.basis,
  epoch_id = excluded.epoch_id,
  updated_at = excluded.updated_at`;

export async function upsertDispositionsBatch(
  db: D1Database,
  inputs: readonly PrReviewItemDispositionUpsert[],
  now: number,
): Promise<void> {
  if (inputs.length === 0) return;
  for (const input of inputs) {
    if (input.disposition === "declined" && !hasBasis(input.basis)) {
      throw new Error(
        `upsertDispositionsBatch: a 'declined' disposition requires a non-empty basis (triage-with-basis, ARC-1330) ` +
          `for session=${input.sessionId} pr=${input.prUrl} source=${input.sourceId}`,
      );
    }
  }

  for (let index = 0; index < inputs.length; index += MAX_BATCH_STATEMENTS) {
    const chunk = inputs.slice(index, index + MAX_BATCH_STATEMENTS);
    await db.batch(
      chunk.map((input) =>
        db
          .prepare(UPSERT_DISPOSITION_SQL)
          .bind(
            input.sessionId,
            input.prUrl,
            input.sourceId,
            input.disposition,
            input.basis ?? null,
            input.epochId ?? null,
            now,
            now,
          ),
      ),
    );
  }
}

/**
 * REGISTRATION-ONLY write (ARC-1330 PR 46): record an item as an undispositioned actionable
 * (`disposition = 'none'`) IFF no row exists yet — `ON CONFLICT DO NOTHING`. This is what the
 * live worklist sink uses for `register_review` / `inject_findings`, and the DO-NOTHING is
 * load-bearing: a webhook-redelivered / re-ingested review re-registers the SAME source id, and
 * an unconditional upsert would REWIND a terminal `fixed`/`replied`/`declined` stamp back to
 * `none` — wedging `caught_up` (and the session) forever on an already-addressed item. A
 * genuinely new review carries a new source id, so it always inserts. `upsertDisposition`
 * intentionally keeps its overwrite semantics — the epoch terminals legitimately re-stamp.
 */
export async function registerDispositionIfAbsent(
  db: D1Database,
  input: PrReviewItemDispositionRegistration,
  now: number,
): Promise<void> {
  await db
    .prepare(REGISTER_DISPOSITION_IF_ABSENT_SQL)
    .bind(input.sessionId, input.prUrl, input.sourceId, now, now)
    .run();
}

/**
 * Batched registration write for a transition's whole worklist. The rows are independent and
 * `ON CONFLICT DO NOTHING`, so D1's single `batch()` call preserves the all-or-error round trip the
 * live worklist sink needs without N serial network hops.
 */
export async function registerDispositionsIfAbsent(
  db: D1Database,
  inputs: readonly PrReviewItemDispositionRegistration[],
  now: number,
): Promise<void> {
  if (inputs.length === 0) return;
  await db.batch(
    inputs.map((input) =>
      db.prepare(REGISTER_DISPOSITION_IF_ABSENT_SQL).bind(input.sessionId, input.prUrl, input.sourceId, now, now),
    ),
  );
}

interface PrReviewItemInformationalStamp {
  sessionId: string;
  prUrl: string;
  sourceId: string;
  /** The gate reason recorded as the row `basis` for audit (e.g. "no_findings"). */
  basis: string;
}

// Stamp `no_action_needed_informational` for a worklist item the noise gate (D4) classified as a known
// bot's purely-informational output. INSERT the terminal stamp if absent; on conflict CONVERT only an
// undispositioned (`none`) row — the `WHERE ... disposition = 'none'` guard is load-bearing: the FSM
// review producer may have already registered the same source id as `none` at webhook time (an
// unactionable-looking non-blank body), and this converts that to the terminal stamp so it stops gating
// `caught_up`; but it must NEVER rewind a real `fixed`/`replied`/`declined` stamp (same soundness rule as
// registerDispositionIfAbsent), nor re-touch an already-informational row.
const STAMP_INFORMATIONAL_SQL = `INSERT INTO pr_review_item_dispositions (
  session_id, pr_url, source_id, disposition, basis, epoch_id, created_at, updated_at
) VALUES (?, ?, ?, 'no_action_needed_informational', ?, NULL, ?, ?)
ON CONFLICT (session_id, pr_url, source_id) DO UPDATE SET
  disposition = 'no_action_needed_informational',
  basis = excluded.basis,
  updated_at = excluded.updated_at
WHERE pr_review_item_dispositions.disposition = 'none'`;

/** Batched stamp for a sweep's whole set of noise-gated items (one D1 round trip). */
export async function stampInformationalDispositions(
  db: D1Database,
  inputs: readonly PrReviewItemInformationalStamp[],
  now: number,
): Promise<void> {
  if (inputs.length === 0) return;
  await db.batch(
    inputs.map((input) =>
      db.prepare(STAMP_INFORMATIONAL_SQL).bind(input.sessionId, input.prUrl, input.sourceId, input.basis, now, now),
    ),
  );
}

/**
 * Count the actionable items for a PR that are NOT yet dispositioned (`disposition = 'none'`).
 * This is the `caught_up` conjunct: the spine builds the `CaughtUpStore`'s
 * `countUndispositionedActionable()` from this — `caught_up` requires it to be 0
 * (every registered actionable item, including ones accumulated during a QA hold, dispositioned).
 */
export async function countUndispositionedActionable(
  db: D1Database,
  sessionId: string,
  prUrl: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM pr_review_item_dispositions
       WHERE session_id = ? AND pr_url = ? AND disposition = 'none'`,
    )
    .bind(sessionId, prUrl)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/**
 * List the source ids of a PR's actionable items that are NOT yet dispositioned
 * (`disposition = 'none'`), oldest first. This is the **released item set** the §17-C
 * `release_queued_reviews` producer drains: on every VERIFYING exit / NEEDS_YOU re-open
 * the spine reads these and emits one internal `review.item_ready{itemId}` per id
 * (`fsm/release-queued-reviews.ts`) so each held item re-runs the REVIEW cascade and gets
 * an epoch — no wedged `caught_up` (design §17-C). Companion to `countUndispositionedActionable`
 * (same `disposition = 'none'` predicate): the count feeds the `caught_up` guard, the ids feed
 * the producer.
 */
export async function listUndispositionedActionable(
  db: D1Database,
  sessionId: string,
  prUrl: string,
): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT source_id FROM pr_review_item_dispositions
       WHERE session_id = ? AND pr_url = ? AND disposition = 'none'
       ORDER BY created_at ASC, source_id ASC`,
    )
    .bind(sessionId, prUrl)
    .all<{ source_id: string }>();
  return (result.results ?? []).map((row) => row.source_id);
}

/** List every item recorded for a PR (oldest first), for observability/debug. */
export async function listForPr(db: D1Database, sessionId: string, prUrl: string): Promise<PrReviewItemDisposition[]> {
  const result = await db
    .prepare(
      `SELECT * FROM pr_review_item_dispositions
       WHERE session_id = ? AND pr_url = ? ORDER BY created_at ASC, source_id ASC`,
    )
    .bind(sessionId, prUrl)
    .all<PrReviewItemDispositionRow>();
  return (result.results ?? []).map(rowToRecord);
}
