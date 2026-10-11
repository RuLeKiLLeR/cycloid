import type { PhaseTransitionCause } from "../observability/phase-metrics";

export interface SessionStatusProjection {
  persistCurrentRichStatus(sessionId: string, cause: PhaseTransitionCause, drift?: unknown): Promise<string>;
  persistAndBroadcastSessionStatus(sessionId: string, cause: PhaseTransitionCause): Promise<string>;
}

interface SessionStatusProjectionHost {
  runPersistCurrentRichStatus(sessionId: string, cause: PhaseTransitionCause, drift?: unknown): Promise<string>;
  runPersistAndBroadcastSessionStatus(sessionId: string, cause: PhaseTransitionCause): Promise<string>;
}

export function createSessionStatusProjection(host: SessionStatusProjectionHost): SessionStatusProjection {
  return {
    persistCurrentRichStatus: (sessionId, cause, drift) => host.runPersistCurrentRichStatus(sessionId, cause, drift),
    persistAndBroadcastSessionStatus: (sessionId, cause) => host.runPersistAndBroadcastSessionStatus(sessionId, cause),
  };
}
