import type { SessionDetail, SessionMetadata } from "../types";

export function buildInitialSession(
  sessions: SessionMetadata[],
  sessionId: string | undefined,
): SessionDetail | undefined {
  if (!sessionId) return undefined;
  const meta = sessions.find((s) => s.sessionId === sessionId);
  if (!meta) return undefined;
  return {
    ...meta,
    queueLength: 0,
    repoUrl: null,
    publishStatus: "not_started",
    outcome: null,
    lastBranch: null,
    baseBranch: null,
  };
}
