import type { ToolFailurePhase } from "../../../shared/tool-failure.js";
import type { StructuralPromptInjectionHit } from "../../../shared/utils/prompt-safety.js";
import type { OutputTokensObservation } from "./services/agent-observability.js";
import { BehaviorSignalTracker } from "./trackers/behavior-signal-tracker.js";
import { ModifiedFileTracker } from "./trackers/modified-file-tracker.js";
import { TextDeltaTracker } from "./trackers/text-delta-tracker.js";
import type { PromptBehaviorSignals } from "./types.js";

/**
 * A text/reasoning part buffered because its message role was unknown when it
 * arrived. `fullText` is the latest cumulative text seen for the part.
 */
export interface PendingUnknownRolePart {
  partId: string;
  fullText: string;
  kind: "text" | "reasoning";
}

/** A part flushed from the pending buffer, ready to emit as a delta. */
export interface FlushedDelta {
  partId: string;
  kind: "text" | "reasoning";
  delta: string;
  fullText: string;
}

/**
 * Composes per-prompt state trackers while preserving the historical facade
 * used by the bridge event loop.
 */
export class PromptLoopState {
  readonly text = new TextDeltaTracker();
  readonly files = new ModifiedFileTracker();
  readonly behavior = new BehaviorSignalTracker(this.files);

  // ── Part tracking ──
  readonly seenPartIds = new Set<string>();
  readonly emittedToolParts = new Set<string>();
  readonly emittedToolStatuses = new Map<string, string>();
  // ── Tool/batch tracking not owned by behavior scoring ──
  readonly deferredSafetyRejectedToolPartIds = new Set<string>();
  idle = false;

  // ── Warning flags ──
  contextFillWarningEmitted = false;

  // ── Pending-role buffering ──
  // Text/reasoning parts can arrive before the `message.updated` that reveals
  // their owning message's role. We buffer the LATEST full text for each such
  // part keyed by messageID, then replay it through the normal delta path once
  // recordMessageRole reveals an 'assistant' role (or discard it for 'user').
  // Without this, assistant output that streamed ahead of its message.updated
  // was lost from both the live stream and the persisted transcript.
  //
  // Outer key: messageID. Inner key: partId (so a part that ALSO later gets a
  // real message.part.updated is not double-emitted -- flushing clears it).
  readonly pendingUnknownRoleParts = new Map<string, Map<string, PendingUnknownRolePart>>();
  readonly suppressedMessageIds = new Set<string>();

  // Count of text/reasoning parts stashed because their owning message role
  // was not yet known when the part arrived. These are buffered for replay,
  // not permanently dropped. Surfaced by the bridge in the prompt-completion
  // log so a regression in part/message ordering is still visible.
  pendingUnknownRolePartCount = 0;

  // ── Compaction ──
  activeCompactionMessageId: string | null = null;
  preCompactionContextTokens: number | null = null;
  compactionCount = 0;
  compactionTokensReclaimed = 0;

  // ── Throughput observability ──
  latestOutputTokensObservation: OutputTokensObservation | null = null;
  outputTokensPerSecondSampleCount = 0;

  // ── Tool timing ──
  readonly toolStartTimes = new Map<string, number>();

  // ── Braintrust turn-level capture ──
  // Reasoning deltas accumulated for the Braintrust root span (the UI stream
  // consumes the same deltas separately and is unaffected). Capped so a long
  // turn cannot grow memory unboundedly; the Braintrust write truncates to
  // BT_MAX_TEXT_LENGTH anyway, so keeping the head is sufficient.
  private static readonly REASONING_CAPTURE_CAP = 50_000;
  private readonly reasoningByPartId = new Map<string, string>();
  private reasoningCapturedChars = 0;

  appendReasoningDelta(partId: string, delta: string): void {
    if (!delta || this.reasoningCapturedChars >= PromptLoopState.REASONING_CAPTURE_CAP) return;
    const kept = delta.slice(0, PromptLoopState.REASONING_CAPTURE_CAP - this.reasoningCapturedChars);
    this.reasoningByPartId.set(partId, (this.reasoningByPartId.get(partId) ?? "") + kept);
    this.reasoningCapturedChars += kept.length;
  }

  get reasoningText(): string {
    return [...this.reasoningByPartId.values()].join("\n\n").trim();
  }

  // Turn cost for the Braintrust root span. Each backend adds at the layer
  // that knows its cost semantics: Claude adds the terminal result's per-turn
  // total_cost_usd; Codex adds per-message deltas differenced from the token
  // budget's session-cumulative snapshots; opencode adds per-message cost
  // gated on the llm-span tracker's dedupe. Never add a cumulative snapshot
  // directly — that double-counts.
  totalCostUsd = 0;

  addUsageCost(costUsd: number | undefined): void {
    if (typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd > 0) this.totalCostUsd += costUsd;
  }

  get toolCallCount(): number {
    return this.behavior.toolCallCount;
  }
  set toolCallCount(value: number) {
    this.behavior.toolCallCount = value;
  }

  get textEmittedLengths(): Map<string, number> {
    return this.text.textEmittedLengths;
  }

  get textAliases(): Map<string, string> {
    return this.text.textAliases;
  }

  get responseTextByPartId(): Map<string, string> {
    return this.text.responseTextByPartId;
  }

  get messageRoles(): Map<string, "user" | "assistant"> {
    return this.text.messageRoles;
  }

  get textPartMessageIds(): Map<string, string> {
    return this.text.textPartMessageIds;
  }

  get textPartSegmentIds(): Map<string, number> {
    return this.text.textPartSegmentIds;
  }

  get modifiedFiles(): Set<string> {
    return this.files.modifiedFiles;
  }

  get handledAutomaticallyViolation(): boolean {
    return this.behavior.handledAutomaticallyViolation;
  }
  set handledAutomaticallyViolation(value: boolean) {
    this.behavior.handledAutomaticallyViolation = value;
  }

  get editCount(): number {
    return this.behavior.editCount;
  }
  set editCount(value: number) {
    this.behavior.editCount = value;
  }

  get lastContextFillPercent(): number {
    return this.behavior.lastContextFillPercent;
  }
  set lastContextFillPercent(value: number) {
    this.behavior.lastContextFillPercent = value;
  }

  get questionCount(): number {
    return this.behavior.questionCount;
  }
  set questionCount(value: number) {
    this.behavior.questionCount = value;
  }

  get toolCounts(): Map<string, number> {
    return this.behavior.toolCounts;
  }

  recordToolCall(tool: string): void {
    this.behavior.recordToolCall(tool);
  }

  get referencedExternalState(): boolean {
    return this.behavior.referencedExternalState;
  }
  set referencedExternalState(value: boolean) {
    this.behavior.referencedExternalState = value;
  }

  get usedVerificationTools(): boolean {
    return this.behavior.usedVerificationTools;
  }
  set usedVerificationTools(value: boolean) {
    this.behavior.usedVerificationTools = value;
  }

  get ranFunctionalCheck(): boolean {
    return this.behavior.ranFunctionalCheck;
  }
  set ranFunctionalCheck(value: boolean) {
    this.behavior.ranFunctionalCheck = value;
  }

  get successfulEditCount(): number {
    return this.behavior.successfulEditCount;
  }
  set successfulEditCount(value: number) {
    this.behavior.successfulEditCount = value;
  }

  get malformedSearchCommandCount(): number {
    return this.behavior.malformedSearchCommandCount;
  }
  set malformedSearchCommandCount(value: number) {
    this.behavior.malformedSearchCommandCount = value;
  }

  get grepSearchCommandCount(): number {
    return this.behavior.grepSearchCommandCount;
  }
  set grepSearchCommandCount(value: number) {
    this.behavior.grepSearchCommandCount = value;
  }

  get ripgrepSearchCommandCount(): number {
    return this.behavior.ripgrepSearchCommandCount;
  }
  set ripgrepSearchCommandCount(value: number) {
    this.behavior.ripgrepSearchCommandCount = value;
  }

  get toolFailureCountsByPhase(): Record<ToolFailurePhase, number> {
    return this.behavior.toolFailureCountsByPhase;
  }

  /**
   * Stash the latest full text for a part whose message role is not yet known,
   * keyed by (messageID, partId). Overwrites any prior stash for the same part
   * so only the latest cumulative text is replayed. Increments the pending
   * counter once per distinct part. Returns nothing -- the caller emits nothing
   * until the role arrives via flushPendingUnknownRoleParts.
   */
  stashPendingUnknownRolePart(messageID: string, part: PendingUnknownRolePart): void {
    let byPart = this.pendingUnknownRoleParts.get(messageID);
    if (!byPart) {
      byPart = new Map<string, PendingUnknownRolePart>();
      this.pendingUnknownRoleParts.set(messageID, byPart);
    }
    if (!byPart.has(part.partId)) {
      this.pendingUnknownRolePartCount++;
    }
    byPart.set(part.partId, part);
  }

  /**
   * Drain buffered parts for a message whose role just became known. For an
   * 'assistant' role, replay each part through the normal delta path
   * (updateTextDelta / updateTrackedDelta) and return the resulting non-empty
   * deltas for the caller to emit. For a 'user' role, discard silently. Clears
   * the buffer entry either way so a later real message.part.updated for the
   * same part is NOT double-emitted (the delta path already tracks emitted
   * length, so even an unflushed replay would no-op, but clearing is explicit).
   *
   * Decrements `pendingUnknownRolePartCount` by the drained parts (both the
   * replayed and the discarded paths drain them), so the counter reflects only
   * parts whose role NEVER became known. A non-zero count at prompt completion
   * therefore signals real lost output, not parts that were already replayed.
   */
  flushPendingUnknownRoleParts(messageID: string, role: "user" | "assistant"): FlushedDelta[] {
    const byPart = this.pendingUnknownRoleParts.get(messageID);
    if (!byPart) return [];
    this.pendingUnknownRoleParts.delete(messageID);
    this.pendingUnknownRolePartCount -= byPart.size;
    if (role === "user") return [];

    const flushed: FlushedDelta[] = [];
    for (const part of byPart.values()) {
      const delta =
        part.kind === "text"
          ? this.text.updateTextDelta(part.partId, part.fullText, messageID)
          : this.text.updateTrackedDelta(`reasoning-${part.partId}`, part.fullText);
      if (delta) {
        flushed.push({ partId: part.partId, kind: part.kind, delta, fullText: part.fullText });
      }
    }
    return flushed;
  }

  suppressMessage(messageID: string | null | undefined): void {
    if (!messageID) return;
    this.suppressedMessageIds.add(messageID);
    const byPart = this.pendingUnknownRoleParts.get(messageID);
    if (!byPart) return;
    this.pendingUnknownRoleParts.delete(messageID);
    this.pendingUnknownRolePartCount -= byPart.size;
  }

  isMessageSuppressed(messageID: string | null | undefined): boolean {
    return Boolean(messageID && this.suppressedMessageIds.has(messageID));
  }

  updateTextDelta(partId: string, fullText: string, messageId?: string | null): string | null {
    return this.text.updateTextDelta(partId, fullText, messageId);
  }

  startNewTextSegment(): void {
    this.text.startNewTextSegment();
  }

  latestResponseText(): string {
    return this.text.latestResponseText();
  }

  latestMessageResponseText(): string {
    return this.text.latestMessageResponseText();
  }

  updateTrackedDelta(key: string, fullText: string): string | null {
    return this.text.updateTrackedDelta(key, fullText);
  }

  recordMessageRole(messageID: string | null | undefined, role: "user" | "assistant"): void {
    this.text.recordMessageRole(messageID, role);
  }

  getMessageRole(messageID: string | null | undefined): "user" | "assistant" | undefined {
    return this.text.getMessageRole(messageID);
  }

  recordModifiedFile(filePath: string): void {
    this.files.recordModifiedFile(filePath);
  }

  recordBehavioralSignals(tool: string, input: Record<string, unknown>, countTool = true): void {
    this.behavior.recordBehavioralSignals(tool, input, countTool);
  }

  recordSuccessfulEdit(tool: string): void {
    this.behavior.recordSuccessfulEdit(tool);
  }

  recordCommandExecution(input: {
    command: string;
    status: "completed" | "error";
    hasOutput: boolean;
    output?: string;
  }): void {
    this.behavior.recordCommandExecution(input);
  }

  recordToolFailure(phase: ToolFailurePhase): void {
    this.behavior.recordToolFailure(phase);
  }

  checkExternalStateReferences(text: string): void {
    this.behavior.checkExternalStateReferences(text);
  }

  recordHandledAutomaticallyViolation(): void {
    this.behavior.recordHandledAutomaticallyViolation();
  }

  recordMalformedSearchCommandViolation(count = 1): void {
    this.behavior.recordMalformedSearchCommandViolation(count);
  }

  recordStructuralPromptInjectionHits(hits: StructuralPromptInjectionHit[]): void {
    this.behavior.recordStructuralPromptInjectionHits(hits);
  }

  toBehaviorSignals(): PromptBehaviorSignals {
    return this.behavior.toBehaviorSignals();
  }
}
