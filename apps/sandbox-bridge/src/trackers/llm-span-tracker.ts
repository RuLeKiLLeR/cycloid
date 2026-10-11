import { type BridgeLogger } from "../logger.js";
import { btMetadata, type BtSpan, getBtLogger, sanitizeText } from "../services/braintrust.js";

/** Per-call output text capture cap; sanitizeText truncates on write anyway. */
const LLM_CALL_TEXT_CAP = 20_000;

interface LlmCallEntry {
  bt: { log(data: Record<string, unknown>): void; end(): void };
  model?: string;
  startedAt: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  stopReason?: string;
  text: string;
  reasoning: string;
}

/**
 * Ports the tracker needs from the bridge. Mirrors ToolPartTrackerContext so
 * the two trackers share one context object at the construction site.
 */
export interface LlmSpanTrackerContext {
  /** Active Braintrust prompt span to parent llm spans under (null when none). */
  getActiveBtPromptSpan: () => BtSpan | null;
  getSessionId: () => string;
  getSandboxId: () => string;
  getPromptId: () => string | undefined;
  log: BridgeLogger;
}

export interface CompletedLlmCall {
  callId: string;
  model?: string;
  /** Unix ms. When absent, the span records a zero-length call at `now`. */
  startedAt?: number;
  endedAt?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  outputText?: string;
  reasoningText?: string;
}

/**
 * Owns the Braintrust `llm`-typed child spans — one per model call inside a
 * turn. Two entry styles, matching what each backend exposes:
 *
 * - Streaming (Claude Agent SDK): the stream-json protocol brackets each
 *   Anthropic call with `message_start`…`message_stop`, so the tracker opens
 *   the span at start, accumulates text/thinking deltas, and closes it on
 *   stop with per-call usage from `message_start`/`message_delta`.
 * - Retrospective (opencode/Codex): the SDK only reveals a completed
 *   assistant message (tokens/cost/time on `message.updated`), so the span is
 *   opened, logged, and closed in one shot after the fact.
 *
 * NOTE: the llm span's `input` (the exact request messages) is NOT available
 * on either path — the CLIs own the request side. The turn-level root span
 * carries the user prompt; these spans carry per-call output, model, usage,
 * and latency. Failures never abort the prompt stream (same contract as
 * ToolPartTracker): degraded spans are logged and skipped.
 */
export class LlmSpanTracker {
  private readonly activeCalls = new Map<string, LlmCallEntry>();
  /**
   * Call ids already recorded retrospectively. opencode `message.updated` can
   * re-fire for the same completed message; the span must record exactly once.
   */
  private readonly recordedCallIds = new Set<string>();
  /**
   * Per-call aggregates for backends whose usage arrives as repeated
   * incremental deltas with no completion signal (Codex `message.updated`).
   * Flushed into one span per call at turn teardown (forceEndAll).
   */
  private readonly pendingRetroCalls = new Map<string, CompletedLlmCall>();

  constructor(private readonly ctx: LlmSpanTrackerContext) {}

  /** Number of currently-open llm spans (leak detection at turn teardown). */
  get activeCallCount(): number {
    return this.activeCalls.size;
  }

  startCall(
    callId: string,
    opts: {
      now: number;
      model?: string;
      inputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    },
  ): void {
    if (this.activeCalls.has(callId)) return;
    try {
      const parent = this.ctx.getActiveBtPromptSpan();
      const source = parent || getBtLogger();
      const span = source.startSpan({
        name: opts.model ? `llm:${opts.model}` : "llm:call",
        type: "llm",
        event: {
          metadata: {
            ...btMetadata({
              sessionId: this.ctx.getSessionId(),
              promptId: this.ctx.getPromptId(),
              sandboxId: this.ctx.getSandboxId(),
              model: opts.model,
            }),
            callId,
          },
        },
      });
      this.activeCalls.set(callId, {
        bt: span,
        model: opts.model,
        startedAt: opts.now,
        inputTokens: opts.inputTokens,
        cacheReadTokens: opts.cacheReadTokens,
        cacheWriteTokens: opts.cacheWriteTokens,
        text: "",
        reasoning: "",
      });
    } catch (err) {
      this.ctx.log.warn(
        { event: "bt.llm_span_start_failed", callId, btSpanDegraded: true, error: String(err) },
        "bt.llm_span_start_failed",
      );
    }
  }

  appendText(callId: string, delta: string): void {
    const entry = this.activeCalls.get(callId);
    if (!entry || entry.text.length >= LLM_CALL_TEXT_CAP) return;
    entry.text += delta.slice(0, LLM_CALL_TEXT_CAP - entry.text.length);
  }

  appendReasoning(callId: string, delta: string): void {
    const entry = this.activeCalls.get(callId);
    if (!entry || entry.reasoning.length >= LLM_CALL_TEXT_CAP) return;
    entry.reasoning += delta.slice(0, LLM_CALL_TEXT_CAP - entry.reasoning.length);
  }

  /** Record streamed usage/stop-reason ahead of endCall (Claude message_delta). */
  noteUsage(callId: string, opts: { outputTokens?: number; stopReason?: string }): void {
    const entry = this.activeCalls.get(callId);
    if (!entry) return;
    if (opts.outputTokens !== undefined) entry.outputTokens = opts.outputTokens;
    if (opts.stopReason !== undefined) entry.stopReason = opts.stopReason;
  }

  endCall(callId: string, now: number): void {
    const entry = this.activeCalls.get(callId);
    if (!entry) return;
    this.activeCalls.delete(callId);
    try {
      entry.bt.log(this.buildCloseEvent(entry, now));
      entry.bt.end();
    } catch (err) {
      this.ctx.log.warn(
        { event: "bt.llm_span_end_failed", callId, btSpanDegraded: true, error: String(err) },
        "bt.llm_span_end_failed",
      );
    }
  }

  /**
   * Merge one incremental per-call delta into the pending aggregate for a
   * call (Codex: a message can update its token counts repeatedly and never
   * signals completion). The aggregated span is recorded once, at turn
   * teardown, by {@link forceEndAll}. `outputText` is replaced, not
   * concatenated — callers pass the latest full text for the message.
   */
  accumulateCall(
    callId: string,
    delta: {
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      costUsd?: number;
      outputText?: string;
    },
  ): void {
    const pending = this.pendingRetroCalls.get(callId) ?? { callId };
    pending.model = delta.model ?? pending.model;
    pending.inputTokens = (pending.inputTokens ?? 0) + (delta.inputTokens ?? 0);
    pending.outputTokens = (pending.outputTokens ?? 0) + (delta.outputTokens ?? 0);
    pending.cacheReadTokens = (pending.cacheReadTokens ?? 0) + (delta.cacheReadTokens ?? 0);
    pending.cacheWriteTokens = (pending.cacheWriteTokens ?? 0) + (delta.cacheWriteTokens ?? 0);
    pending.costUsd = (pending.costUsd ?? 0) + (delta.costUsd ?? 0);
    if (delta.outputText !== undefined) pending.outputText = delta.outputText;
    this.pendingRetroCalls.set(callId, pending);
  }

  /**
   * One-shot span for backends that reveal a call only after completion
   * (opencode `message.updated` with tokens + `time.completed`). Open + log +
   * end. Returns true when the span was recorded, false when the call id was
   * already recorded (re-fired event) — callers use this to gate side effects
   * like cost accumulation so repeats never double-count.
   */
  recordCompletedCall(call: CompletedLlmCall, now: number): boolean {
    if (this.recordedCallIds.has(call.callId)) return false;
    this.recordedCallIds.add(call.callId);
    try {
      const parent = this.ctx.getActiveBtPromptSpan();
      const source = parent || getBtLogger();
      const startedAt = call.startedAt ?? call.endedAt ?? now;
      const endedAt = call.endedAt ?? now;
      const span = source.startSpan({
        name: call.model ? `llm:${call.model}` : "llm:call",
        type: "llm",
        event: {
          metadata: {
            ...btMetadata({
              sessionId: this.ctx.getSessionId(),
              promptId: this.ctx.getPromptId(),
              sandboxId: this.ctx.getSandboxId(),
              model: call.model,
            }),
            callId: call.callId,
            ...(call.costUsd !== undefined && call.costUsd > 0 ? { costUsd: call.costUsd } : {}),
          },
        },
      });
      span.log(
        this.buildCloseEvent(
          {
            bt: span,
            model: call.model,
            startedAt,
            inputTokens: call.inputTokens,
            cacheReadTokens: call.cacheReadTokens,
            cacheWriteTokens: call.cacheWriteTokens,
            outputTokens: call.outputTokens,
            text: call.outputText ?? "",
            reasoning: call.reasoningText ?? "",
          },
          endedAt,
        ),
      );
      span.end();
    } catch (err) {
      this.ctx.log.warn(
        { event: "bt.llm_span_record_failed", callId: call.callId, btSpanDegraded: true, error: String(err) },
        "bt.llm_span_record_failed",
      );
    }
    // A degraded span still counts as recorded: the call id is consumed and
    // caller-side effects (cost accumulation) must not repeat on a re-fire.
    return true;
  }

  /**
   * Turn teardown: first record the aggregated retro calls (Codex-style calls
   * have no completion signal, so end-of-turn IS their completion), then
   * force-end every still-open streaming call (stream aborted/errored
   * mid-call). Returns the number of leaked streaming calls only — flushed
   * retro aggregates are normal, not leaks.
   */
  forceEndAll(now: number): number {
    for (const pending of this.pendingRetroCalls.values()) {
      this.recordCompletedCall(pending, now);
    }
    this.pendingRetroCalls.clear();
    const leaked = this.activeCalls.size;
    for (const callId of [...this.activeCalls.keys()]) {
      this.endCall(callId, now);
    }
    return leaked;
  }

  private buildCloseEvent(entry: LlmCallEntry, now: number): Record<string, unknown> {
    const promptTokens = (entry.inputTokens ?? 0) + (entry.cacheReadTokens ?? 0) + (entry.cacheWriteTokens ?? 0);
    const completionTokens = entry.outputTokens ?? 0;
    return {
      output: {
        ...(entry.text ? { text: sanitizeText(entry.text) } : {}),
        ...(entry.reasoning ? { reasoning: sanitizeText(entry.reasoning) } : {}),
      },
      metadata: {
        ...(entry.model ? { model: entry.model } : {}),
        ...(entry.stopReason ? { stopReason: entry.stopReason } : {}),
        ...(entry.cacheReadTokens !== undefined ? { cacheReadTokens: entry.cacheReadTokens } : {}),
        ...(entry.cacheWriteTokens !== undefined ? { cacheWriteTokens: entry.cacheWriteTokens } : {}),
      },
      // Braintrust-conventional LLM metric names so the UI renders them natively.
      metrics: {
        ...(promptTokens > 0 ? { prompt_tokens: promptTokens } : {}),
        ...(completionTokens > 0 ? { completion_tokens: completionTokens } : {}),
        ...(promptTokens + completionTokens > 0 ? { tokens: promptTokens + completionTokens } : {}),
        durationMs: Math.max(0, now - entry.startedAt),
      },
    };
  }
}
