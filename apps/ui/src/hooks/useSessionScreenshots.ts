import { useMemo, useState } from "react";

import type { Phase } from "../../../../shared/session/phase.js";
import { fetchSessionArtifacts, type SessionArtifactRow, viewableScreenshotUrl } from "../api/artifacts";
import { useSyncEffect } from "./useEffects";

const POLL_INTERVAL_MS = 30_000;
const MAX_CACHED_SESSIONS = 50;
const artifactCacheBySessionId = new Map<string, SessionArtifactRow[]>();

// Phases where the bridge cannot push new artifacts. We still do the initial
// fetch (in case the user navigated to a finished session that produced
// screenshots), but skip the polling interval to avoid wasted traffic.
const QUIESCENT_PHASES = new Set<Phase>(["stopped", "archived"]);

export type AgentScreenshot = {
  artifactId: string;
  promptId: string | null;
  viewUrl: string;
  label: string;
  createdAt: number;
};

type ArtifactState = {
  sessionId: string;
  artifacts: SessionArtifactRow[];
};

function getCachedArtifactState(sessionId: string): ArtifactState {
  return {
    sessionId,
    artifacts: artifactCacheBySessionId.get(sessionId) ?? [],
  };
}

function cacheArtifacts(sessionId: string, rows: SessionArtifactRow[]) {
  artifactCacheBySessionId.delete(sessionId);
  artifactCacheBySessionId.set(sessionId, rows);
  while (artifactCacheBySessionId.size > MAX_CACHED_SESSIONS) {
    const oldestSessionId = artifactCacheBySessionId.keys().next().value;
    if (!oldestSessionId) break;
    artifactCacheBySessionId.delete(oldestSessionId);
  }
}

/**
 * Fetches the agent-uploaded screenshot artifacts for a session and groups them
 * by promptId so each `SessionTurn` can render the screenshots produced during
 * that prompt inline (similar to how user-uploaded images render via
 * `prompt.uploadedImages` from PR #2740).
 *
 * Uses the same polling cadence and quiescent-status guard as the older
 * right-rail ScreenshotsSection (PR #2693) — that component is gone but the
 * data shape and refresh strategy are unchanged.
 *
 * Visibility-aware URL routing happens in `viewableScreenshotUrl`:
 * - Public-repo screenshots ship with a signed `?artifactToken=` query and
 *   render directly via the public proxy.
 * - Private-repo screenshots have no token; the helper rewrites to the
 *   authenticated `/view` route which the worker gates on the user's session
 *   cookie + parent-session access.
 */
export function useSessionScreenshots(
  sessionId: string,
  sessionPhase: Phase | undefined,
): Map<string, AgentScreenshot[]> {
  const [artifactState, setArtifactState] = useState<ArtifactState>(() => getCachedArtifactState(sessionId));

  const shouldPoll = !sessionPhase || !QUIESCENT_PHASES.has(sessionPhase);

  useSyncEffect(() => {
    if (typeof document === "undefined") return;
    let cancelled = false;
    const controller = new AbortController();
    let interval: ReturnType<typeof setInterval> | null = null;
    setArtifactState((prev) => (prev.sessionId === sessionId ? prev : getCachedArtifactState(sessionId)));

    async function load() {
      try {
        const rows = await fetchSessionArtifacts(sessionId, controller.signal);
        cacheArtifacts(sessionId, rows);
        if (!cancelled) setArtifactState({ sessionId, artifacts: rows });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        // Swallow — screenshots are non-critical UX. Failing to load shouldn't
        // surface as an error to the user; the next poll will retry.
        console.error("Failed to load session screenshots", err);
      }
    }

    const clearPolling = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };

    const restartPolling = (loadImmediately: boolean) => {
      clearPolling();
      if (!shouldPoll) return;
      if (document.visibilityState !== "visible") return;
      if (loadImmediately) void load();
      interval = setInterval(() => {
        void load();
      }, POLL_INTERVAL_MS);
    };

    void load();
    restartPolling(false);

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        restartPolling(true);
      } else {
        clearPolling();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      controller.abort();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      clearPolling();
    };
  }, [sessionId, shouldPoll]);

  return useMemo(() => {
    const artifacts =
      artifactState.sessionId === sessionId ? artifactState.artifacts : (artifactCacheBySessionId.get(sessionId) ?? []);
    const byPrompt = new Map<string, AgentScreenshot[]>();
    for (const row of artifacts) {
      if (row.type !== "screenshot") continue;
      if (!row.promptId) continue;
      const entry: AgentScreenshot = {
        artifactId: row.artifactId,
        promptId: row.promptId,
        viewUrl: viewableScreenshotUrl(row),
        label: row.metadata?.label ?? row.metadata?.filename ?? "Screenshot",
        createdAt: row.createdAt,
      };
      const list = byPrompt.get(row.promptId) ?? [];
      list.push(entry);
      byPrompt.set(row.promptId, list);
    }
    // Oldest-first within a prompt: matches the chronological order of agent
    // actions in the transcript.
    for (const list of byPrompt.values()) {
      list.sort((a, b) => a.createdAt - b.createdAt);
    }
    return byPrompt;
  }, [artifactState, sessionId]);
}
