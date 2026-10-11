import { isQaTesterAgentRole } from "../../../../shared/agent/constants.js";
import { type Phase, TERMINAL_PHASES } from "../../../../shared/session/phase.js";
import { MAX_VERIFICATION_RUNS_PER_PR, SESSION_DO_FANOUT_CONCURRENCY } from "../constants/verification";
import { getInstallationByOwner } from "../github/installations-db";
import { createInstallationToken } from "../github/octokit";
import { getPrMergeStatus } from "../github/pr";
import { parseGithubPullRequestUrl } from "../github/verification-pr-context";
import type { Logger } from "../logger";
import { postStructuredEventToDd } from "../observability/events-exporter";
import type { Env } from "../types";
import { mapBounded } from "../utils";
import {
  countStandaloneVerificationSessionsByGithubPrRef,
  listSessionIdsByWebhookRef,
  SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR,
} from "../webhooks/db";
import { getSessionLivenessRows } from "./db";
import { getVerificationRunCountForPrCoordination } from "./pr-coordination-db";
import { assertDatabase, getSessionState } from "./state";

// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
export { MAX_VERIFICATION_RUNS_PER_PR };

export interface ActiveVerifier {
  sessionId: string;
}

// ARC-1330 W11 D-51: the per-PR verification lock (ARC-1173) is removed. The single-verifier
// admission boundary is now the FSM-native spawn idempotency anchor (W11-V4) — the committed
// `pr_coordination` row + `stampVerificationChildId`'s `verification_child_id IS NULL`
// first-writer-wins claim. `findActiveVerificationSession` below stays as the advisory
// dedup that every entry point (and the W11-V4 anchor at live-side-effects.ts) consults.

export type VerificationRunLimitCheck =
  | { allowed: true; currentRuns: number | null; maxRuns: number }
  | { allowed: false; reason: "verification_run_limit_reached"; currentRuns: number; maxRuns: number };

export function verificationRunLimitMessage(currentRuns: number, maxRuns: number): string {
  return `Verification has already run ${currentRuns} times for this pull request (limit ${maxRuns}).`;
}

function emitVerificationGateFailOpen(env: Env, logger: Logger, fields: Record<string, unknown>): void {
  void postStructuredEventToDd(env, {
    event: "verification_gate.fail_open",
    ...fields,
  }).catch((error) => {
    logger.warn({ error: String(error), gate: fields.gate }, "Verification gate fail-open telemetry failed");
  });
}

interface VerificationRunLimitOptions {
  maxRuns?: number;
  parentSessionId?: string | null;
  includeStandaloneVerifierSessions?: boolean;
}

export type VerificationConflictCheckResult =
  | { skip: false }
  | {
      skip: true;
      reason: "merge_conflict";
    };

export async function checkVerificationConflict(
  env: Env,
  logger: Logger,
  input: {
    prUrl: string;
    installationId?: number | null;
    repoOwner?: string | null;
    repoName?: string | null;
  },
): Promise<VerificationConflictCheckResult> {
  try {
    const parsed = parseGithubPullRequestUrl(input.prUrl);
    if (!parsed) return { skip: false };

    const repoOwner = input.repoOwner?.trim() || null;
    const repoName = input.repoName?.trim() || null;
    // Repo hints are advisory. When both are present and disagree with the repo parsed from the PR
    // URL (fork PR, or the session repo changed after review-listening began), the caller's
    // installationId may belong to a different repo — so drop the hint and re-derive the installation
    // from the PR URL owner rather than skipping the check. Mirrors resolveInstallationToken in
    // github/verification-pr-context.ts. Must NOT early-return: that silently bypasses the
    // merge-conflict check for exactly the divergence cases this gate is meant to cover.
    const hintsMatch =
      repoOwner === null ||
      repoName === null ||
      (repoOwner.toLowerCase() === parsed.owner.toLowerCase() && repoName.toLowerCase() === parsed.repo.toLowerCase());

    if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) return { skip: false };

    let installationId = hintsMatch && typeof input.installationId === "number" ? input.installationId : null;
    if (!installationId) {
      const installation = await getInstallationByOwner(env.DB, parsed.owner);
      if (!installation || installation.suspended_at !== null) return { skip: false };
      installationId = installation.installation_id;
    }

    const token = await createInstallationToken(env, installationId);
    const mergeStatus = await getPrMergeStatus(token, parsed.owner, parsed.repo, parsed.number);
    return mergeStatus.mergeableState === "dirty" ? { skip: true, reason: "merge_conflict" } : { skip: false };
  } catch (error) {
    emitVerificationGateFailOpen(env, logger, {
      gate: "merge_conflict",
      pr_url: input.prUrl,
      installation_id: input.installationId ?? null,
      repo_owner: input.repoOwner ?? null,
      repo_name: input.repoName ?? null,
      error: String(error),
    });
    logger.warn(
      {
        prUrl: input.prUrl,
        installationId: input.installationId ?? null,
        repoOwner: input.repoOwner ?? null,
        repoName: input.repoName ?? null,
        error: String(error),
      },
      "Verification merge-conflict lookup failed; allowing verification session creation",
    );
    return { skip: false };
  }
}

/**
 * Shared duplicate-verifier gate for every verification entry point: the
 * auto-scheduler registers its verifiers under the `github_pr`
 * webhook ref, and the manual surfaces (API `qa: true`, Slack `qa=true`,
 * GitHub PR-comment mention, plus legacy `verify`) consult this gate before spawning
 * a verifier for the same PR. Liveness comes from `session_index.rich_status`
 * rather than a permanent claim, so the gate self-heals once a verifier
 * reaches a terminal phase.
 *
 * Convenience gate, not a security boundary: lookup failures fail open so a
 * partial outage cannot block verification entirely.
 */
export async function findActiveVerificationSession(
  env: Env,
  logger: Logger,
  prUrl: string,
): Promise<ActiveVerifier | null> {
  try {
    const db = assertDatabase(env);
    const sessionIds = await listSessionIdsByWebhookRef(db, SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR, prUrl);
    if (sessionIds.length === 0) return null;

    const rows = await getSessionLivenessRows(db, sessionIds);
    const rowsById = new Map(rows.map((row) => [row.session_id, row]));
    // A ref with no session_index row yet is a verifier whose projection has
    // not landed (registration runs before the projection write). Treat it as
    // potentially live and let the DO state check decide, instead of letting
    // a just-created verifier slip past the gate. Rows that have landed are
    // filtered on the projected agent_role so non-verifier sessions never
    // cost a DO round-trip.
    const candidateSessionIds = sessionIds.filter((sessionId) => {
      const row = rowsById.get(sessionId);
      if (!row) return true;
      if (row.status === "archived") return false;
      // Null/missing agent_role is unknown (pre-projection or legacy row):
      // keep it and let the DO state check decide.
      if (row.agent_role && row.agent_role !== "verification") return false;
      const phase = (row.rich_status ?? "idle") as Phase;
      return !TERMINAL_PHASES.has(phase);
    });

    const sessions = await mapBounded(candidateSessionIds, SESSION_DO_FANOUT_CONCURRENCY, (sessionId) =>
      getSessionState(env, sessionId).catch((error: unknown) => {
        logger.warn({ prUrl, sessionId, error: String(error) }, "Active-verifier DO state fetch failed; skipping");
        return null;
      }),
    );
    for (const [index, session] of sessions.entries()) {
      if (session && session.status === "active" && isQaTesterAgentRole(session.agentRole)) {
        return { sessionId: candidateSessionIds[index] };
      }
    }
    return null;
  } catch (error) {
    emitVerificationGateFailOpen(env, logger, {
      gate: "active_verifier",
      pr_url: prUrl,
      error: String(error),
    });
    logger.warn(
      { prUrl, error: String(error) },
      "Active-verifier lookup failed; allowing verification session creation",
    );
    return null;
  }
}

export async function checkVerificationRunLimit(
  env: Env,
  logger: Logger,
  prUrl: string,
  options?: number | VerificationRunLimitOptions,
): Promise<VerificationRunLimitCheck> {
  const maxRuns = typeof options === "number" ? options : (options?.maxRuns ?? MAX_VERIFICATION_RUNS_PER_PR);
  const parentSessionId = typeof options === "number" ? null : (options?.parentSessionId ?? null);
  const includeStandaloneVerifierSessions =
    typeof options === "number" ? false : (options?.includeStandaloneVerifierSessions ?? false);
  // The FSM-owned `verification_run_count` is the run-budget source of truth. It is
  // keyed by the parent session when known; PR-only entry points use a bounded
  // pr_coordination fallback. Direct qa=true entry points opt into a standalone
  // verifier fallback because those sessions do not go through the FSM request_verification
  // transition before admission.
  try {
    const db = assertDatabase(env);
    const coordinationRuns = await getVerificationRunCountForPrCoordination(db, { prUrl, parentSessionId });
    let currentRuns = coordinationRuns;
    if (includeStandaloneVerifierSessions) {
      try {
        const standaloneRuns = await countStandaloneVerificationSessionsByGithubPrRef(db, prUrl);
        currentRuns = (coordinationRuns ?? 0) + standaloneRuns;
      } catch (error) {
        emitVerificationGateFailOpen(env, logger, {
          gate: "standalone_run_limit",
          pr_url: prUrl,
          max_runs: maxRuns,
          error: String(error),
        });
        logger.warn(
          { prUrl, maxRuns, error: String(error) },
          "Standalone verification run-limit fallback lookup failed; continuing with coordination run count",
        );
      }
    }
    if (currentRuns === null) return { allowed: true, currentRuns, maxRuns };
    if (currentRuns >= maxRuns) {
      return { allowed: false, reason: "verification_run_limit_reached", currentRuns, maxRuns };
    }
    return { allowed: true, currentRuns, maxRuns };
  } catch (error) {
    emitVerificationGateFailOpen(env, logger, {
      gate: "run_limit",
      pr_url: prUrl,
      max_runs: maxRuns,
      error: String(error),
    });
    logger.warn(
      { prUrl, maxRuns, error: String(error) },
      "Verification run-limit lookup failed; allowing verification session creation",
    );
    return { allowed: true, currentRuns: null, maxRuns };
  }
}
