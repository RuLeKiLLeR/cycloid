import {
  DISPATCH_SUBSPAN_EVENT,
  DISPATCH_SUBSPAN_NAMES,
  DISPATCH_SUBSPANS_COMPLETED_EVENT,
  type DispatchSubspanName,
  type DispatchSubspanSnapshot,
} from "../../../../shared/observability/dispatch-latency.js";
import type { BridgeLogger } from "../logger.js";
import type { PromptLatencyTags } from "../types.js";

type RecordedSubspan = {
  recordedAt: number;
  offsetMs: number;
  logged: boolean;
  durationMs?: number;
  signal?: string;
  firstEventType?: string;
};

export type DispatchLatencyTrackerOptions = {
  promptId: string;
  promptLog: BridgeLogger;
  now?: () => number;
};

type PromptSendOutcome = "not_started" | "in_flight" | "sent" | "failed";

type PendingBackendFirstToken = {
  recordedAt: number;
  signal: string;
};

/**
 * Per-prompt waterfall instrumentation for bucket B (dispatch → first visible
 * event). Milestones before the dispatch anchor get negative offset_ms.
 */
export class DispatchLatencyTracker {
  private readonly promptId: string;
  private readonly promptLog: BridgeLogger;
  private readonly now: () => number;
  private anchorAt: number | null = null;
  private latencyTags: PromptLatencyTags | undefined;
  private readonly spans = new Map<DispatchSubspanName, RecordedSubspan>();
  private promptSentStartedAt: number | null = null;
  private promptSendOutcome: PromptSendOutcome = "not_started";
  private pendingBackendFirstToken: PendingBackendFirstToken | null = null;
  private summaryEmitted = false;

  constructor(opts: DispatchLatencyTrackerOptions) {
    this.promptId = opts.promptId;
    this.promptLog = opts.promptLog;
    this.now = opts.now ?? (() => Date.now());
  }

  setLatencyTags(tags: PromptLatencyTags): void {
    this.latencyTags = tags;
  }

  /** Record the bucket-A/B boundary; offsets are measured from this timestamp. */
  setAnchor(anchorAt: number): void {
    this.anchorAt = anchorAt;
    for (const [span, recorded] of this.spans) {
      recorded.offsetMs = recorded.recordedAt - anchorAt;
      this.tryEmitSubspanLog(span, recorded);
    }
    // If the terminal milestone was recorded before the anchor was set, emitSummary
    // exited early. Retry now that offsets are finalized.
    if (this.promptSendOutcome === "failed" || this.spans.has("bridge_first_visible_event")) {
      this.emitSummary();
    }
  }

  recordRuntimeClientReady(): void {
    this.recordMilestone("runtime_client_ready");
  }

  recordSessionCreated(): void {
    this.recordMilestone("session_created");
  }

  /** Call when sendPrompt begins (before the backend ack). */
  markPromptSendStarted(): void {
    if (this.promptSentStartedAt === null) {
      this.promptSentStartedAt = this.now();
    }
    if (this.promptSendOutcome === "not_started") {
      this.promptSendOutcome = "in_flight";
    }
  }

  recordPromptSentToBackend(): void {
    const durationMs =
      this.promptSentStartedAt !== null ? Math.max(0, this.now() - this.promptSentStartedAt) : undefined;
    this.promptSendOutcome = "sent";
    this.recordMilestone("prompt_sent_to_backend", { durationMs });
    this.flushPendingBackendFirstToken();
    this.emitSummary();
  }

  recordPromptSendFailed(): void {
    if (this.promptSendOutcome !== "sent") {
      this.promptSendOutcome = "failed";
    }
    this.pendingBackendFirstToken = null;
    this.emitSummary();
  }

  recordBackendFirstToken(signal: string): void {
    if (this.spans.has("backend_first_token")) return;

    const recordedAt = this.now();
    if (this.promptSendOutcome === "in_flight") {
      this.pendingBackendFirstToken = {
        recordedAt,
        signal,
      };
      return;
    }
    this.recordMilestoneAt("backend_first_token", recordedAt, { signal });
  }

  recordBridgeFirstVisibleEventQueued(firstEventType: string): void {
    this.recordMilestone("bridge_first_visible_event_queued", { firstEventType });
  }

  recordBridgeFirstVisibleEventBuffered(firstEventType: string): void {
    this.recordMilestone("bridge_first_visible_event_buffered", { firstEventType });
  }

  recordBridgeFirstVisibleEvent(firstEventType: string): void {
    this.recordMilestone("bridge_first_visible_event", { firstEventType });
    this.emitSummary();
  }

  private recordMilestone(
    span: DispatchSubspanName,
    extra: { durationMs?: number; signal?: string; firstEventType?: string } = {},
  ): void {
    this.recordMilestoneAt(span, this.now(), extra);
  }

  private recordMilestoneAt(
    span: DispatchSubspanName,
    recordedAt: number,
    extra: { durationMs?: number; signal?: string; firstEventType?: string } = {},
  ): void {
    if (this.spans.has(span)) return;

    const recorded: RecordedSubspan = {
      recordedAt,
      offsetMs: this.anchorAt !== null ? recordedAt - this.anchorAt : 0,
      logged: false,
      ...(extra.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
      ...(extra.signal !== undefined ? { signal: extra.signal } : {}),
      ...(extra.firstEventType !== undefined ? { firstEventType: extra.firstEventType } : {}),
    };
    this.spans.set(span, recorded);
    this.tryEmitSubspanLog(span, recorded);
  }

  private flushPendingBackendFirstToken(): void {
    if (this.pendingBackendFirstToken === null || this.spans.has("backend_first_token")) {
      this.pendingBackendFirstToken = null;
      return;
    }
    const { recordedAt, signal } = this.pendingBackendFirstToken;
    this.pendingBackendFirstToken = null;
    this.recordMilestoneAt("backend_first_token", recordedAt, { signal });
  }

  private tryEmitSubspanLog(span: DispatchSubspanName, recorded: RecordedSubspan): void {
    if (recorded.logged || this.anchorAt === null) return;
    recorded.logged = true;

    this.promptLog.info(
      {
        event: DISPATCH_SUBSPAN_EVENT,
        prompt_id: this.promptId,
        span,
        offset_ms: recorded.offsetMs,
        ...(recorded.durationMs !== undefined ? { duration_ms: recorded.durationMs } : {}),
        ...(recorded.signal !== undefined ? { signal: recorded.signal } : {}),
        ...(recorded.firstEventType !== undefined ? { first_event_type: recorded.firstEventType } : {}),
        ...(this.latencyTags ?? {}),
      },
      "Prompt dispatch subspan recorded",
    );
  }

  private emitSummary(): void {
    if (this.summaryEmitted || this.anchorAt === null) return;
    if (this.promptSendOutcome === "in_flight") return;
    if (!this.spans.has("bridge_first_visible_event") && this.promptSendOutcome !== "failed") return;
    this.summaryEmitted = true;

    const firstVisible = this.spans.get("bridge_first_visible_event");
    const dispatchToFirstVisibleMs = firstVisible !== undefined ? Math.max(0, firstVisible.offsetMs) : 0;
    const backendFirstToken = this.spans.get("backend_first_token");
    const bridgeDelayMs =
      firstVisible !== undefined && backendFirstToken !== undefined
        ? Math.max(0, firstVisible.offsetMs - backendFirstToken.offsetMs)
        : null;

    const spans: Partial<Record<DispatchSubspanName, DispatchSubspanSnapshot>> = {};
    for (const name of DISPATCH_SUBSPAN_NAMES) {
      const recorded = this.spans.get(name);
      if (recorded) {
        spans[name] = {
          offset_ms: recorded.offsetMs,
          ...(recorded.durationMs !== undefined ? { duration_ms: recorded.durationMs } : {}),
          ...(recorded.signal !== undefined ? { signal: recorded.signal } : {}),
          ...(recorded.firstEventType !== undefined ? { first_event_type: recorded.firstEventType } : {}),
        };
      } else {
        spans[name] = { offset_ms: 0, skipped: true };
      }
    }

    this.promptLog.info(
      {
        event: DISPATCH_SUBSPANS_COMPLETED_EVENT,
        prompt_id: this.promptId,
        dispatch_to_first_visible_event_ms: dispatchToFirstVisibleMs,
        ...(bridgeDelayMs !== null ? { bridge_delay_ms: bridgeDelayMs } : {}),
        spans,
        ...(this.latencyTags ?? {}),
      },
      "Prompt dispatch subspan waterfall completed",
    );
  }

  /** Test helper: snapshot of recorded spans without logging. */
  snapshotForTests(): {
    anchorAt: number | null;
    spans: ReadonlyMap<DispatchSubspanName, RecordedSubspan>;
    promptSendOutcome: PromptSendOutcome;
    pendingBackendFirstToken: PendingBackendFirstToken | null;
    summaryEmitted: boolean;
  } {
    return {
      anchorAt: this.anchorAt,
      spans: new Map(this.spans),
      promptSendOutcome: this.promptSendOutcome,
      pendingBackendFirstToken: this.pendingBackendFirstToken,
      summaryEmitted: this.summaryEmitted,
    };
  }
}
