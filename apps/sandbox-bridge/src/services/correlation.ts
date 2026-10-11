import { AsyncLocalStorage } from "node:async_hooks";

import {
  type Correlation,
  CORRELATION_ENV_VAR,
  parseCorrelation,
  serializeCorrelation,
  type SerializedCorrelation,
} from "../../../../shared/correlation.js";

const correlationStorage = new AsyncLocalStorage<Correlation>();

export function currentCorrelation(): Correlation | undefined {
  return correlationStorage.getStore();
}

export function runWithCorrelation<T>(correlation: Correlation | undefined, fn: () => T): T {
  return correlation ? correlationStorage.run(correlation, fn) : fn();
}

export function parseEnvCorrelation(env: NodeJS.ProcessEnv = process.env): Correlation | undefined {
  const raw = env[CORRELATION_ENV_VAR];
  return raw ? (parseCorrelation(raw) ?? undefined) : undefined;
}

export function parseSerializedCorrelation(value: SerializedCorrelation | undefined): Correlation | undefined {
  return value ? (parseCorrelation(value) ?? undefined) : undefined;
}

export function toCorrelationHeader(correlation: Correlation): string {
  return JSON.stringify(serializeCorrelation(correlation));
}
