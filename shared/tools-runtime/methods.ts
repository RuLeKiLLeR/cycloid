import type { z } from "zod";

export type ToolPlanMode = "readOnly" | "sideEffecting";

export type ToolExecutionEnv = Record<string, string | undefined>;

export type ToolExecutionContext = {
  env: ToolExecutionEnv;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
};

export type ToolMethod<TInput = unknown, TResult = unknown> = {
  description: string;
  inputSchema: z.ZodType<TInput>;
  inputJsonSchema?: Record<string, unknown>;
  planMode: ToolPlanMode;
  execute(args: TInput, ctx: ToolExecutionContext): Promise<TResult>;
  isAvailable?: (env: ToolExecutionEnv) => boolean;
  redactPersistedInput?: (args: TInput) => unknown;
};

export type ToolMethods = Record<string, ToolMethod>;

export type ToolModule = {
  methods: ToolMethods;
};
