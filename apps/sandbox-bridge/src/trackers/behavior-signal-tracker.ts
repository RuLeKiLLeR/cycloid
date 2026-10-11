import { isRelevantCheckCommand } from "../../../../shared/command-classification.js";
import type { ToolFailurePhase } from "../../../../shared/tool-failure.js";
import type { StructuralPromptInjectionHit } from "../../../../shared/utils/prompt-safety.js";
import { EDIT_TOOLS } from "../constants/bridge.js";
import type { PromptBehaviorSignals } from "../types.js";
import { parseBashCommand, type SearchCommandCounts } from "../utils/bash-parser.js";
import { normalizePathInput } from "../utils/path-list.js";
import { extractApplyPatchPaths, type ModifiedFileTracker } from "./modified-file-tracker.js";

/**
 * Owns prompt behavior signals and loop counters.
 */
export class BehaviorSignalTracker {
  toolCallCount = 0;

  handledAutomaticallyViolation = false;
  editCount = 0;
  lastContextFillPercent = 0;
  questionCount = 0;
  readonly toolCounts = new Map<string, number>();
  referencedExternalState = false;
  usedVerificationTools = false;
  ranFunctionalCheck = false;
  successfulEditCount = 0;
  malformedSearchCommandCount = 0;
  grepSearchCommandCount = 0;
  ripgrepSearchCommandCount = 0;
  structuralInjectionCommentHitCount = 0;
  structuralInjectionZeroWidthHitCount = 0;
  readonly toolFailureCountsByPhase: Record<ToolFailurePhase, number> = {
    auth: 0,
    provider: 0,
    policy: 0,
    wrapper: 0,
    command: 0,
  };

  constructor(private readonly modifiedFileTracker: ModifiedFileTracker) {}

  recordToolCall(tool: string): void {
    const toolLower = tool.toLowerCase();
    this.toolCounts.set(toolLower, (this.toolCounts.get(toolLower) ?? 0) + 1);
  }

  recordBehavioralSignals(tool: string, input: Record<string, unknown>, countTool = true): void {
    const toolLower = tool.toLowerCase();
    if (countTool) this.recordToolCall(tool);
    if (EDIT_TOOLS.has(toolLower)) {
      this.editCount++;
      if (toolLower === "apply_patch" && typeof input?.patch === "string") {
        for (const filePath of extractApplyPatchPaths(input.patch)) {
          this.modifiedFileTracker.recordModifiedFile(filePath);
        }
      } else {
        const filePaths = normalizePathInput(input?.file_path ?? input?.filePath ?? input?.path);
        this.modifiedFileTracker.recordModifiedFiles(filePaths);
      }
    }
  }

  recordSuccessfulEdit(tool: string): void {
    if (EDIT_TOOLS.has(tool.toLowerCase())) {
      this.successfulEditCount++;
    }
  }

  recordCommandExecution(input: {
    command: string;
    status: "completed" | "error";
    hasOutput: boolean;
    output?: string;
  }): void {
    this.recordSearchCommandCounts(parseBashCommand(input.command).searchCommandCounts);
    if (isRelevantCheckCommand(input.command)) {
      this.ranFunctionalCheck = true;
    }
  }

  checkExternalStateReferences(text: string): void {
    if (!this.referencedExternalState) {
      if (/#\d{1,6}\b/.test(text) || /github\.com\/[^\s]+\/(pull|issues)\/\d+/.test(text)) {
        this.referencedExternalState = true;
      }
    }
  }

  recordHandledAutomaticallyViolation(): void {
    this.handledAutomaticallyViolation = true;
  }

  recordMalformedSearchCommandViolation(count = 1): void {
    this.malformedSearchCommandCount += count;
  }

  recordSearchCommandCounts(counts: SearchCommandCounts): void {
    this.grepSearchCommandCount += counts.grep;
    this.ripgrepSearchCommandCount += counts.ripgrep;
  }

  recordStructuralPromptInjectionHits(hits: StructuralPromptInjectionHit[]): void {
    for (const hit of hits) {
      if (hit.kind === "html_comment") this.structuralInjectionCommentHitCount++;
      if (hit.kind === "zero_width") this.structuralInjectionZeroWidthHitCount++;
    }
  }

  recordToolFailure(phase: ToolFailurePhase): void {
    this.toolFailureCountsByPhase[phase]++;
  }

  toBehaviorSignals(): PromptBehaviorSignals {
    return {
      toolCallCount: this.toolCallCount,
      handledAutomaticallyViolation: this.handledAutomaticallyViolation,
      contextFillPercent: this.lastContextFillPercent,
      editCount: this.editCount,
      questionCount: this.questionCount,
      referencedExternalState: this.referencedExternalState,
      usedVerificationTools: this.usedVerificationTools,
      ranFunctionalCheck: this.ranFunctionalCheck,
      malformedSearchCommandCount: this.malformedSearchCommandCount,
      grepSearchCommandCount: this.grepSearchCommandCount,
      ripgrepSearchCommandCount: this.ripgrepSearchCommandCount,
      structuralInjectionCommentHitCount: this.structuralInjectionCommentHitCount,
      structuralInjectionZeroWidthHitCount: this.structuralInjectionZeroWidthHitCount,
      toolFailureCountsByPhase: { ...this.toolFailureCountsByPhase },
    };
  }
}
