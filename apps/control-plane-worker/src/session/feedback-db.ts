export interface SessionFeedbackRow {
  id: string;
  session_id: string;
  user_id: string;
  rating: "up" | "down";
  message: string | null;
  transcript: string | null;
  created_at: number;
  updated_at: number;
}

interface SessionFeedbackSummaryRow {
  rating: "up" | "down";
  message: string | null;
  login: string | null;
  created_at: number | string;
}

export interface SessionFeedbackSummary {
  rating: "up" | "down";
  message: string | null;
  login: string | null;
  created_at: string;
}

function timestampToIso(timestamp: number | string): string {
  const ms = typeof timestamp === "number" ? timestamp : Number(timestamp);
  const parsedMs = Number.isFinite(ms) ? ms : Date.parse(String(timestamp));
  if (!Number.isFinite(parsedMs)) {
    throw new RangeError(`Cannot convert timestamp to ISO string: ${JSON.stringify(timestamp)}`);
  }
  return new Date(parsedMs).toISOString();
}

export async function upsertSessionFeedback(
  db: D1Database,
  params: { sessionId: string; userId: string; rating: "up" | "down"; message?: string; transcript?: string },
): Promise<void> {
  const now = Date.now();
  const id = `${params.sessionId}:${params.userId}`;
  await db
    .prepare(
      `INSERT INTO session_feedback (id, session_id, user_id, rating, message, transcript, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, user_id) DO UPDATE SET
         rating = excluded.rating,
         message = excluded.message,
         transcript = excluded.transcript,
         updated_at = excluded.updated_at`,
    )
    .bind(
      id,
      params.sessionId,
      params.userId,
      params.rating,
      params.message ?? null,
      params.transcript ?? null,
      now,
      now,
    )
    .run();
}

export async function getSessionFeedback(
  db: D1Database,
  sessionId: string,
  userId: string,
): Promise<SessionFeedbackRow | null> {
  return db
    .prepare("SELECT * FROM session_feedback WHERE session_id = ? AND user_id = ?")
    .bind(sessionId, userId)
    .first<SessionFeedbackRow>();
}

export async function getAllSessionFeedback(db: D1Database, sessionId: string): Promise<SessionFeedbackSummary[]> {
  const result = await db
    .prepare(
      `SELECT sf.rating, sf.message, sf.created_at, u.login
       FROM session_feedback sf
       LEFT JOIN users u ON sf.user_id = u.id
       WHERE sf.session_id = ?
       ORDER BY CASE
         WHEN typeof(sf.created_at) = 'text' THEN unixepoch(sf.created_at) * 1000
         ELSE sf.created_at
       END DESC`,
    )
    .bind(sessionId)
    .all<SessionFeedbackSummaryRow>();
  return result.results.map((row) => ({
    ...row,
    created_at: timestampToIso(row.created_at),
  }));
}
