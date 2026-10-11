import type { ErrorCode } from "../../../../shared/types/sandbox.js";
import { resolvePublicAppBaseUrl } from "../services/public-url";
import * as doDb from "../session/do-db.js";
import type { Env } from "../types";
import type { SlackStatusBlocksInput } from "./blocks";

export function buildAuthoritativeStatusInput(
  sql: SqlStorage,
  env: Env,
  sessionId: string,
  opts: {
    stage: SlackStatusBlocksInput["stage"];
    summaryText?: string;
    statusOnly?: boolean;
    errorCode?: ErrorCode | null;
    branchName?: string;
    narrationLine?: string;
    /** Pending interaction-request ids for the Resume/Retry card buttons. */
    resumeRequestId?: string;
    retryRequestId?: string;
    // Pre-fetched session row to reuse when the caller already read it, avoiding
    // a second getSessionExtended on hot paths (e.g. phase updates).
    ext?: ReturnType<typeof doDb.getSessionExtended>;
  },
): SlackStatusBlocksInput {
  const ext = opts.ext ?? doDb.getSessionExtended(sql, sessionId);
  const repoOwner = ext?.repoOwner ?? undefined;
  const repoName = ext?.repoName ?? undefined;
  return {
    stage: opts.stage,
    sessionId,
    frontendUrl: resolvePublicAppBaseUrl(env),
    repoFullName: repoOwner && repoName ? `${repoOwner}/${repoName}` : undefined,
    summaryText: opts.summaryText,
    prUrl: ext?.prUrl ?? undefined,
    prNumber: ext?.prNumber ?? undefined,
    branchName: opts.branchName,
    errorCode: opts.errorCode ?? null,
    statusOnly: opts.statusOnly,
    narrationLine: opts.narrationLine,
    // Legacy status source (getSessionExtended), deliberately NOT the FSM
    // project() — Slack surfaces stay legacy-fed until the cutover completes
    // (docs/fsm.md § current-live-scope).
    verificationState: ext?.verificationState ?? null,
    verificationResult: ext?.verificationResult ?? null,
    resumeRequestId: opts.resumeRequestId,
    retryRequestId: opts.retryRequestId,
  };
}
