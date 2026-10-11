import { z } from "zod";

import { getUserByGithubId } from "../auth/db";
import { getPendingSignupById, markPendingSignupDenied } from "../auth/pending-signups-db";
import { getBusiness } from "../business/db";
import { createLogger } from "../logger";

const log = createLogger({ bindings: { component: "admin-approvals-service" } });

export const ApprovePendingSignupSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("new"),
    businessName: z.string().trim().min(1).max(120),
    role: z.enum(["admin", "member"]).default("member"),
  }),
  z.object({
    kind: z.literal("existing"),
    businessId: z.string().min(1),
    role: z.enum(["admin", "member"]),
  }),
]);

export type ApprovePendingSignupInput = z.infer<typeof ApprovePendingSignupSchema>;

export type ApprovePendingSignupResult =
  | { status: "ok"; userId: number; businessId: string }
  | { status: "not_found" }
  | { status: "already_denied" }
  | { status: "business_not_found" }
  | { status: "existing_user_conflict"; userId: number };

/**
 * Approve a pending signup by atomically claiming the pending row, creating
 * (or attaching to) a business, and recording the user + business membership.
 *
 * The pending row is claimed via `DELETE ... RETURNING` before any side
 * effects, so two admins double-clicking can't both create a business: only
 * the first DELETE returns a row, the second sees `not_found`. Existing users
 * are excluded from the claim condition so approvals fail closed instead of
 * silently re-homing a GitHub identity into a different business.
 */
export async function approvePendingSignup(
  db: D1Database,
  pendingId: number,
  input: ApprovePendingSignupInput,
  approverUserId: number,
): Promise<ApprovePendingSignupResult> {
  // For the existing-business case we want to fail fast with `business_not_found`
  // BEFORE we destructively claim the pending row, so the admin can retry.
  if (input.kind === "existing") {
    const existing = await getBusiness(db, input.businessId);
    if (!existing) return { status: "business_not_found" };
  }

  const claimed = await db
    .prepare(
      `DELETE FROM pending_signups
       WHERE id = ? AND denied_at IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM users
           WHERE users.github_id = pending_signups.github_id
         )
       RETURNING github_id, login, name, email, avatar_url`,
    )
    .bind(pendingId)
    .first<{
      github_id: number;
      login: string;
      name: string | null;
      email: string | null;
      avatar_url: string | null;
    }>();
  if (!claimed) {
    const pending = await getPendingSignupById(db, pendingId);
    if (pending?.deniedAt) return { status: "already_denied" };
    if (pending) {
      const existingUser = await getUserByGithubId(db, pending.githubId);
      if (existingUser) {
        log.warn(
          {
            pendingId,
            githubId: pending.githubId,
            githubLogin: pending.login,
            existingUserId: existingUser.id,
            approverUserId,
            action: "pending_signup_existing_user_conflict",
          },
          "Pending signup approval blocked because the GitHub user already exists",
        );
        return { status: "existing_user_conflict", userId: existingUser.id };
      }
    }
    return { status: "not_found" };
  }

  const businessId = input.kind === "new" ? crypto.randomUUID() : input.businessId;
  const now = Date.now();
  const role = input.role;

  await db.batch([
    ...(input.kind === "new"
      ? [
          db
            .prepare("INSERT INTO businesses (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
            .bind(businessId, input.businessName, now, now),
        ]
      : []),
    db
      .prepare(
        `INSERT INTO users (github_id, login, name, email, avatar_url, business_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (github_id) DO NOTHING`,
      )
      .bind(claimed.github_id, claimed.login, claimed.name, claimed.email, claimed.avatar_url, businessId, now, now),
    db
      .prepare(
        `INSERT INTO business_members (business_id, user_id, role, created_at, updated_at)
         SELECT ?, users.id, ?, ?, ?
         FROM users
         WHERE users.github_id = ?
         ON CONFLICT (user_id) DO NOTHING`,
      )
      .bind(businessId, role, now, now, claimed.github_id),
  ]);

  const userRow = await db
    .prepare("SELECT id FROM users WHERE github_id = ? LIMIT 1")
    .bind(claimed.github_id)
    .first<{ id: number }>();
  if (!userRow) {
    throw new Error(`approvePendingSignup: user row missing after insert for github_id=${claimed.github_id}`);
  }

  log.info(
    {
      pendingId,
      githubId: claimed.github_id,
      githubLogin: claimed.login,
      businessId,
      role,
      approverUserId,
      action: "pending_signup_approved",
    },
    "Pending signup approved",
  );

  return { status: "ok", userId: userRow.id, businessId };
}

export type DenyPendingSignupResult = { status: "ok" } | { status: "not_found" } | { status: "already_denied" };

export async function denyPendingSignup(
  db: D1Database,
  pendingId: number,
  denierUserId: number,
): Promise<DenyPendingSignupResult> {
  const pending = await getPendingSignupById(db, pendingId);
  if (!pending) return { status: "not_found" };
  if (pending.deniedAt) return { status: "already_denied" };
  const ok = await markPendingSignupDenied(db, pendingId, denierUserId, Date.now());
  if (!ok) return { status: "already_denied" };
  log.info(
    {
      pendingId,
      githubId: pending.githubId,
      githubLogin: pending.login,
      denierUserId,
      action: "pending_signup_denied",
    },
    "Pending signup denied",
  );
  return { status: "ok" };
}
