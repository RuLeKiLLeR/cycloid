import { MODEL_CONTEXT_WINDOWS } from "../../../../shared/constants/models.js";
import { CONTEXT_FILL_WARN_THRESHOLD, MODEL_PRICING } from "../constants/bridge.js";
import { computeCost } from "./classify.js";

type TokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

type TokenSnapshot = {
  input: number;
  output: number;
};

type MessageTokenInfo = {
  id?: string;
  role?: string;
  sessionID?: string;
  modelID?: string;
  tokens?: {
    input?: number;
    output?: number;
    cache?: {
      read?: number;
      write?: number;
    };
  };
};

type ParentTokenUpdate = {
  kind: "parent";
  currentModel?: string;
  unknownModel: boolean;
  contextUsed: number;
  fillPercent?: number;
  emitContextFillWarning: boolean;
  usageEvent: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalCostUsd: number;
    model?: string;
    contextWindow?: number;
    contextTokens: number;
    peakContextTokens: number;
    contextCacheRead: number;
    contextCacheWrite: number;
    contextUncachedInput: number;
    cumulativeCacheRead: number;
    cumulativeCacheWrite: number;
    instructionFilesEst: number;
  };
  delta: TokenUsage;
};

type TokenUpdate = ParentTokenUpdate;

function emptyTokenUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export class TokenBudgetTracker {
  private messageTokenHighWater = new Map<string, TokenUsage>();
  private totalUsage: TokenUsage = emptyTokenUsage();
  private currentModel: string | undefined;
  private peakContextTokens = 0;

  snapshot(): TokenSnapshot {
    return {
      input: this.totalUsage.input,
      output: this.totalUsage.output,
    };
  }

  getTotals(): TokenUsage {
    return { ...this.totalUsage };
  }

  getCurrentModel(): string | undefined {
    return this.currentModel;
  }

  recordMessageUpdate(
    info: MessageTokenInfo,
    options: {
      parentSessionId: string | null;
      contextFillWarningEmitted: boolean;
    },
  ): TokenUpdate | null {
    const isParentSession = info.sessionID === options.parentSessionId;
    if (!isParentSession || info.role !== "assistant" || !info.id || !info.tokens) {
      return null;
    }

    const msgId = info.id;
    const rawInputTokens = info.tokens.input ?? 0;
    const rawCacheReadTokens = info.tokens.cache?.read ?? 0;
    const rawCacheWriteTokens = info.tokens.cache?.write ?? 0;
    const nextUsage: TokenUsage = {
      // Codex reports cached input as a subset of input tokens.
      // Normalize only cache reads here so downstream usage and cost tracking
      // do not double-count cached tokens.
      input: Math.max(0, rawInputTokens - rawCacheReadTokens),
      output: info.tokens.output ?? 0,
      cacheRead: rawCacheReadTokens,
      cacheWrite: rawCacheWriteTokens,
    };
    const prevUsage = this.messageTokenHighWater.get(msgId) ?? emptyTokenUsage();
    const delta: TokenUsage = {
      input: Math.max(0, nextUsage.input - prevUsage.input),
      output: Math.max(0, nextUsage.output - prevUsage.output),
      cacheRead: Math.max(0, nextUsage.cacheRead - prevUsage.cacheRead),
      cacheWrite: Math.max(0, nextUsage.cacheWrite - prevUsage.cacheWrite),
    };
    if (delta.input === 0 && delta.output === 0 && delta.cacheRead === 0 && delta.cacheWrite === 0) {
      return null;
    }

    this.messageTokenHighWater.set(msgId, nextUsage);
    this.totalUsage.input += delta.input;
    this.totalUsage.output += delta.output;
    this.totalUsage.cacheRead += delta.cacheRead;
    this.totalUsage.cacheWrite += delta.cacheWrite;

    if (isParentSession) {
      if (info.modelID) this.currentModel = info.modelID;
      const contextUsed = nextUsage.input + nextUsage.cacheRead + nextUsage.cacheWrite;
      if (contextUsed > this.peakContextTokens) {
        this.peakContextTokens = contextUsed;
      }
      const totalCostUsd = computeCost(
        this.totalUsage.input,
        this.totalUsage.output,
        this.totalUsage.cacheRead,
        this.totalUsage.cacheWrite,
        this.currentModel,
        { peakContextTokens: this.peakContextTokens },
      );
      const contextWindow = this.currentModel ? MODEL_CONTEXT_WINDOWS[this.currentModel] : undefined;
      const fillPercent = contextWindow && contextUsed > 0 ? contextUsed / contextWindow : undefined;

      return {
        kind: "parent",
        currentModel: this.currentModel,
        unknownModel: !!this.currentModel && !MODEL_PRICING[this.currentModel],
        contextUsed,
        fillPercent,
        emitContextFillWarning:
          !!fillPercent && fillPercent >= CONTEXT_FILL_WARN_THRESHOLD && !options.contextFillWarningEmitted,
        usageEvent: {
          inputTokens: this.totalUsage.input,
          outputTokens: this.totalUsage.output,
          cacheReadTokens: this.totalUsage.cacheRead,
          cacheWriteTokens: this.totalUsage.cacheWrite,
          totalCostUsd,
          model: this.currentModel,
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          contextTokens: contextUsed,
          peakContextTokens: this.peakContextTokens,
          contextCacheRead: nextUsage.cacheRead,
          contextCacheWrite: nextUsage.cacheWrite,
          contextUncachedInput: nextUsage.input,
          cumulativeCacheRead: this.totalUsage.cacheRead,
          cumulativeCacheWrite: this.totalUsage.cacheWrite,
          instructionFilesEst: 0,
        },
        delta,
      };
    }

    return null;
  }
}
