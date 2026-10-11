import type { z } from "zod";

import { isRecord } from "./type-guards.js";

export type ConfigLogger = Pick<Console, "warn">;

export type ConfigIssue = { path: readonly PropertyKey[]; message: string };

export type ConfigEnv = Record<string, string | undefined>;

export function loadJsonEnvConfig<T>(params: {
  envName: string;
  schema: z.ZodType<T>;
  defaultValue: T;
  env: ConfigEnv;
  logger?: ConfigLogger;
  logPrefix: string;
}): T {
  const { envName, schema, defaultValue, env, logPrefix } = params;
  const logger = params.logger ?? console;
  const raw = env[envName]?.trim();
  if (!raw) return defaultValue;

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    warnConfigFallback(logger, logPrefix, envName, [
      {
        path: [],
        message: error instanceof Error ? error.message : "Invalid JSON",
      },
    ]);
    return defaultValue;
  }

  const candidate = mergePlainObjects(defaultValue, parsedJson);
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    warnConfigFallback(
      logger,
      logPrefix,
      envName,
      parsed.error.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
      })),
    );
    return defaultValue;
  }

  return parsed.data;
}

function warnConfigFallback(logger: ConfigLogger, logPrefix: string, source: string, issues: ConfigIssue[]): void {
  logger.warn(`${logPrefix} invalid config; using defaults`, {
    source,
    issues: issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  });
}

// Skip prototype-pollution keys; JSON.parse produces them as own enumerable
// properties, and assignment would invoke the __proto__ setter on {...base}.
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function mergePlainObjects(base: unknown, override: unknown): unknown {
  if (!isRecord(base) || !isRecord(override)) return override;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (UNSAFE_KEYS.has(key)) continue;
    merged[key] = key in merged ? mergePlainObjects(merged[key], value) : value;
  }
  return merged;
}
