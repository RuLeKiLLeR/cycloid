import { type BridgeLogger } from "../logger.js";
import { btMetadata, type BtSpan, fullOutputAttachment, getBtLogger, sanitizeToolIO } from "../services/braintrust.js";

interface ToolSpanEntry {
  bt: { log(data: Record<string, unknown>): void; end(): void };
}

/**
 * Ports the tracker needs from the bridge. Everything except `activeToolSpans`
 * (which this tracker solely owns) is read live from the bridge / PromptLoopState
 * through these getters so the tracker never mirrors bridge state.
 */
export interface ToolPartTrackerContext {
  /** Active Braintrust prompt span to parent tool spans under (null when none). */
  getActiveBtPromptSpan: () => BtSpan | null;
  getSessionId: () => string;
  getSandboxId: () => string;
  getPromptId: () => string | undefined;
  getAgentSessionId: () => string | undefined;
  log: BridgeLogger;
}

/**
 * Owns the Braintrust child spans opened for in-flight tool calls
 * (`activeToolSpans`). This is the ONLY tool-part state held outside
 * `PromptLoopState`; the seen/emitted/status/start-time sets all live on
 * `PromptLoopState` and are read there, not mirrored here.
 */
export class ToolPartTracker {
  private readonly activeToolSpans = new Map<string, ToolSpanEntry>();

  constructor(private readonly ctx: ToolPartTrackerContext) {}

  /** Number of currently-open spans (used for leak detection at teardown). */
  get activeSpanCount(): number {
    return this.activeToolSpans.size;
  }

  /**
   * Start a Braintrust child span for a tool call. A span-start failure must
   * never abort the prompt stream: it is logged with `btSpanDegraded: true`
   * (so the missing span is observable) and the tool call proceeds spanless.
   */
  startSpan(callId: string, tool: string, args: Record<string, unknown>): void {
    try {
      // Start BT tool span as child of the active prompt span (if available)
      const btParent = this.ctx.getActiveBtPromptSpan();
      const btSpanSource = btParent || getBtLogger();
      const btSpan = btSpanSource.startSpan({
        name: `tool:${tool}`,
        type: "tool",
        event: {
          input: sanitizeToolIO(args),
          metadata: {
            ...btMetadata({
              sessionId: this.ctx.getSessionId(),
              promptId: this.ctx.getPromptId(),
              sandboxId: this.ctx.getSandboxId(),
            }),
            agentSessionId: this.ctx.getAgentSessionId(),
            tool,
            callId,
          },
        },
      });

      this.activeToolSpans.set(callId, { bt: btSpan });
    } catch (err) {
      this.ctx.log.warn(
        { event: "bt.tool_span_start_failed", tool, callId, btSpanDegraded: true, error: String(err) },
        "bt.tool_span_start_failed",
      );
    }
  }

  /**
   * End the Braintrust child span for a completed tool call.
   *
   * `output` is the complete tool result. It is logged as the span `output` (symmetric with the
   * `input` recorded in {@link startSpan}), so evals can score what the tool actually returned —
   * previously the span recorded only `status` ("completed"/"error"), which made tool output
   * invisible in Braintrust. A large result keeps a redacted, bounded preview inline on `output`
   * and attaches the COMPLETE redacted output as a Braintrust `Attachment` under
   * `metadata.fullOutput` so the whole result stays analyzable without inflating per-span cost (see
   * {@link fullOutputAttachment}). The attachment is nested under `metadata` — a recognized span
   * field — because Braintrust silently drops unknown top-level keys. `status` is preserved in
   * metadata so nothing regresses for consumers keying on it. When no output is available (aborted /
   * permission-denied), the status string is used as the output, as before.
   */
  endSpan(callId: string, status: string, durationMs?: number, outputEstTokens?: number, output?: unknown): void {
    const spans = this.activeToolSpans.get(callId);
    if (!spans) return;
    this.activeToolSpans.delete(callId);

    const fullOutput = output !== undefined ? fullOutputAttachment(output) : null;
    spans.bt.log({
      output: output !== undefined ? sanitizeToolIO(output) : status,
      metadata: { status, ...(fullOutput ? { fullOutput } : {}) },
      metrics: {
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(outputEstTokens !== undefined ? { outputEstimatedTokens: outputEstTokens } : {}),
      },
    });
    spans.bt.end();
  }

  /**
   * Force-end every still-open span (tool started but prompt aborted before
   * completion). Returns the number of spans that were still open so callers
   * can record a leak signal.
   */
  forceEndAll(status = "aborted"): number {
    const leaked = this.activeToolSpans.size;
    for (const [callId] of this.activeToolSpans) {
      this.endSpan(callId, status);
    }
    return leaked;
  }
}
