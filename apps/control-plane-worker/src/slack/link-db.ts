import { createLogger } from "../logger";

const log = createLogger({ bindings: { component: "slack-link-db" } });

/**
 * Outcome of a magic-link identity bind attempt.
 * - `bound`: the Slack user is now linked to the Cycloid user.
 * - `already_linked_same`: the Cycloid user is already linked to this SAME Slack
 *   id -> idempotent success (a double-submit / re-confirm of the same identity).
 * - `already_linked_self`: the Cycloid user already has a link to a DIFFERENT
 *   Slack id -> refuse the rebind.
 * - `already_linked_other`: the Slack user is linked to a different Cycloid user.
 * - `replayed`: the token's `jti` was already consumed by a different user (replay).
 */
export type SlackIdentityBindResult =
  "bound" | "already_linked_same" | "already_linked_self" | "already_linked_other" | "replayed";

/** The Slack external user id currently linked to this Cycloid user, or null. */
export async function getSlackExternalIdForUser(db: D1Database, userId: number): Promise<string | null> {
  const row = await db
    .prepare("SELECT external_user_id FROM user_integrations WHERE user_id = ? AND integration_id = 'slack' LIMIT 1")
    .bind(userId)
    .first<{ external_user_id: string | null }>();
  return row?.external_user_id ?? null;
}

export async function getBusinessIdForUser(db: D1Database, userId: number): Promise<string | null> {
  const row = await db
    .prepare("SELECT business_id FROM users WHERE id = ? LIMIT 1")
    .bind(userId)
    .first<{ business_id: string | null }>();
  return row?.business_id ?? null;
}

export async function setLinkedSlackTeamIdForUser(db: D1Database, userId: number, teamId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE user_integrations
       SET external_team_id = ?
       WHERE user_id = ?
         AND integration_id = 'slack'
         AND external_team_id IS NULL
         AND (
           NOT EXISTS (
             SELECT 1 FROM slack_link_token_consumptions
             WHERE consumed_by_user_id = ?
           )
           OR ? = (
             SELECT slack_team_id FROM slack_link_token_consumptions
             WHERE consumed_by_user_id = ?
             ORDER BY consumed_at DESC
             LIMIT 1
           )
         )`,
    )
    .bind(teamId, userId, userId, teamId, userId)
    .run();
}

/**
 * The Slack workspace (team) the user's linked Slack id is valid in, or null.
 * This is the authority for "which workspace is this user's Slack id valid in"
 * when there is no Slack-origin context to lean on. Reads the durable
 * `user_integrations.external_team_id` first; falls back to the most-recent
 * `slack_link_token_consumptions` row only for links bound before that column
 * existed, since the ledger is pruned ~10 minutes after binding
 * (`pruneExpiredSlackLinkConsumptions`) and so cannot be relied on. Returns null
 * when neither source has a team, so callers fail closed rather than guess.
 */
export async function getLinkedSlackTeamIdForUser(db: D1Database, userId: number): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT COALESCE(
                (SELECT external_team_id FROM user_integrations
                  WHERE user_id = ? AND integration_id = 'slack'),
                (SELECT slack_team_id FROM slack_link_token_consumptions
                  WHERE consumed_by_user_id = ?
                  ORDER BY consumed_at DESC
                  LIMIT 1)
              ) AS team_id`,
    )
    .bind(userId, userId)
    .first<{ team_id: string | null }>();
  return row?.team_id ?? null;
}

/**
 * Atomically consume a magic-link token and bind the Slack identity to the
 * Cycloid user. Idempotent for the same user + same Slack id; refuses genuine
 * rebinds and cross-user binds:
 *
 * - A pre-check short-circuits without burning the token: if the user already
 *   holds the SAME Slack id it returns `already_linked_same` (idempotent
 *   success, the sequential double-submit case); a link to a DIFFERENT Slack id
 *   returns `already_linked_self` (refuse rebind).
 * - The bind runs as a single `db.batch` of [insert jti, upsert link]. The jti
 *   primary key is the single-use serialization point. On a duplicate-jti
 *   failure we re-read the user's link: if it is now this same Slack id the bind
 *   already succeeded (we lost a concurrent double-submit race) ->
 *   `already_linked_same`; otherwise it is a genuine cross-user replay ->
 *   `replayed`. The link upsert only writes `external_user_id` when the existing
 *   value is NULL, and the partial unique index on `(integration_id,
 *   external_user_id)` rejects a Slack id already owned by another user
 *   (`already_linked_other`). Identity-only: it never touches stored OAuth
 *   tokens.
 */
export async function bindSlackIdentity(
  db: D1Database,
  args: {
    userId: number;
    slackUserId: string;
    slackTeamId: string;
    jti: string;
    expiresAt: number;
    now?: number;
  },
): Promise<SlackIdentityBindResult> {
  const now = args.now ?? Date.now();

  const existing = await getSlackExternalIdForUser(db, args.userId);
  if (existing === args.slackUserId) {
    await setLinkedSlackTeamIdForUser(db, args.userId, args.slackTeamId);
    return "already_linked_same";
  }
  if (existing) return "already_linked_self";

  const insertJti = db
    .prepare(
      `INSERT INTO slack_link_token_consumptions
         (jti, slack_team_id, slack_user_id, consumed_by_user_id, consumed_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(args.jti, args.slackTeamId, args.slackUserId, args.userId, now, args.expiresAt);

  const upsertLink = db
    .prepare(
      `INSERT INTO user_integrations (user_id, integration_id, external_user_id, external_team_id, encrypted, connected_at, updated_at)
       VALUES (?, 'slack', ?, ?, 0, ?, ?)
       ON CONFLICT(user_id, integration_id) DO UPDATE SET
         external_user_id = excluded.external_user_id,
         external_team_id = excluded.external_team_id,
         updated_at = excluded.updated_at
       WHERE user_integrations.external_user_id IS NULL`,
    )
    .bind(args.userId, args.slackUserId, args.slackTeamId, now, now);

  try {
    await db.batch([insertJti, upsertLink]);
    return "bound";
  } catch (err) {
    const message = String(err);
    if (message.includes("slack_link_token_consumptions")) {
      // The jti was already consumed. If this user is now linked to this same
      // Slack id, the bind already committed (we lost a concurrent double-submit
      // race) -> idempotent success rather than a spurious replay error.
      if ((await getSlackExternalIdForUser(db, args.userId)) === args.slackUserId) {
        await setLinkedSlackTeamIdForUser(db, args.userId, args.slackTeamId);
        return "already_linked_same";
      }
      log.info({ userId: args.userId, slackTeamId: args.slackTeamId }, "Slack link token replayed");
      return "replayed";
    }
    if (
      message.includes("UNIQUE constraint failed") &&
      (message.includes("external_user") || message.includes("user_integrations"))
    ) {
      log.info({ userId: args.userId, slackTeamId: args.slackTeamId }, "Slack user already linked to another account");
      return "already_linked_other";
    }
    throw err;
  }
}

/**
 * Best-effort cleanup of expired consumption rows. Called opportunistically so
 * the single-use ledger does not grow without bound. Safe to fail.
 */
export async function pruneExpiredSlackLinkConsumptions(db: D1Database, now = Date.now()): Promise<void> {
  await db.prepare("DELETE FROM slack_link_token_consumptions WHERE expires_at < ?").bind(now).run();
}
