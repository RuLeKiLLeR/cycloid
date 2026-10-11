import type { DeferredPrTemplateFillPayload } from "../../../../shared/events/bridge.js";
import type { PublishStage } from "../../../../shared/types/publish.js";
import type { ExecutionVerification, PrReadinessEvidence } from "../../../../shared/types/sandbox.js";
import type { Logger } from "../logger";
import { isReviewLoopReplyVerdict } from "../services/review-loop-operations";
import type { UserSettingsCache } from "../settings/db";
import type { Env, ReplayState, SessionEvent } from "../types";
import { asNonEmptyString, jsonErrorResponse, jsonResponse, parseJsonBody } from "../utils";
import type { ServerMessage } from "../ws/types.js";
import * as doDb from "./do-db.js";
import type { DurableEntry } from "./events";
import { emitWebhookPrTerminal } from "./fsm/cron-producer.js";
import type {
  ArchiveClosePrResponse,
  ClosePrRequest,
  ClosePrResponse,
  NotifySessionPrClosedRequest,
  NotifySessionPrMergedRequest,
  ReadPrRequest,
  ReadPrResponse,
  RecordAgentTicketKeyRequest,
  ReviewLoopReplyRequest,
  UpdatePrTitleRequest,
} from "./internal-routes";
import { PrBodyAssembler } from "./pr-body-assembler.js";
import { GithubPrOperations } from "./pr-github-ops.js";
import { PrWorkflowNotifications } from "./pr-notifications.js";
import type { ApplyProposedPrTitleResult } from "./pr-title-reconciler.js";
import {
  type ResumePublishOutcome,
  type ResumePublishTrigger,
  SessionPublishService,
  type TerminalizePublishOnCloseOutcome,
} from "./publish-service.js";
import { captureAgentCreatedTicketKey, type CaptureAgentTicketKeyResult } from "./ticket-key-capture.js";
import type { VerificationStateForPrInput } from "./verification-state.js";

/**
 * Phase 1B helper for PR workflow ownership.
 *
 * Ownership boundary:
 * - `/session/notify-pr-merged`
 * - post-execution PR create/update branching invoked from the prompt queue helper
 * - PR-specific Slack notifications
 * - PR title/body/link composition helpers
 *
 * Keep on `SessionDO`:
 * - fetch routing and lifecycle entrypoints
 * - generic prompt completion notifications (`notifySlackThread`)
 * - event translation / replay ownership in `session/events.ts`
 *
 * Invariants:
 * - never create a PR when the head branch matches the base branch
 * - only create/update PRs after the queue layer records push success
 * - `pr_created`, `pr_failed`, and `pr_updated` keep the current broadcast-before-persist ordering
 * - session transcript links are appended to Cycloid-authored PR bodies
 */
interface SessionPrWorkflowHost {
  readonly state: DurableObjectState;
  readonly env: Env;
  readonly log: Logger;
  waitUntil(promise: Promise<unknown>): void;
  broadcast(message: ServerMessage): void;
  appendAndMirrorEvents(
    sessionId: string,
    entries: DurableEntry[],
    promptId?: string,
  ): Promise<{ replay: ReplayState; events: SessionEvent[] }>;
  fetchInternal(request: Request): Promise<Response>;
  upsertPrWebhookRef(prUrl: string, sessionId: string): Promise<void>;
  enterReviewListening(input: { sessionId: string; prUrl: string; currentHeadSha: string }): Promise<void>;
  setVerificationStateForPr?(input: VerificationStateForPrInput): Promise<void>;
  exitReviewListening(input: {
    sessionId: string;
    reason: "merged" | "closed" | "archived" | "user_stop" | "draft_republish";
  }): Promise<void>;
  rescheduleSessionAlarm(): Promise<void>;
  withPublishUserSettingsCache?<T>(operation: (settingsCache: UserSettingsCache) => Promise<T>): Promise<T>;
  // Forwarded to the publish service so newly-created PRs reflect the per-user
  // "open PRs as drafts by default" setting.
  getDefaultPrDraft(ownerUserId: string, settingsCache?: UserSettingsCache): Promise<boolean>;
}

export interface SessionPrWorkflow {
  handleNotifyPrMergedRequest(request: Request): Promise<Response>;
  handleNotifyPrClosedRequest(request: Request): Promise<Response>;
  handleReviewLoopReplyRequest(request: Request): Promise<Response>;
  handleUpdatePrTitleRequest(request: Request): Promise<Response>;
  handleClosePrRequest(request: Request): Promise<Response>;
  handleArchiveClosePrRequest(): Promise<Response>;
  handleReadPrRequest(request: Request): Promise<Response>;
  handleRecordAgentTicketKeyRequest(request: Request): Promise<Response>;
  triggerPrCreation(
    sessionId: string,
    branch: string,
    diffSummary?: string,
    prTitle?: string,
    prBody?: string,
    verification?: ExecutionVerification,
    prReadiness?: PrReadinessEvidence,
    promptId?: string,
    commitSha?: string,
    settingsCache?: UserSettingsCache,
    prTemplateFill?: DeferredPrTemplateFillPayload,
  ): Promise<void>;
  triggerPrUpdate(
    sessionId: string,
    branch: string,
    diffSummary?: string,
    prTitle?: string,
    prBody?: string,
    verification?: ExecutionVerification,
    prReadiness?: PrReadinessEvidence,
    promptId?: string,
    commitSha?: string,
    settingsCache?: UserSettingsCache,
    prTemplateFill?: DeferredPrTemplateFillPayload,
  ): Promise<void>;
  // ARC-876 watchdog hooks. Exposed so the SessionDO alarm handler can force
  // a terminal `publish.failed` without reaching past the workflow layer.
  failPublishOnTimeout(opts: {
    sessionId: string;
    phase: "post_execution" | "publishing";
    stage: PublishStage;
    elapsedMs: number;
    promptId?: string;
  }): Promise<void>;
  failPublishOnPushOutcome(opts: {
    sessionId: string;
    cause: "push_failed" | "push_status_unknown";
    pushError?: string | null;
    promptId?: string;
  }): Promise<void>;
  // ARC-876 resume hooks. `resumeStuckPublish` re-drives a publish stalled in
  // `publishing` (bridge reconnect / publishing watchdog / alarm wake);
  // `terminalizeDanglingPublishOnClose` cleans up a row left `publishing` at close.
  resumeStuckPublish(opts: { sessionId: string; trigger: ResumePublishTrigger }): Promise<ResumePublishOutcome>;
  terminalizeDanglingPublishOnClose(sessionId: string, closeReason: string): Promise<TerminalizePublishOnCloseOutcome>;
}

function requestedPublishMode(verification: ExecutionVerification | null | undefined): "normal" | "skip_publish" {
  const publishMode = verification?.publishMode as string | undefined;
  if (publishMode === "skip_publish") return "skip_publish";
  return "normal";
}

/**
 * Map an `applyProposedPrTitle` outcome to an HTTP status. The bridge tool keys
 * its agent-visible errorCode off the JSON `outcome`, so these statuses only
 * need to be coarsely accurate: 2xx for applied/no-op, 4xx for caller error,
 * 5xx for an upstream GitHub failure.
 */
function updatePrTitleStatus(result: ApplyProposedPrTitleResult): number {
  if (result.ok) return 200;
  switch (result.outcome) {
    case "invalid":
      return 400;
    case "skipped_manual_rename":
      return 409;
    case "error":
      return 502;
  }
}

/** Map a `captureAgentCreatedTicketKey` outcome to an HTTP status. */
function recordAgentTicketKeyStatus(result: CaptureAgentTicketKeyResult): number {
  if (result.ok) return 200;
  switch (result.outcome) {
    case "invalid":
      return 400;
    case "session_not_found":
      return 404;
  }
}

type ParsedClosePrPayload =
  { ok: true; prUrl: string | null } | { ok: false; response: ClosePrResponse; status: number };

function parseClosePrPayload(payload: unknown): ParsedClosePrPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      ok: false,
      status: 400,
      response: { ok: false, outcome: "invalid", error: "Expected close_pr payload to be {} or { prUrl: string }." },
    };
  }

  const keys = Object.keys(payload);
  if (keys.length === 0) return { ok: true, prUrl: null };
  if (keys.length === 1 && Object.prototype.hasOwnProperty.call(payload, "prUrl")) {
    const prUrl = (payload as Record<string, unknown>).prUrl;
    if (typeof prUrl === "string" && prUrl.trim().length > 0) return { ok: true, prUrl: prUrl.trim() };
  }

  return {
    ok: false,
    status: 400,
    response: { ok: false, outcome: "invalid", error: "Expected close_pr payload to be {} or { prUrl: string }." },
  };
}

function closePrErrorStatus(reason: "invalid" | "no_pr" | "forbidden" | "error"): number {
  switch (reason) {
    case "invalid":
      return 400;
    case "forbidden":
      return 403;
    case "no_pr":
      return 404;
    case "error":
      return 503;
  }
}

type ParsedReadPrPayload = { ok: true; prUrl: string | null } | { ok: false; response: ReadPrResponse; status: number };

function parseReadPrPayload(payload: unknown): ParsedReadPrPayload {
  const invalid: ParsedReadPrPayload = {
    ok: false,
    status: 400,
    response: { ok: false, outcome: "invalid", error: "Expected read_pr payload to be {} or { prUrl: string }." },
  };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return invalid;

  const keys = Object.keys(payload);
  if (keys.length === 0) return { ok: true, prUrl: null };
  if (keys.length === 1 && Object.prototype.hasOwnProperty.call(payload, "prUrl")) {
    const prUrl = (payload as Record<string, unknown>).prUrl;
    if (typeof prUrl === "string" && prUrl.trim().length > 0) return { ok: true, prUrl: prUrl.trim() };
  }
  return invalid;
}

class SessionPrWorkflowImpl implements SessionPrWorkflow {
  private readonly github: GithubPrOperations;
  private readonly notifications: PrWorkflowNotifications;
  private readonly bodyAssembler: PrBodyAssembler;
  private readonly publishService: SessionPublishService;

  constructor(private readonly host: SessionPrWorkflowHost) {
    this.github = new GithubPrOperations(this.sql, host.env, host.log);
    this.notifications = new PrWorkflowNotifications(this.sql, host);
    this.bodyAssembler = new PrBodyAssembler(this.sql, host);
    this.publishService = new SessionPublishService(host, {
      bodyAssembler: this.bodyAssembler,
      notifications: this.notifications,
      github: this.github,
    });
  }

  async handleReviewLoopReplyRequest(request: Request): Promise<Response> {
    const sessionId = this.resolveSessionId();
    if (!sessionId) return jsonErrorResponse("Session not found", 404);

    const payload = ((await parseJsonBody(request)) || {}) as Partial<ReviewLoopReplyRequest>;
    const promptId = asNonEmptyString(payload.promptId) ?? doDb.getActiveProcessingPromptId(this.sql, sessionId);
    const epochId = asNonEmptyString(payload.epochId);
    const targetSourceId = asNonEmptyString(payload.targetSourceId);
    const verdict = isReviewLoopReplyVerdict(payload.verdict) ? payload.verdict : null;
    const body = asNonEmptyString(payload.body);
    if (!promptId || !epochId || !targetSourceId || !verdict || !body) {
      return jsonErrorResponse("Invalid review-loop reply payload", 400);
    }
    if (body.length > 4096) {
      return jsonErrorResponse("Review-loop reply body exceeds 4096 characters", 400);
    }

    const result = await this.publishService.replyToReviewBotComment({
      sessionId,
      promptId,
      epochId,
      targetSourceId,
      verdict,
      body,
    });
    return jsonResponse(result, result.ok ? 200 : result.retryable ? 503 : 409);
  }

  async handleUpdatePrTitleRequest(request: Request): Promise<Response> {
    const sessionId = this.resolveSessionId();
    if (!sessionId) return jsonErrorResponse("Session not found", 404);

    const payload = ((await parseJsonBody(request)) || {}) as Partial<UpdatePrTitleRequest>;
    const result = await this.publishService.applyProposedPrTitle(sessionId, payload.title);
    return jsonResponse(result, updatePrTitleStatus(result));
  }

  async handleClosePrRequest(request: Request): Promise<Response> {
    const sessionId = this.resolveSessionId();
    if (!sessionId) return jsonErrorResponse("Session not found", 404);

    const payload = parseClosePrPayload((await parseJsonBody(request)) as Partial<ClosePrRequest> | null);
    if (!payload.ok) return jsonResponse(payload.response, payload.status);

    const target = await this.github.resolvePrTargetContext(sessionId, payload.prUrl);
    if (!target.ok) {
      return jsonResponse(
        { ok: false, outcome: target.reason, error: target.message } satisfies ClosePrResponse,
        closePrErrorStatus(target.reason),
      );
    }

    const { context } = target;
    try {
      await this.github.closePr(context);
      this.host.log.info(
        { event: "agent_pr_closed", sessionId, prUrl: context.prUrl, prNumber: context.prNumber },
        "Agent closed the attached pull request",
      );
      if (context.ext?.prUrl === context.prUrl) {
        try {
          await this.host.exitReviewListening({ sessionId, reason: "closed" });
        } catch (error) {
          this.host.log.warn(
            { event: "agent_pr_close_exit_review_listening_failed", sessionId, error: String(error) },
            "Agent PR close request could not exit review listening",
          );
        }
      }
      return jsonResponse({
        ok: true,
        outcome: "closed",
        prUrl: context.prUrl,
        prNumber: context.prNumber,
      } satisfies ClosePrResponse);
    } catch (error) {
      this.host.log.warn(
        { event: "agent_pr_close_failed", sessionId, error: String(error) },
        "Agent PR close request failed",
      );
      return jsonResponse({ ok: false, outcome: "error", error: `GitHub PR close failed: ${String(error)}` }, 502);
    }
  }

  async handleArchiveClosePrRequest(): Promise<Response> {
    const sessionId = this.resolveSessionId();
    if (!sessionId) return jsonErrorResponse("Session not found", 404);

    const target = await this.github.resolvePrTargetContext(sessionId, null);
    if (!target.ok) {
      const warning = target.reason === "error" ? target.message : undefined;
      this.host.log.info(
        {
          event: "user_archive_pr_close_skipped",
          action: "archive_close_pr",
          sessionId,
          outcome: target.reason,
        },
        "Archive PR close skipped",
      );
      return jsonResponse({
        ok: true,
        prClose: warning ? { attempted: false, closed: false, warning } : { attempted: false, closed: false },
      } satisfies ArchiveClosePrResponse);
    }

    const { context } = target;
    let state: "open" | "closed" | "merged" | null;
    try {
      state = await this.github.getPrState(context);
    } catch (error) {
      const warning = `Could not check PR state before archive: ${String(error)}`;
      this.host.log.warn(
        {
          event: "user_archive_pr_state_failed",
          action: "archive_close_pr",
          sessionId,
          prNumber: context.prNumber,
          requestId: null,
          error: String(error),
        },
        "Archive PR close state check failed",
      );
      return jsonResponse({
        ok: true,
        prClose: { attempted: true, closed: false, warning },
      } satisfies ArchiveClosePrResponse);
    }

    if (state !== "open") {
      this.host.log.info(
        {
          event: "user_archive_pr_close_skipped",
          action: "archive_close_pr",
          sessionId,
          prNumber: context.prNumber,
          prState: state,
        },
        "Archive PR close skipped for non-open PR",
      );
      return jsonResponse({
        ok: true,
        prClose: { attempted: false, closed: false },
      } satisfies ArchiveClosePrResponse);
    }

    try {
      this.host.log.info(
        {
          event: "user_archive_pr_close_attempt",
          action: "archive_close_pr",
          sessionId,
          prNumber: context.prNumber,
        },
        "Archive PR close attempt started",
      );
      await this.github.closePr(context);
      try {
        await emitWebhookPrTerminal(
          this.host.env,
          sessionId,
          "closed",
          this.host.log,
          this.host.waitUntil.bind(this.host),
        );
      } catch (error) {
        this.host.log.warn(
          {
            event: "user_archive_pr_close_webhook_emit_failed",
            action: "archive_close_pr",
            sessionId,
            prNumber: context.prNumber,
            error: String(error),
          },
          "Archive PR close request could not emit terminal webhook",
        );
      }
      if (context.ext?.prUrl === context.prUrl) {
        try {
          await this.host.exitReviewListening({ sessionId, reason: "closed" });
        } catch (error) {
          this.host.log.warn(
            {
              event: "user_archive_pr_close_exit_review_listening_failed",
              action: "archive_close_pr",
              sessionId,
              prNumber: context.prNumber,
              error: String(error),
            },
            "Archive PR close request could not exit review listening",
          );
        }
      }
      this.host.log.info(
        {
          event: "user_archive_pr_closed",
          action: "archive_close_pr",
          sessionId,
          prNumber: context.prNumber,
        },
        "Archive closed the attached pull request",
      );
      return jsonResponse({
        ok: true,
        prClose: { attempted: true, closed: true },
      } satisfies ArchiveClosePrResponse);
    } catch (error) {
      const warning = `Could not close PR before archive: ${String(error)}`;
      this.host.log.warn(
        {
          event: "user_archive_pr_close_failed",
          action: "archive_close_pr",
          sessionId,
          prNumber: context.prNumber,
          error: String(error),
        },
        "Archive PR close request failed",
      );
      return jsonResponse({
        ok: true,
        prClose: { attempted: true, closed: false, warning },
      } satisfies ArchiveClosePrResponse);
    }
  }

  async handleReadPrRequest(request: Request): Promise<Response> {
    const sessionId = this.resolveSessionId();
    if (!sessionId) return jsonErrorResponse("Session not found", 404);

    const payload = parseReadPrPayload((await parseJsonBody(request)) as Partial<ReadPrRequest> | null);
    if (!payload.ok) return jsonResponse(payload.response, payload.status);

    const target = await this.github.resolvePrTargetContext(sessionId, payload.prUrl);
    if (!target.ok) {
      return jsonResponse(
        { ok: false, outcome: target.reason, error: target.message } satisfies ReadPrResponse,
        closePrErrorStatus(target.reason),
      );
    }

    try {
      const contents = await this.github.readPrContents(target.context);
      return jsonResponse({ ok: true, ...contents } satisfies ReadPrResponse);
    } catch (error) {
      this.host.log.warn(
        { event: "agent_pr_read_failed", sessionId, error: String(error) },
        "Agent PR read request failed",
      );
      return jsonResponse(
        { ok: false, outcome: "error", error: `GitHub PR read failed: ${String(error)}` } satisfies ReadPrResponse,
        502,
      );
    }
  }

  async handleRecordAgentTicketKeyRequest(request: Request): Promise<Response> {
    const sessionId = this.resolveSessionId();
    if (!sessionId) return jsonErrorResponse("Session not found", 404);

    const payload = ((await parseJsonBody(request)) || {}) as Partial<RecordAgentTicketKeyRequest>;
    const result = captureAgentCreatedTicketKey(this.sql, this.host.log, sessionId, payload.ticketKey);
    return jsonResponse(result, recordAgentTicketKeyStatus(result));
  }

  async handleNotifyPrMergedRequest(request: Request): Promise<Response> {
    const sessionId = this.resolveSessionId();
    if (!sessionId) return jsonErrorResponse("Session not found", 404);

    const session = doDb.getSession(this.sql, sessionId);
    if (!session) return jsonErrorResponse("Session not found", 404);

    const payload = (await parseJsonBody(request)) as Partial<NotifySessionPrMergedRequest> | null;
    const ext = doDb.getSessionExtended(this.sql, sessionId);
    const prUrl = (payload?.prUrl as string) || ext?.prUrl;
    if (!prUrl) {
      return jsonResponse({ ok: true, notified: false, reason: "no pr_url" });
    }

    const notified = await this.notifications.notifySlackPrMerged(session.sessionId, prUrl);
    return jsonResponse({ ok: true, notified });
  }

  async handleNotifyPrClosedRequest(request: Request): Promise<Response> {
    const sessionId = this.resolveSessionId();
    if (!sessionId) return jsonErrorResponse("Session not found", 404);

    const session = doDb.getSession(this.sql, sessionId);
    if (!session) return jsonErrorResponse("Session not found", 404);

    const payload = (await parseJsonBody(request)) as Partial<NotifySessionPrClosedRequest> | null;
    const ext = doDb.getSessionExtended(this.sql, sessionId);
    const prUrl = (payload?.prUrl as string) || ext?.prUrl;
    if (!prUrl) {
      return jsonResponse({ ok: true, notified: false, reason: "no pr_url" });
    }

    const notified = await this.notifications.notifySlackPrClosed(
      session.sessionId,
      prUrl,
      payload?.closedByLogin ?? null,
    );
    return jsonResponse({ ok: true, notified });
  }

  async triggerPrCreation(
    sessionId: string,
    branch: string,
    diffSummary?: string,
    prTitle?: string,
    prBody?: string,
    verification?: ExecutionVerification,
    prReadiness?: PrReadinessEvidence,
    promptId?: string,
    commitSha?: string,
    settingsCache?: UserSettingsCache,
    prTemplateFill?: DeferredPrTemplateFillPayload,
  ): Promise<void> {
    await this.publishService.publishSessionResult(
      {
        sessionId,
        branch,
        diffSummary,
        prTitle,
        prBody,
        verification,
        prReadiness,
        prTemplateFill,
        promptId,
        commitSha,
        requestedMode: requestedPublishMode(verification),
      },
      settingsCache,
    );
  }

  async triggerPrUpdate(
    sessionId: string,
    branch: string,
    diffSummary?: string,
    prTitle?: string,
    prBody?: string,
    verification?: ExecutionVerification,
    prReadiness?: PrReadinessEvidence,
    promptId?: string,
    commitSha?: string,
    settingsCache?: UserSettingsCache,
    prTemplateFill?: DeferredPrTemplateFillPayload,
  ): Promise<void> {
    await this.publishService.publishSessionResult(
      {
        sessionId,
        branch,
        diffSummary,
        prTitle,
        prBody,
        verification,
        prReadiness,
        prTemplateFill,
        promptId,
        commitSha,
        requestedMode: requestedPublishMode(verification),
      },
      settingsCache,
    );
  }

  async failPublishOnTimeout(opts: {
    sessionId: string;
    phase: "post_execution" | "publishing";
    stage: PublishStage;
    elapsedMs: number;
    promptId?: string;
  }): Promise<void> {
    await this.publishService.failPublishOnTimeout(opts);
  }

  async failPublishOnPushOutcome(opts: {
    sessionId: string;
    cause: "push_failed" | "push_status_unknown";
    pushError?: string | null;
    promptId?: string;
  }): Promise<void> {
    await this.publishService.failPublishOnPushOutcome(opts);
  }

  async resumeStuckPublish(opts: { sessionId: string; trigger: ResumePublishTrigger }): Promise<ResumePublishOutcome> {
    return this.publishService.resumeStuckPublish(opts);
  }

  async terminalizeDanglingPublishOnClose(
    sessionId: string,
    closeReason: string,
  ): Promise<TerminalizePublishOnCloseOutcome> {
    return this.publishService.terminalizeDanglingPublishOnClose(sessionId, closeReason);
  }

  private get sql(): SqlStorage {
    return this.host.state.storage.sql;
  }

  private resolveSessionId(): string | null {
    const rows = this.sql.exec("SELECT session_id FROM session LIMIT 1").toArray();
    return rows.length > 0 ? (rows[0].session_id as string) : null;
  }
}

export function createSessionPrWorkflow(host: SessionPrWorkflowHost): SessionPrWorkflow {
  return new SessionPrWorkflowImpl(host);
}
