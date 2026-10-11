import { upsertRow } from "../db-helpers";

export interface UpsertSessionPrMetadataInput {
  sessionId: string;
  prUrl: string;
  prNumber: number | null;
  prDraft: boolean | null;
  publishedBranch: string | null;
  sourcePromptId?: string | null;
  now?: number;
}

export async function upsertSessionPrMetadata(db: D1Database, input: UpsertSessionPrMetadataInput): Promise<void> {
  if (typeof db.prepare !== "function") return;
  const now = input.now ?? Date.now();
  await upsertRow(db, {
    table: "session_pr_metadata",
    columns: [
      "session_id",
      "pr_url",
      "pr_number",
      "pr_draft",
      "published_branch",
      "source_prompt_id",
      "created_at",
      "updated_at",
    ],
    values: [
      input.sessionId,
      input.prUrl,
      input.prNumber,
      input.prDraft == null ? null : input.prDraft ? 1 : 0,
      input.publishedBranch,
      input.sourcePromptId ?? null,
      now,
      now,
    ],
    conflictKeys: ["session_id", "pr_url"],
    updateOverrides: {
      source_prompt_id: "COALESCE(excluded.source_prompt_id, session_pr_metadata.source_prompt_id)",
    },
    excludeFromUpdate: ["created_at"],
  });
}

export async function updateSessionPrMetadataDraft(
  db: D1Database,
  input: { sessionId: string; prUrl: string; prDraft: boolean; now?: number },
): Promise<void> {
  if (typeof db.prepare !== "function") return;
  const now = input.now ?? Date.now();
  await db
    .prepare(
      `UPDATE session_pr_metadata
       SET pr_draft = ?, updated_at = ?
       WHERE session_id = ? AND pr_url = ?`,
    )
    .bind(input.prDraft ? 1 : 0, now, input.sessionId, input.prUrl)
    .run();
}
