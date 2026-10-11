export type MemoryFeedbackDisplayEventType = "memory_usage" | "memory_recall_usage";
export type MemoryFeedbackUsageSource = "prompt_start" | "recall" | "company_bootstrap" | "company_recall";
export type MemoryFeedbackRating = "up" | "down";
export type MemoryFeedbackSlackPostStatus = "skipped_config" | "sent" | "failed";

export interface MemoryFeedbackRow {
  id: string;
  feedback_key: string;
  session_id: string;
  prompt_id: string;
  activity_event_id: string;
  display_event_type: MemoryFeedbackDisplayEventType;
  usage_source: MemoryFeedbackUsageSource;
  memory_id: string;
  user_id: string;
  user_login: string | null;
  rating: MemoryFeedbackRating;
  message: string | null;
  memory_title: string | null;
  memory_path: string | null;
  memory_reason: string | null;
  memory_expected_effect: string | null;
  memory_observed_effect: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  session_url: string | null;
  slack_channel_id: string | null;
  slack_message_ts: string | null;
  slack_post_status: MemoryFeedbackSlackPostStatus | null;
  slack_post_error: string | null;
  created_at: number;
}

export interface InsertMemoryFeedbackParams {
  id: string;
  feedbackKey: string;
  sessionId: string;
  promptId: string;
  activityEventId: string;
  displayEventType: MemoryFeedbackDisplayEventType;
  usageSource: MemoryFeedbackUsageSource;
  memoryId: string;
  userId: string;
  userLogin?: string | null;
  rating: MemoryFeedbackRating;
  message?: string | null;
  memoryTitle?: string | null;
  memoryPath?: string | null;
  memoryReason?: string | null;
  memoryExpectedEffect?: string | null;
  memoryObservedEffect?: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
  sessionUrl?: string | null;
  createdAt?: number;
}

export function buildMemoryFeedbackKey(params: {
  sessionId: string;
  promptId: string;
  activityEventId: string;
  memoryId: string;
  userId: string;
}): string {
  return [params.sessionId, params.promptId, params.activityEventId, params.memoryId, params.userId].join(":");
}

export async function insertMemoryFeedback(
  db: D1Database,
  params: InsertMemoryFeedbackParams,
): Promise<MemoryFeedbackRow> {
  const createdAt = params.createdAt ?? Date.now();
  await db
    .prepare(
      `INSERT INTO memory_feedback (
         id, feedback_key, session_id, prompt_id, activity_event_id, display_event_type, usage_source,
         memory_id, user_id, user_login, rating, message, memory_title, memory_path, memory_reason,
         memory_expected_effect, memory_observed_effect, repo_owner, repo_name, session_url, created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      params.id,
      params.feedbackKey,
      params.sessionId,
      params.promptId,
      params.activityEventId,
      params.displayEventType,
      params.usageSource,
      params.memoryId,
      params.userId,
      params.userLogin ?? null,
      params.rating,
      params.message ?? null,
      params.memoryTitle ?? null,
      params.memoryPath ?? null,
      params.memoryReason ?? null,
      params.memoryExpectedEffect ?? null,
      params.memoryObservedEffect ?? null,
      params.repoOwner ?? null,
      params.repoName ?? null,
      params.sessionUrl ?? null,
      createdAt,
    )
    .run();

  return {
    id: params.id,
    feedback_key: params.feedbackKey,
    session_id: params.sessionId,
    prompt_id: params.promptId,
    activity_event_id: params.activityEventId,
    display_event_type: params.displayEventType,
    usage_source: params.usageSource,
    memory_id: params.memoryId,
    user_id: params.userId,
    user_login: params.userLogin ?? null,
    rating: params.rating,
    message: params.message ?? null,
    memory_title: params.memoryTitle ?? null,
    memory_path: params.memoryPath ?? null,
    memory_reason: params.memoryReason ?? null,
    memory_expected_effect: params.memoryExpectedEffect ?? null,
    memory_observed_effect: params.memoryObservedEffect ?? null,
    repo_owner: params.repoOwner ?? null,
    repo_name: params.repoName ?? null,
    session_url: params.sessionUrl ?? null,
    slack_channel_id: null,
    slack_message_ts: null,
    slack_post_status: null,
    slack_post_error: null,
    created_at: createdAt,
  };
}

export async function updateMemoryFeedbackSlackDelivery(
  db: D1Database,
  params: {
    id: string;
    status: MemoryFeedbackSlackPostStatus;
    channelId?: string | null;
    messageTs?: string | null;
    error?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE memory_feedback
       SET slack_post_status = ?, slack_channel_id = ?, slack_message_ts = ?, slack_post_error = ?
       WHERE id = ?`,
    )
    .bind(params.status, params.channelId ?? null, params.messageTs ?? null, params.error ?? null, params.id)
    .run();
}

export async function getLatestMemoryFeedbackForSessionUser(
  db: D1Database,
  sessionId: string,
  userId: string,
): Promise<MemoryFeedbackRow[]> {
  const result = await db
    .prepare(
      `SELECT mf.*
       FROM memory_feedback mf
       WHERE mf.session_id = ? AND mf.user_id = ?
         AND mf.id = (
           SELECT latest.id
           FROM memory_feedback latest
           WHERE latest.feedback_key = mf.feedback_key
             AND latest.session_id = mf.session_id
             AND latest.user_id = mf.user_id
           ORDER BY latest.created_at DESC, latest.rowid DESC
           LIMIT 1
         )
       ORDER BY mf.created_at DESC, mf.rowid DESC`,
    )
    .bind(sessionId, userId)
    .all<MemoryFeedbackRow>();
  return result.results;
}
