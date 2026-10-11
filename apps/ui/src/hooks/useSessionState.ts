import { type Dispatch, type SetStateAction, useCallback, useMemo, useReducer, useRef } from "react";

import type { PromptHistoryFetchResult } from "../api/sessions";
import type { ActivityEvent, PromptRow, SessionDetail, SessionMetadata } from "../types";
import { latestDurableSequenceForPrompt } from "./session-state/durable-events";
import {
  createInitialSessionState,
  getActivePromptId,
  sessionStateReducer,
  toPublicState,
} from "./session-state/reducer";
import type {
  CanonicalDurableEvent,
  SessionState,
  SessionStateAction,
  SessionStateInternal,
} from "./session-state/types";
import { useOnChange } from "./useEffects";

export { getActivePromptId, getInFlightPromptId } from "./session-state/reducer";
export type {
  SessionEventAction,
  SessionInternalAction,
  SessionState,
  SessionStateAction,
} from "./session-state/types";

type UseSessionStateResult = {
  state: SessionState;
  dispatch: (action: SessionStateAction) => void;
  stateRef: { current: SessionState };
  internalStateRef: { current: SessionStateInternal };
  promptsRef: { current: PromptRow[] };
  transcriptsRef: { current: Map<string, ActivityEvent[]> };
  liveModeRef: { current: boolean };
  resetState: (initialSession?: SessionDetail | null) => void;
  initializeSessionData: (session: SessionDetail, prompts: PromptRow[]) => void;
  mergeSessionMetadata: (session: SessionDetail, prompts: PromptRow[]) => void;
  setSessions: Dispatch<SetStateAction<SessionMetadata[]>>;
  ingestReplayPage: (events: CanonicalDurableEvent[]) => void;
  ingestLiveEvent: (event: CanonicalDurableEvent) => void;
  applyPromptHistoryFetchResult: (
    promptId: string,
    result: PromptHistoryFetchResult,
  ) => { replacedPartialReplay: boolean; staleDiscarded: boolean };
  updateSession: (updater: (prev: SessionDetail | null) => SessionDetail | null) => void;
  setPrUpdated: (value: boolean) => void;
  answerLatestQuestion: (answer: string) => void;
  getActivePromptId: (promptList?: PromptRow[]) => string | null;
};

function trackDurableEventProjectionDispatch(context: {
  eventCount: number;
  totalDurableEventCount: number;
  promptCount: number;
  markLive: boolean;
  dispatchDurationMs: number;
}): void {
  void import("../datadog").then(({ trackAction }) =>
    trackAction("session_durable_event_projection_dispatch", context),
  );
}

export function useSessionState({
  sessionId,
  initialSession,
}: {
  sessionId: string;
  initialSession?: SessionDetail;
}): UseSessionStateResult {
  const [state, dispatch] = useReducer(sessionStateReducer, initialSession ?? null, createInitialSessionState);
  const publicState = useMemo(() => toPublicState(state), [state]);
  const stateRef = useRef<SessionState>(publicState);
  const internalStateRef = useRef(state);
  const promptsRef = useRef<PromptRow[]>(publicState.prompts);
  const transcriptsRef = useRef<Map<string, ActivityEvent[]>>(publicState.transcripts);
  const liveModeRef = useRef(publicState.liveMode);

  stateRef.current = publicState;
  internalStateRef.current = state;
  promptsRef.current = publicState.prompts;
  transcriptsRef.current = publicState.transcripts;
  liveModeRef.current = publicState.liveMode;

  useOnChange([sessionId], () => {
    dispatch({ type: "state/reset", initialSession: initialSession ?? null });
  });

  const resetState = useCallback(
    (nextInitialSession: SessionDetail | null = initialSession ?? null) => {
      dispatch({ type: "state/reset", initialSession: nextInitialSession });
    },
    [initialSession],
  );

  const initializeSessionData = useCallback((session: SessionDetail, prompts: PromptRow[]) => {
    dispatch({ type: "state/initialize", session, prompts });
  }, []);

  const mergeSessionMetadataAction = useCallback((session: SessionDetail, prompts: PromptRow[]) => {
    dispatch({ type: "state/merge_session_metadata", session, prompts });
  }, []);

  const setSessions = useCallback<Dispatch<SetStateAction<SessionMetadata[]>>>((updater) => {
    dispatch({
      type: "state/sessions",
      updater: (prev) =>
        typeof updater === "function" ? (updater as (prev: SessionMetadata[]) => SessionMetadata[])(prev) : updater,
    });
  }, []);

  const ingestReplayPage = useCallback((events: CanonicalDurableEvent[]) => {
    const startedAt = performance.now();
    const currentState = internalStateRef.current;
    dispatch({ type: "event/ingest_replay_page", events });
    trackDurableEventProjectionDispatch({
      eventCount: events.length,
      totalDurableEventCount: currentState.durableEventSequences.length,
      promptCount: currentState.prompts.length,
      markLive: false,
      dispatchDurationMs: Math.round(performance.now() - startedAt),
    });
  }, []);

  const ingestLiveEvent = useCallback((event: CanonicalDurableEvent) => {
    const startedAt = performance.now();
    const currentState = internalStateRef.current;
    dispatch({ type: "event/ingest_live_event", event });
    trackDurableEventProjectionDispatch({
      eventCount: 1,
      totalDurableEventCount: currentState.durableEventSequences.length,
      promptCount: currentState.prompts.length,
      markLive: true,
      dispatchDurationMs: Math.round(performance.now() - startedAt),
    });
  }, []);

  const applyPromptHistoryFetchResult = useCallback((promptId: string, result: PromptHistoryFetchResult) => {
    const currentState = internalStateRef.current;
    const prompt = currentState.prompts.find((candidate) => candidate.promptId === promptId) ?? null;
    const latestDurableSequence = latestDurableSequenceForPrompt(currentState, promptId);
    const promptIsCompleted = prompt
      ? prompt.result !== null || prompt.status === "completed" || prompt.status === "failed"
      : true;
    const existingTranscript = currentState.transcripts.get(promptId) ?? [];
    const staleDiscarded = result.ok && !promptIsCompleted && result.result.maxSequence < (latestDurableSequence ?? 0);
    const replacedPartialReplay =
      result.ok &&
      promptIsCompleted &&
      existingTranscript.length > 0 &&
      (existingTranscript.length !== result.result.events.length ||
        existingTranscript.some((event, index) => event.id !== result.result.events[index]?.id));

    dispatch({ type: "event/prompt_history", promptId, result });
    return { replacedPartialReplay, staleDiscarded };
  }, []);

  const updateSession = useCallback((updater: (prev: SessionDetail | null) => SessionDetail | null) => {
    dispatch({ type: "state/update_session", updater });
  }, []);

  const setPrUpdated = useCallback((value: boolean) => {
    dispatch({ type: "state/pr_updated", value });
  }, []);

  const answerLatestQuestion = useCallback((answer: string) => {
    dispatch({ type: "state/question_answer_latest", answer });
  }, []);

  const getCurrentActivePromptId = useCallback((promptList: PromptRow[] = promptsRef.current): string | null => {
    return getActivePromptId(promptList);
  }, []);

  return {
    state: publicState,
    dispatch,
    stateRef,
    internalStateRef,
    promptsRef,
    transcriptsRef,
    liveModeRef,
    resetState,
    initializeSessionData,
    mergeSessionMetadata: mergeSessionMetadataAction,
    setSessions,
    ingestReplayPage,
    ingestLiveEvent,
    applyPromptHistoryFetchResult,
    updateSession,
    setPrUpdated,
    answerLatestQuestion,
    getActivePromptId: getCurrentActivePromptId,
  };
}
