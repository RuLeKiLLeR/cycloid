import type { AgentRole } from "../../../../shared/agent/schema.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import type { InitiationMode } from "../enums/initiation-mode.js";
import type { SessionEntrypoint } from "../enums/session-entrypoint.js";
import { createLogger } from "../logger";
import type { ParentSessionContext } from "../session/db";
import { publishSessionUpsertedFromDb } from "../session/feed-delta";
import { upsertSessionPrMetadata } from "../session/pr-metadata-db";
import { assertDatabase, createSessionState, type RepoContext, type SessionKind } from "../session/state";
import type { CallbackContext, Env, InternalAuthContext, ReplayState, SessionState } from "../types";
import { SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR, upsertSessionWebhookRef } from "../webhooks/db";
import type { AdoptedPrMetadata } from "./session-continuation";
import { syncSessionProjection } from "./session-projection";

const log = createLogger({ bindings: { component: "session-create" } });

export type { SessionKind };

export type SessionCreateStage = "initialize" | "persist";

export class SessionCreateError extends Error {
  readonly stage: SessionCreateStage;
  readonly cause: unknown;
  constructor(stage: SessionCreateStage, cause: unknown) {
    super(`session-create ${stage} failed: ${stringifyError(cause)}`);
    this.name = "SessionCreateError";
    this.stage = stage;
    this.cause = cause;
  }
}

export interface WebhookRefInput {
  source: string;
  externalRef: unknown;
}

export interface PersistInitialSessionProjectionInput {
  session: SessionState;
  replay: ReplayState;
  sessionKind: SessionKind;
  projectionSource: string;
  projectionUserId?: string | null;
  parentContext?: ParentSessionContext | null;
  requestId?: string | null;
  webhookRef?: WebhookRefInput;
  adoptedPrMetadata?: AdoptedPrMetadata | null;
}

/**
 * Writes the session_index and replay-metadata projections (and an optional
 * webhook-ref row) for a freshly initialized session. Mirrors the
 * `routes.sessions.create` persist step so the scheduler can reuse identical
 * persistence semantics.
 */
export async function persistInitialSessionProjection(
  env: Env,
  input: PersistInitialSessionProjectionInput,
): Promise<void> {
  const db = assertDatabase(env);
  const writes: Array<Promise<unknown>> = [
    syncSessionProjection({
      db,
      sessionId: input.session.sessionId,
      session: { ...input.session, sessionKind: input.sessionKind },
      replay: input.replay,
      richStatus: "idle",
      logger: log,
      source: input.projectionSource,
      parentContext: input.parentContext ?? null,
      requestId: input.requestId ?? null,
      userId: input.projectionUserId ?? null,
    }),
  ];
  if (input.webhookRef) {
    writes.push(
      upsertSessionWebhookRef(db, input.webhookRef.source, input.webhookRef.externalRef, input.session.sessionId),
    );
  }
  if (input.adoptedPrMetadata) {
    writes.push(
      upsertSessionPrMetadata(db, {
        sessionId: input.session.sessionId,
        prUrl: input.adoptedPrMetadata.prUrl,
        prNumber: input.adoptedPrMetadata.prNumber,
        prDraft: input.adoptedPrMetadata.prDraft,
        publishedBranch: input.adoptedPrMetadata.publishedBranch,
      }),
      upsertSessionWebhookRef(
        db,
        SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR,
        input.adoptedPrMetadata.prUrl,
        input.session.sessionId,
      ),
    );
  }
  await Promise.all(writes);

  // Publish the new row to the per-business sidebar feed so it appears live in
  // other tabs / for teammates / automation-created sessions, without a manual
  // refresh. After the durable projection write; never throws (ARC-1322).
  await publishSessionUpsertedFromDb(env, db, input.session.sessionId, input.projectionSource);
}

export interface InitializeAndProjectSessionInput {
  sessionId: string;
  ownerUserId: string;
  sessionKind: SessionKind;
  repoContext?: RepoContext;
  agentOverrides?: Record<string, Record<string, unknown>>;
  callbackContext?: CallbackContext;
  requestId?: string | null;
  auth: InternalAuthContext;
  installationId?: number;
  model: string;
  reasoningEffort: string | null;
  projectionSource: string;
  projectionUserId?: string | null;
  parentContext?: ParentSessionContext | null;
  webhookRef?: WebhookRefInput;
  targetPrUrl?: string | null;
  prUrl?: string | null;
  prNumber?: number | null;
  adoptedPrMetadata?: AdoptedPrMetadata | null;
  initiationMode?: InitiationMode;
  entrypoint: SessionEntrypoint;
  agentRole?: AgentRole;
  agentProfile?: string;
  autoVerify?: boolean;
  adoptedExternalPr?: boolean;
  scheduledRuleId?: string | null;
  ruleNameSnapshot?: string | null;
  cronSnapshot?: string | null;
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface InitializeAndProjectSessionResult {
  session: SessionState;
  replay: ReplayState;
}

/**
 * Initialize a session in its Durable Object and persist the initial D1
 * projection in one call. Throws `SessionCreateError` tagged with the failed
 * stage so callers can map to their own error responses.
 *
 * Used by the scheduler. The interactive `POST /api/sessions` route calls
 * `createSessionState` and `persistInitialSessionProjection` directly so it can
 * run the cross-owner 409 check between the two steps.
 */
export async function initializeAndProjectSession(
  env: Env,
  input: InitializeAndProjectSessionInput,
): Promise<InitializeAndProjectSessionResult> {
  let session: SessionState;
  let replay: ReplayState;
  try {
    const created = await createSessionState(env, input.sessionId, input.ownerUserId, {
      sessionKind: input.sessionKind,
      repoContext: input.repoContext,
      agentOverrides: input.agentOverrides,
      callbackContext: input.callbackContext,
      requestId: input.requestId ?? undefined,
      auth: input.auth,
      installationId: input.installationId,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      targetPrUrl: input.targetPrUrl ?? null,
      prUrl: input.prUrl ?? null,
      prNumber: input.prNumber ?? null,
      initiationMode: input.initiationMode,
      entrypoint: input.entrypoint,
      agentRole: input.agentRole,
      agentProfile: input.agentProfile,
      autoVerify: input.autoVerify,
      adoptedExternalPr: input.adoptedExternalPr,
      scheduledRuleId: input.scheduledRuleId,
      ruleNameSnapshot: input.ruleNameSnapshot,
      cronSnapshot: input.cronSnapshot,
      waitUntil: input.waitUntil,
    });
    session = created.session;
    replay = created.replay;
  } catch (error) {
    throw new SessionCreateError("initialize", error);
  }

  try {
    await persistInitialSessionProjection(env, {
      session,
      replay,
      sessionKind: input.sessionKind,
      projectionSource: input.projectionSource,
      projectionUserId: input.projectionUserId,
      parentContext: input.parentContext ?? null,
      requestId: input.requestId,
      webhookRef: input.webhookRef,
      adoptedPrMetadata: input.adoptedPrMetadata,
    });
  } catch (error) {
    throw new SessionCreateError("persist", error);
  }

  return { session, replay };
}
