export type SessionDebugBottleneckPhase =
  "queue" | "spawn" | "workspace_setup" | "context_prep" | "model_wait" | "unknown";

export type SessionDebugPromptSummary = {
  promptId: string;
  status: string;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  outcome: string | null;
  errorCode: string | null;
  errorDetails: SessionDebugErrorDetails | null;
  firstTokenAt: string | null;
  firstToolCallAt: string | null;
  timings: {
    queueMs: number | null;
    spawnMs: number | null;
    workspaceSetupMs: number | null;
    contextPrepMs: number | null;
    modelWaitMs: number | null;
    firstTokenMs: number | null;
    totalMs: number | null;
  };
  toolSummary: {
    totalCalls: number;
    failedCalls: number;
    byTool: Record<string, number>;
  };
  traces: {
    ddTraceId: string | null;
    btSpanId: string | null;
    btSpanMissingReason: string | null;
  };
  diagnosis: {
    bottleneckPhase: SessionDebugBottleneckPhase;
    bottleneckDurationMs: number | null;
    notes: string[];
  };
};

export type SessionDebugErrorDetails = {
  message?: string;
  name?: string;
  code?: string;
  errno?: string;
  syscall?: string;
  hostname?: string;
  address?: string;
  port?: number;
  providerID?: string;
  statusCode?: number;
  isRetryable?: boolean;
  cause?: SessionDebugErrorDetails;
  redacted: boolean;
};

export type SessionDebugSummaryResponse = {
  ok: true;
  session: {
    sessionId: string;
    status: string;
    businessId: string | null;
    ownerUserId: string;
    repoUrl: string | null;
    model: string | null;
    createdAt: string;
    updatedAt: string;
    spawnDurationMs: number | null;
    sandboxStatus: string | null;
    publish: {
      status: string | null;
      stage: string | null;
      error: string | null;
    };
    pullRequest: {
      url: string | null;
      state: "draft" | "ready_for_review" | null;
      manualReviewReason: string | null;
    };
    verification: {
      verdict: string | null;
      verified: boolean | null;
      status: string | null;
      publishMode: string | null;
      details: {
        explanation: string | null;
        manualReviewReason: string | null;
        caveats: string[];
      };
    };
    taskOutcome: {
      outcome: string | null;
      badSessionReason: string | null;
    };
    runtimeProvenance: {
      provider: string | null;
      sandboxId: string | null;
      templateId: string | null;
      bootMode: string | null;
      sandboxImageVersion: string | null;
    };
  };
  prompts: SessionDebugPromptSummary[];
};
