import { useCallback, useRef, useState } from "react";
import type { NavigateFunction } from "react-router";

import { ApiError } from "../api/client";
import {
  buildPromptEventsResult,
  fetchPromptEvents,
  fetchPromptEventsPage,
  fetchSessionHistoryProbe,
  fetchSessionView,
  type PromptHistoryFetchResult,
  type RawSessionEvent,
} from "../api/sessions";
import { TERMINAL_FOR_FALLBACK_POLLING_PHASES, WS_BOOTSTRAP_TIMEOUT_MS } from "../constants";
import type { PromptRow, SessionDetail, SessionMetadata } from "../types";
import { waitForDelay } from "../utils/async";
import { useSyncEffect } from "./useEffects";
import type { ActivePromptHistoryRefreshSource } from "./useSessionFallbackPolling";
import { getInFlightPromptId } from "./useSessionState";

const HISTORY_HYDRATION_CONCURRENCY = 2;
const HISTORY_RETRY_DELAY_MS = 2000;
const HISTORY_PAGE_IDLE_DELAY_MS = 16;

export type PromptHistoryHydrationState = "pending" | "hydrated" | "failed" | "skipped_due_to_truncation";

type ActivePromptHistoryRefreshJob = {
  promptId: string;
  source: ActivePromptHistoryRefreshSource;
};

type PromptPageState = {
  nextCursor: string | null;
  total: number | null;
};

type UseSessionBootstrapOptions = {
  applyPromptHistoryFetchResult: (
    promptId: string,
    result: PromptHistoryFetchResult,
  ) => { replacedPartialReplay: boolean; staleDiscarded: boolean };
  getCurrentPrompts?: () => PromptRow[];
  initialSession?: SessionDetail;
  initializeSessionData: (session: SessionDetail, prompts: PromptRow[]) => void;
  mergeSessionMetadata: (session: SessionDetail, prompts: PromptRow[]) => void;
  navigate: NavigateFunction;
  sessionId: string;
  setSessions: (updater: (prev: SessionMetadata[]) => SessionMetadata[]) => void;
  stopPolling: () => void;
  startPolling: () => void;
};

export function useSessionBootstrap({
  applyPromptHistoryFetchResult,
  getCurrentPrompts = () => [],
  initialSession,
  initializeSessionData,
  mergeSessionMetadata,
  navigate,
  sessionId,
  setSessions,
  stopPolling,
  startPolling,
}: UseSessionBootstrapOptions) {
  // These seed values belong to the session route's first render. Keeping them
  // in refs prevents sidebar bootstrap updates from restarting the whole
  // transcript hydration effect for the same deep-linked session.
  const initialSessionSeedRef = useRef(initialSession);
  const hasInitialSession = initialSessionSeedRef.current !== undefined;
  const initialOwnerAvatarUrl = initialSessionSeedRef.current?.ownerAvatarUrl ?? null;
  const [error, setError] = useState<string | null>(null);
  const [ownerAvatarUrl, setOwnerAvatarUrl] = useState<string | null>(initialOwnerAvatarUrl);
  const [promptPage, setPromptPage] = useState<PromptPageState>({ nextCursor: null, total: null });
  const [loadingNextPromptPage, setLoadingNextPromptPage] = useState(false);
  const [sessionHydrated, setSessionHydrated] = useState(!hasInitialSession);
  const [promptHistoryStates, setPromptHistoryStates] = useState<Map<string, PromptHistoryHydrationState>>(new Map());
  const activePromptHistoryRefreshInFlightRef = useRef<ActivePromptHistoryRefreshJob | null>(null);
  const activePromptHistoryRefreshRequestIdRef = useRef(0);
  const authoritativeSessionViewLoadedRef = useRef(false);
  const bootstrapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyRequestControllerRef = useRef<AbortController | null>(null);
  const historyHydrationActiveCountRef = useRef(0);
  const historyHydrationGenerationRef = useRef(0);
  const historyHydrationQueueRef = useRef<string[]>([]);
  const historyProbeInFlightRef = useRef<Promise<void> | null>(null);
  const httpBootstrapStartedRef = useRef(false);
  const hydratedPromptIdsRef = useRef(new Set<string>());
  const pendingBucketedPromptIdsRef = useRef(new Set<string>());
  const promptHistoryInflightRef = useRef(new Map<string, Promise<PromptHistoryFetchResult>>());
  const queuedPromptIdsRef = useRef(new Set<string>());
  const queuedActivePromptHistoryRefreshRef = useRef<ActivePromptHistoryRefreshJob | null>(null);
  const seedBootstrapFailureDeferredRef = useRef(false);
  const sessionViewRequestGenerationRef = useRef(0);
  const wsBootstrapTimeoutElapsedRef = useRef(false);
  const wsBootstrappedRef = useRef(false);
  const transcriptHydrationStartedAtRef = useRef(performance.now());
  const transcriptHydrationPromptIdsRef = useRef(new Set<string>());
  const transcriptHydrationModeRef = useRef<"probe" | "per_prompt">("probe");
  const transcriptHydrationRecordedRef = useRef(false);

  const recordFullTranscriptTiming = useCallback(() => {
    if (transcriptHydrationRecordedRef.current || transcriptHydrationPromptIdsRef.current.size === 0) return;
    if (
      [...transcriptHydrationPromptIdsRef.current].some((promptId) => promptHistoryStates.get(promptId) !== "hydrated")
    ) {
      return;
    }

    transcriptHydrationRecordedRef.current = true;
    const promptCount = transcriptHydrationPromptIdsRef.current.size;
    const promptCountBucket = promptCount <= 5 ? "1-5" : promptCount <= 20 ? "6-20" : "21+";
    const durationMs = Math.round(performance.now() - transcriptHydrationStartedAtRef.current);
    void import("../datadog").then(({ addSessionTiming, trackAction }) => {
      addSessionTiming("arcanist.ui.session_full_transcript_ms", Date.now());
      trackAction("session_full_transcript_hydrated", {
        durationMs,
        promptCountBucket,
        hydrationMode: transcriptHydrationModeRef.current,
      });
    });
  }, [promptHistoryStates]);

  const setPromptHistoryState = useCallback((promptId: string, state: PromptHistoryHydrationState) => {
    setPromptHistoryStates((current) => {
      if (current.get(promptId) === state) return current;
      const next = new Map(current);
      next.set(promptId, state);
      return next;
    });
  }, []);

  useSyncEffect(() => {
    recordFullTranscriptTiming();
  }, [promptHistoryStates, recordFullTranscriptTiming]);

  const setPromptHistoryStatesForIds = useCallback((promptIds: string[], state: PromptHistoryHydrationState) => {
    if (promptIds.length === 0) return;
    setPromptHistoryStates((current) => {
      let changed = false;
      const next = new Map(current);
      for (const promptId of promptIds) {
        if (next.get(promptId) === state) continue;
        next.set(promptId, state);
        changed = true;
      }
      return changed ? next : current;
    });
  }, []);

  const clearPromptHistoryStates = useCallback(() => {
    setPromptHistoryStates((current) => (current.size === 0 ? current : new Map()));
  }, []);

  const markPromptHistoriesSkipped = useCallback(
    (promptIds: string[]) => {
      setPromptHistoryStatesForIds(promptIds, "skipped_due_to_truncation");
    },
    [setPromptHistoryStatesForIds],
  );

  const mergePromptPage = useCallback((existingPrompts: PromptRow[], incomingPrompts: PromptRow[]) => {
    if (existingPrompts.length === 0) return incomingPrompts;
    if (incomingPrompts.length === 0) return existingPrompts;

    const incomingByPromptId = new Map(incomingPrompts.map((prompt) => [prompt.promptId, prompt]));
    const mergedPrompts = existingPrompts.map((prompt) => incomingByPromptId.get(prompt.promptId) ?? prompt);
    const existingPromptIds = new Set(existingPrompts.map((prompt) => prompt.promptId));

    for (const prompt of incomingPrompts) {
      if (!existingPromptIds.has(prompt.promptId)) {
        mergedPrompts.push(prompt);
      }
    }

    return mergedPrompts;
  }, []);

  const normalizePromptPage = useCallback(
    (result: Awaited<ReturnType<typeof fetchSessionView>>): PromptPageState => ({
      nextCursor: result.promptPage?.nextCursor ?? null,
      total: result.promptPage?.total ?? null,
    }),
    [],
  );

  const updatePromptPage = useCallback((nextPage: PromptPageState) => {
    setPromptPage((prev) =>
      prev.nextCursor === nextPage.nextCursor && prev.total === nextPage.total ? prev : nextPage,
    );
  }, []);

  const clearBootstrapTimeout = useCallback(() => {
    if (bootstrapTimeoutRef.current) {
      clearTimeout(bootstrapTimeoutRef.current);
      bootstrapTimeoutRef.current = null;
    }
  }, []);

  const syncOwnerAvatar = useCallback((detail: { ownerAvatarUrl?: string | null }) => {
    if (detail.ownerAvatarUrl) setOwnerAvatarUrl(detail.ownerAvatarUrl);
  }, []);

  const getHistoryRequestSignal = useCallback(() => {
    if (!historyRequestControllerRef.current || historyRequestControllerRef.current.signal.aborted) {
      historyRequestControllerRef.current = new AbortController();
    }
    return historyRequestControllerRef.current.signal;
  }, []);

  const resetHistoryRequests = useCallback(() => {
    historyRequestControllerRef.current?.abort();
    historyRequestControllerRef.current = new AbortController();
    promptHistoryInflightRef.current.clear();
    historyHydrationGenerationRef.current += 1;
    historyHydrationActiveCountRef.current = 0;
    historyHydrationQueueRef.current = [];
    historyProbeInFlightRef.current = null;
    hydratedPromptIdsRef.current.clear();
    pendingBucketedPromptIdsRef.current.clear();
    queuedPromptIdsRef.current.clear();
    clearPromptHistoryStates();
    return historyRequestControllerRef.current.signal;
  }, [clearPromptHistoryStates]);

  const nextSessionViewRequestGeneration = useCallback(() => {
    sessionViewRequestGenerationRef.current += 1;
    return sessionViewRequestGenerationRef.current;
  }, []);

  const isCurrentSessionViewRequest = useCallback((generation: number) => {
    return sessionViewRequestGenerationRef.current === generation;
  }, []);

  const fetchPromptHistoryOnce = useCallback(
    (promptId: string, signal?: AbortSignal): Promise<PromptHistoryFetchResult> => {
      const existing = promptHistoryInflightRef.current.get(promptId);
      if (existing) return existing;

      const promise = fetchPromptEvents(sessionId, promptId, signal)
        .then((result) => {
          if (result.ok) setPromptHistoryState(promptId, "hydrated");
          return result;
        })
        .finally(() => {
          if (promptHistoryInflightRef.current.get(promptId) === promise) {
            promptHistoryInflightRef.current.delete(promptId);
          }
        });
      promptHistoryInflightRef.current.set(promptId, promise);
      return promise;
    },
    [sessionId, setPromptHistoryState],
  );

  const trackPromptHistoryOutcome = useCallback(
    (promptId: string, result: PromptHistoryFetchResult) => {
      const outcome = applyPromptHistoryFetchResult(promptId, result);

      if (outcome.replacedPartialReplay) {
        void import("../datadog").then(({ trackAction }) =>
          trackAction("session_prompt_history_replaced_partial_replay", { sessionId, promptId }),
        );
      }

      if (outcome.staleDiscarded && result.ok) {
        void import("../datadog").then(({ trackAction }) =>
          trackAction("session_prompt_history_stale_discard", {
            sessionId,
            promptId,
            historySequence: result.result.maxSequence,
            // The legacy event name is retained for dashboard continuity; the reducer now merges this history.
            merged: true,
          }),
        );
      }

      return outcome;
    },
    [applyPromptHistoryFetchResult, sessionId],
  );

  const fetchPromptHistoryWithRetry = useCallback(
    async (
      promptId: string,
      options?: { signal?: AbortSignal; source?: string; retryOnce?: boolean; markIncompleteOnFailure?: boolean },
    ): Promise<PromptHistoryFetchResult> => {
      const signal = options?.signal;
      const retryOnce = options?.retryOnce ?? true;
      const markIncompleteOnFailure = options?.markIncompleteOnFailure ?? true;

      for (let attempt = 0; attempt <= (retryOnce ? 1 : 0); attempt += 1) {
        const result = await fetchPromptHistoryOnce(promptId, signal);
        if (result.ok) {
          setPromptHistoryState(promptId, "hydrated");
          return result;
        }

        void import("../datadog").then(({ trackAction }) =>
          trackAction("session_prompt_history_hydration_failed", {
            sessionId,
            promptId,
            source: options?.source ?? "unknown",
            status: result.status ?? "unknown",
            retried: attempt > 0,
          }),
        );

        if (attempt === 0 && retryOnce) {
          await waitForDelay(HISTORY_RETRY_DELAY_MS, signal);
          continue;
        }

        if (markIncompleteOnFailure) {
          applyPromptHistoryFetchResult(promptId, result);
        }
        setPromptHistoryState(promptId, "failed");
        return result;
      }

      return { ok: false, error: new Error("Unreachable prompt history retry state") };
    },
    [applyPromptHistoryFetchResult, fetchPromptHistoryOnce, sessionId, setPromptHistoryState],
  );

  const waitForPromptHistoryIdle = useCallback(async (signal: AbortSignal | undefined) => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const scheduler = globalThis as typeof globalThis & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (scheduler.requestIdleCallback) {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let handle: number | undefined;
        const cleanup = () => {
          signal?.removeEventListener("abort", abort);
        };
        const finish = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };
        const abort = () => {
          if (settled) return;
          settled = true;
          if (handle != null) scheduler.cancelIdleCallback?.(handle);
          cleanup();
          reject(new DOMException("Aborted", "AbortError"));
        };
        handle = scheduler.requestIdleCallback?.(finish, { timeout: 250 });
        if (!signal) return;
        signal.addEventListener("abort", abort, { once: true });
      });
      return;
    }
    await waitForDelay(HISTORY_PAGE_IDLE_DELAY_MS, signal);
  }, []);

  const fetchPromptHistoryPageWithRetry = useCallback(
    async (
      promptId: string,
      afterSequence: number | undefined,
      options?: { signal?: AbortSignal; source?: string; retryOnce?: boolean },
    ) => {
      const retryOnce = options?.retryOnce ?? true;
      for (let attempt = 0; attempt <= (retryOnce ? 1 : 0); attempt += 1) {
        const result = await fetchPromptEventsPage(sessionId, promptId, { afterSequence }, options?.signal);
        if (result.ok) return result;

        void import("../datadog").then(({ trackAction }) =>
          trackAction("session_prompt_history_page_hydration_failed", {
            sessionId,
            promptId,
            source: options?.source ?? "unknown",
            afterSequence: afterSequence ?? null,
            status: result.status ?? "unknown",
            retried: attempt > 0,
          }),
        );

        if (attempt === 0 && retryOnce) {
          await waitForDelay(HISTORY_RETRY_DELAY_MS, options?.signal);
          continue;
        }
        return result;
      }
      return { ok: false, error: new Error("Unreachable prompt history page retry state") } as const;
    },
    [sessionId],
  );

  const fetchPromptHistoryProgressively = useCallback(
    (promptId: string, options?: { signal?: AbortSignal; source?: string }): Promise<PromptHistoryFetchResult> => {
      const existing = promptHistoryInflightRef.current.get(promptId);
      if (existing) return existing;

      const promise = (async (): Promise<PromptHistoryFetchResult> => {
        const source = options?.source ?? "prompt_scheduler";
        const rawEvents: RawSessionEvent[] = [];
        let afterSequence: number | undefined;
        let latestResult: PromptHistoryFetchResult | null = null;

        while (true) {
          const page = await fetchPromptHistoryPageWithRetry(promptId, afterSequence, {
            signal: options?.signal,
            source,
            retryOnce: true,
          });

          if (!page.ok) {
            applyPromptHistoryFetchResult(promptId, page);
            setPromptHistoryState(promptId, "failed");
            return page;
          }

          rawEvents.push(...page.rawEvents);
          const cumulative = buildPromptEventsResult(rawEvents);
          latestResult = {
            ok: true,
            result: {
              ...cumulative,
              complete: page.result.complete,
              nextAfterSequence: page.result.nextAfterSequence ?? null,
              rawEventCount: rawEvents.length,
            },
            rawEvents: [...rawEvents],
          };
          const outcome = trackPromptHistoryOutcome(promptId, latestResult);

          void import("../datadog").then(({ trackAction }) =>
            trackAction("session_prompt_history_page_applied", {
              sessionId,
              promptId,
              source,
              rawEventCount: rawEvents.length,
              projectedEventCount: latestResult?.ok ? latestResult.result.events.length : 0,
              complete: latestResult?.ok ? latestResult.result.complete !== false : false,
              staleDiscarded: outcome.staleDiscarded,
            }),
          );

          if (page.result.complete !== false || !page.result.nextAfterSequence) {
            setPromptHistoryState(promptId, latestResult.result.complete === false ? "pending" : "hydrated");
            return latestResult;
          }

          afterSequence = page.result.nextAfterSequence;
          await waitForPromptHistoryIdle(options?.signal);
        }
      })().finally(() => {
        if (promptHistoryInflightRef.current.get(promptId) === promise) {
          promptHistoryInflightRef.current.delete(promptId);
        }
      });

      promptHistoryInflightRef.current.set(promptId, promise);
      return promise;
    },
    [
      applyPromptHistoryFetchResult,
      fetchPromptHistoryPageWithRetry,
      sessionId,
      setPromptHistoryState,
      trackPromptHistoryOutcome,
      waitForPromptHistoryIdle,
    ],
  );

  const drainPromptHistoryQueue = useCallback(
    (generation: number, signal: AbortSignal) => {
      if (generation !== historyHydrationGenerationRef.current || signal.aborted) return;

      while (
        historyHydrationActiveCountRef.current < HISTORY_HYDRATION_CONCURRENCY &&
        historyHydrationQueueRef.current.length > 0
      ) {
        const promptId = historyHydrationQueueRef.current.shift();
        if (!promptId) continue;
        queuedPromptIdsRef.current.delete(promptId);
        if (hydratedPromptIdsRef.current.has(promptId)) continue;
        setPromptHistoryState(promptId, "pending");

        historyHydrationActiveCountRef.current += 1;
        void (async () => {
          const startedAt = performance.now();
          try {
            const result = await fetchPromptHistoryProgressively(promptId, {
              signal,
              source: "prompt_scheduler",
            });
            if (signal.aborted || generation !== historyHydrationGenerationRef.current || !result.ok) return;
            if (result.result.complete !== false) {
              hydratedPromptIdsRef.current.add(promptId);
              setPromptHistoryState(promptId, "hydrated");
            }
            void import("../datadog").then(({ trackAction }) =>
              trackAction("session_prompt_history_hydrated", {
                sessionId,
                promptId,
                source: "prompt_scheduler",
                durationMs: Math.round(performance.now() - startedAt),
                eventCount: result.result.events.length,
                rawEventCount: result.result.rawEventCount ?? result.result.events.length,
                complete: result.result.complete !== false,
              }),
            );
          } catch (err) {
            if ((err as Error).name === "AbortError") return;
            applyPromptHistoryFetchResult(promptId, {
              ok: false,
              error: err instanceof Error ? err : new Error(String(err)),
            });
            setPromptHistoryState(promptId, "failed");
            console.error("[SessionDetail] History hydration failed:", err);
          } finally {
            if (generation === historyHydrationGenerationRef.current) {
              historyHydrationActiveCountRef.current = Math.max(0, historyHydrationActiveCountRef.current - 1);
              drainPromptHistoryQueue(generation, signal);
              if (historyHydrationActiveCountRef.current === 0 && historyHydrationQueueRef.current.length === 0) {
                historyRequestControllerRef.current = null;
              }
            }
          }
        })();
      }
    },
    [fetchPromptHistoryProgressively, sessionId, setPromptHistoryState],
  );

  const enqueuePromptHistories = useCallback(
    (promptIds: string[], generation: number, signal: AbortSignal) => {
      const promptIdsToQueue = promptIds.filter(
        (promptId) =>
          !hydratedPromptIdsRef.current.has(promptId) &&
          !queuedPromptIdsRef.current.has(promptId) &&
          !promptHistoryInflightRef.current.has(promptId),
      );
      if (promptIdsToQueue.length === 0) return;
      for (const promptId of promptIdsToQueue) {
        historyHydrationQueueRef.current.push(promptId);
        queuedPromptIdsRef.current.add(promptId);
      }
      setPromptHistoryStatesForIds(promptIdsToQueue, "pending");
      drainPromptHistoryQueue(generation, signal);
    },
    [drainPromptHistoryQueue, setPromptHistoryStatesForIds],
  );

  const startBucketedHistoryProbe = useCallback(
    (generation: number, signal: AbortSignal) => {
      if (historyProbeInFlightRef.current) return;

      const readPendingPromptIds = () =>
        Array.from(pendingBucketedPromptIdsRef.current).filter(
          (promptId) =>
            !hydratedPromptIdsRef.current.has(promptId) &&
            !queuedPromptIdsRef.current.has(promptId) &&
            !promptHistoryInflightRef.current.has(promptId),
        );

      const fallbackToPromptQueue = (promptIds: string[]) => {
        const fallbackPromptIds = promptIds.filter((promptId) => pendingBucketedPromptIdsRef.current.has(promptId));
        for (const promptId of fallbackPromptIds) {
          pendingBucketedPromptIdsRef.current.delete(promptId);
        }
        enqueuePromptHistories(fallbackPromptIds, generation, signal);
      };

      const promise = (async () => {
        try {
          await waitForPromptHistoryIdle(signal);
          if (signal.aborted || generation !== historyHydrationGenerationRef.current) return;

          const promptIds = readPendingPromptIds();
          if (promptIds.length === 0) return;
          if (promptIds.length === 1) {
            transcriptHydrationModeRef.current = "per_prompt";
            fallbackToPromptQueue(promptIds);
            return;
          }

          const result = await fetchSessionHistoryProbe(sessionId, promptIds, signal);
          if (signal.aborted || generation !== historyHydrationGenerationRef.current) return;

          if (result.ok && result.complete) {
            let resolvedCount = 0;
            for (const [promptId, promptResult] of result.results) {
              pendingBucketedPromptIdsRef.current.delete(promptId);
              if (hydratedPromptIdsRef.current.has(promptId) || promptHistoryInflightRef.current.has(promptId)) {
                continue;
              }
              const outcome = trackPromptHistoryOutcome(promptId, {
                ok: true,
                result: {
                  ...promptResult,
                  complete: true,
                  rawEventCount: promptResult.rawEventCount ?? promptResult.events.length,
                },
                rawEvents: promptResult.rawEvents,
              });
              if (!outcome.staleDiscarded) {
                hydratedPromptIdsRef.current.add(promptId);
                setPromptHistoryState(promptId, "hydrated");
                resolvedCount += 1;
              }
            }
            void import("../datadog").then(({ trackAction }) =>
              trackAction("session_prompt_history_bucketed", {
                sessionId,
                promptCount: promptIds.length,
                resolvedCount,
                source: "bounded_probe",
              }),
            );
            return;
          }

          void import("../datadog").then(({ trackAction }) =>
            trackAction("session_prompt_history_bucketed_fallback", {
              sessionId,
              promptCount: promptIds.length,
              reason: result.ok ? "probe_has_more" : "probe_failed",
            }),
          );
          fallbackToPromptQueue(promptIds);
        } catch (err) {
          if ((err as Error).name === "AbortError" || signal.aborted) return;
          console.warn("[SessionDetail] Bucketed history probe failed; falling back to per-prompt hydration", err);
          const promptIds = readPendingPromptIds();
          transcriptHydrationModeRef.current = "per_prompt";
          fallbackToPromptQueue(promptIds);
        }
      })().finally(() => {
        if (historyProbeInFlightRef.current === promise) {
          historyProbeInFlightRef.current = null;
        }
        if (!signal.aborted && generation === historyHydrationGenerationRef.current) {
          const remainingPromptIds = readPendingPromptIds();
          if (remainingPromptIds.length > 0) {
            transcriptHydrationModeRef.current = "per_prompt";
            fallbackToPromptQueue(remainingPromptIds);
            return;
          }
        }
        if (
          historyHydrationActiveCountRef.current === 0 &&
          historyHydrationQueueRef.current.length === 0 &&
          pendingBucketedPromptIdsRef.current.size === 0 &&
          historyRequestControllerRef.current?.signal === signal
        ) {
          historyRequestControllerRef.current = null;
        }
      });

      historyProbeInFlightRef.current = promise;
    },
    [enqueuePromptHistories, sessionId, setPromptHistoryState, trackPromptHistoryOutcome, waitForPromptHistoryIdle],
  );

  const hydratePromptHistories = useCallback(
    (promptIds: string[]) => {
      const promptIdsToHydrate = promptIds.filter(
        (promptId) =>
          !hydratedPromptIdsRef.current.has(promptId) &&
          !queuedPromptIdsRef.current.has(promptId) &&
          !pendingBucketedPromptIdsRef.current.has(promptId) &&
          !promptHistoryInflightRef.current.has(promptId),
      );
      if (promptIdsToHydrate.length === 0) return;
      for (const promptId of promptIdsToHydrate) transcriptHydrationPromptIdsRef.current.add(promptId);
      const signal = getHistoryRequestSignal();
      const generation = historyHydrationGenerationRef.current;
      void import("../datadog").then(({ trackAction }) =>
        trackAction("session_prompt_history_hydration_started", {
          sessionId,
          promptCount: promptIdsToHydrate.length,
          source: "prompt_scheduler",
        }),
      );
      if (promptIdsToHydrate.length === 1) {
        transcriptHydrationModeRef.current = "per_prompt";
        enqueuePromptHistories(promptIdsToHydrate, generation, signal);
        return;
      }
      for (const promptId of promptIdsToHydrate) {
        pendingBucketedPromptIdsRef.current.add(promptId);
      }
      setPromptHistoryStatesForIds(promptIdsToHydrate, "pending");
      startBucketedHistoryProbe(generation, signal);
    },
    [
      enqueuePromptHistories,
      getHistoryRequestSignal,
      sessionId,
      setPromptHistoryStatesForIds,
      startBucketedHistoryProbe,
    ],
  );

  const prioritizePromptHistories = useCallback(
    (promptIds: string[]) => {
      if (promptIds.length === 0) return;

      const activePromptId = getInFlightPromptId(getCurrentPrompts());
      const existingQueue = historyHydrationQueueRef.current;
      const existingQueuedIds = new Set(existingQueue);
      const prioritizedIds: string[] = [];

      for (const promptId of promptIds) {
        if (hydratedPromptIdsRef.current.has(promptId) || promptHistoryInflightRef.current.has(promptId)) continue;
        if (pendingBucketedPromptIdsRef.current.has(promptId) && promptId !== activePromptId) continue;
        pendingBucketedPromptIdsRef.current.delete(promptId);
        if (!existingQueuedIds.has(promptId) && !queuedPromptIdsRef.current.has(promptId)) {
          queuedPromptIdsRef.current.add(promptId);
        }
        if (!prioritizedIds.includes(promptId)) {
          prioritizedIds.push(promptId);
        }
      }

      if (prioritizedIds.length === 0) return;

      const prioritizedSet = new Set(prioritizedIds);
      historyHydrationQueueRef.current = [
        ...prioritizedIds,
        ...existingQueue.filter((promptId) => !prioritizedSet.has(promptId)),
      ];

      drainPromptHistoryQueue(historyHydrationGenerationRef.current, getHistoryRequestSignal());
    },
    [drainPromptHistoryQueue, getCurrentPrompts, getHistoryRequestSignal],
  );

  const handleOrphanedSession = useCallback(() => {
    stopPolling();
    setError(null);
    setSessions((prev) => prev.filter((item) => item.sessionId !== sessionId));
    navigate("/", { replace: true });
  }, [navigate, sessionId, setSessions, stopPolling]);

  const runActivePromptHistoryRefresh = useCallback(
    async (job: ActivePromptHistoryRefreshJob) => {
      activePromptHistoryRefreshInFlightRef.current = job;
      const requestId = activePromptHistoryRefreshRequestIdRef.current + 1;
      activePromptHistoryRefreshRequestIdRef.current = requestId;
      const { promptId, source } = job;
      let promptHistoryRefreshed = false;
      queuedPromptIdsRef.current.delete(promptId);
      historyHydrationQueueRef.current = historyHydrationQueueRef.current.filter(
        (queuedPromptId) => queuedPromptId !== promptId,
      );
      setPromptHistoryState(promptId, "pending");

      try {
        const fetchResult = await fetchPromptHistoryProgressively(promptId, {
          signal: getHistoryRequestSignal(),
          source,
        });
        if (activePromptHistoryRefreshRequestIdRef.current !== requestId) return;
        if (fetchResult.ok) {
          const outcome = trackPromptHistoryOutcome(promptId, fetchResult);
          if (!outcome.staleDiscarded) {
            hydratedPromptIdsRef.current.add(promptId);
            setPromptHistoryState(promptId, "hydrated");
            promptHistoryRefreshed = true;
          }
        }

        if (!fetchResult.ok) throw fetchResult.error;
        const recoveredPendingQuestion = fetchResult.result.events.some(
          (event) => event.type === "question" && event.answer === null,
        );
        void import("../datadog").then(({ trackAction }) =>
          trackAction("session_active_prompt_history_refresh", {
            sessionId,
            promptId,
            source,
            recoveredPendingQuestion,
          }),
        );

        if (recoveredPendingQuestion) {
          console.warn(`[SessionDetail] Recovered pending question for active prompt ${promptId} via ${source}`);
          void import("../datadog").then(({ trackAction }) =>
            trackAction("session_pending_question_recovered", {
              sessionId,
              promptId,
              source,
            }),
          );
        }
      } catch (err) {
        if (activePromptHistoryRefreshRequestIdRef.current !== requestId) return;
        setPromptHistoryState(promptId, "failed");
        console.warn(`[SessionDetail] Active prompt history refresh failed via ${source}`, err);
        void import("../datadog").then(({ trackAction }) =>
          trackAction("session_active_prompt_history_refresh_failed", {
            sessionId,
            promptId,
            source,
          }),
        );
      } finally {
        if (activePromptHistoryRefreshRequestIdRef.current !== requestId) return;
        activePromptHistoryRefreshInFlightRef.current = null;
        const queuedJob = queuedActivePromptHistoryRefreshRef.current;
        if (!queuedJob) return;
        queuedActivePromptHistoryRefreshRef.current = null;
        if (promptHistoryRefreshed && queuedJob.promptId === promptId) return;
        void runActivePromptHistoryRefresh(queuedJob);
      }
    },
    [
      fetchPromptHistoryProgressively,
      getHistoryRequestSignal,
      sessionId,
      setPromptHistoryState,
      trackPromptHistoryOutcome,
    ],
  );

  const refreshActivePromptHistory = useCallback(
    async (promptList: PromptRow[], source: ActivePromptHistoryRefreshSource) => {
      const promptId = getInFlightPromptId(promptList);
      if (!promptId) return;

      const job = { promptId, source };
      if (activePromptHistoryRefreshInFlightRef.current) {
        queuedActivePromptHistoryRefreshRef.current = job;
        return;
      }

      await runActivePromptHistoryRefresh(job);
    },
    [runActivePromptHistoryRefresh],
  );

  const refresh = useCallback(
    async (source: ActivePromptHistoryRefreshSource = "poll") => {
      try {
        const rebuildFromReplayTruncation = source === "replay_truncated" && !authoritativeSessionViewLoadedRef.current;
        if (rebuildFromReplayTruncation) {
          resetHistoryRequests();
        }
        const requestGeneration = nextSessionViewRequestGeneration();
        const result = await fetchSessionView(sessionId);
        const { session: s, prompts: p } = result;
        if (!isCurrentSessionViewRequest(requestGeneration)) return;
        updatePromptPage(normalizePromptPage(result));
        setError(null);
        if (rebuildFromReplayTruncation) {
          initializeSessionData(s, p);
          authoritativeSessionViewLoadedRef.current = true;
          hydratePromptHistories(p.map((prompt) => prompt.promptId));
        } else {
          const mergedPrompts = mergePromptPage(getCurrentPrompts(), p);
          mergeSessionMetadata(s, mergedPrompts);
          authoritativeSessionViewLoadedRef.current = true;
          if (source === "replay_truncated") {
            hydratePromptHistories(p.map((prompt) => prompt.promptId));
          } else {
            await refreshActivePromptHistory(mergedPrompts, source);
          }
        }
        setSessionHydrated(true);
        syncOwnerAvatar(s);
        if (TERMINAL_FOR_FALLBACK_POLLING_PHASES.has(s.phase)) {
          stopPolling();
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          handleOrphanedSession();
          return;
        }
        setError(String(e));
        console.warn(`[SessionDetail] Refresh failed via ${source}:`, e);
      }
    },
    [
      handleOrphanedSession,
      hydratePromptHistories,
      initializeSessionData,
      getCurrentPrompts,
      mergePromptPage,
      refreshActivePromptHistory,
      mergeSessionMetadata,
      normalizePromptPage,
      updatePromptPage,
      resetHistoryRequests,
      nextSessionViewRequestGeneration,
      isCurrentSessionViewRequest,
      sessionId,
      stopPolling,
      syncOwnerAvatar,
    ],
  );

  const bootstrapFromHttp = useCallback(async () => {
    if (httpBootstrapStartedRef.current || wsBootstrappedRef.current) return;
    httpBootstrapStartedRef.current = true;
    clearBootstrapTimeout();
    const startedAt = performance.now();

    try {
      const requestGeneration = nextSessionViewRequestGeneration();
      const result = await fetchSessionView(sessionId);
      const { session: s, prompts: p } = result;
      if (!isCurrentSessionViewRequest(requestGeneration)) return;
      seedBootstrapFailureDeferredRef.current = false;
      for (const prompt of p) transcriptHydrationPromptIdsRef.current.add(prompt.promptId);
      updatePromptPage(normalizePromptPage(result));
      void import("../datadog").then(({ trackAction }) =>
        trackAction("session_cold_bootstrap_http_latency", {
          sessionId,
          durationMs: Math.round(performance.now() - startedAt),
        }),
      );
      syncOwnerAvatar(s);
      if (wsBootstrappedRef.current) return;
      initializeSessionData(s, p);
      authoritativeSessionViewLoadedRef.current = true;
      setSessionHydrated(true);
      if (TERMINAL_FOR_FALLBACK_POLLING_PHASES.has(s.phase)) {
        stopPolling();
      }
      hydratePromptHistories(p.map((prompt) => prompt.promptId));
    } catch (e) {
      if (wsBootstrappedRef.current) return;
      if (hasInitialSession && !seedBootstrapFailureDeferredRef.current && !wsBootstrapTimeoutElapsedRef.current) {
        seedBootstrapFailureDeferredRef.current = true;
        httpBootstrapStartedRef.current = false;
        console.warn("[SessionDetail] Deferred seeded HTTP bootstrap failure while waiting for WS:", e);
        return;
      }
      if (e instanceof ApiError && e.status === 404) {
        handleOrphanedSession();
        return;
      }
      setError(String(e));
      console.warn("[SessionDetail] HTTP bootstrap failed:", e);
      httpBootstrapStartedRef.current = false;
    }
  }, [
    clearBootstrapTimeout,
    handleOrphanedSession,
    hydratePromptHistories,
    initializeSessionData,
    hasInitialSession,
    normalizePromptPage,
    updatePromptPage,
    nextSessionViewRequestGeneration,
    isCurrentSessionViewRequest,
    sessionId,
    stopPolling,
    syncOwnerAvatar,
  ]);
  const bootstrapFromHttpRef = useRef(bootstrapFromHttp);
  const startPollingRef = useRef(startPolling);
  const stopPollingRef = useRef(stopPolling);
  bootstrapFromHttpRef.current = bootstrapFromHttp;
  startPollingRef.current = startPolling;
  stopPollingRef.current = stopPolling;

  const loadNextPromptPage = useCallback(async () => {
    if (loadingNextPromptPage || promptPage.nextCursor === null) return;
    setLoadingNextPromptPage(true);
    const requestGeneration = nextSessionViewRequestGeneration();
    try {
      const result = await fetchSessionView(sessionId, promptPage.nextCursor);
      if (!isCurrentSessionViewRequest(requestGeneration)) return;
      const mergedPrompts = mergePromptPage(getCurrentPrompts(), result.prompts);
      updatePromptPage(normalizePromptPage(result));
      setError(null);
      mergeSessionMetadata(result.session, mergedPrompts);
      hydratePromptHistories(result.prompts.map((prompt) => prompt.promptId));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        handleOrphanedSession();
        return;
      }
      setError(String(e));
      console.warn("[SessionDetail] Prompt page load failed:", e);
    } finally {
      setLoadingNextPromptPage(false);
    }
  }, [
    getCurrentPrompts,
    handleOrphanedSession,
    hydratePromptHistories,
    isCurrentSessionViewRequest,
    loadingNextPromptPage,
    mergePromptPage,
    mergeSessionMetadata,
    nextSessionViewRequestGeneration,
    normalizePromptPage,
    updatePromptPage,
    promptPage.nextCursor,
    sessionId,
  ]);

  const loadRemainingPromptPages = useCallback(async () => {
    if (loadingNextPromptPage || promptPage.nextCursor === null) return;
    setLoadingNextPromptPage(true);
    let cursor: string | null = promptPage.nextCursor;
    let mergedPrompts = getCurrentPrompts();

    try {
      while (cursor !== null) {
        const requestGeneration = nextSessionViewRequestGeneration();
        const result = await fetchSessionView(sessionId, cursor);
        if (!isCurrentSessionViewRequest(requestGeneration)) return;
        mergedPrompts = mergePromptPage(mergedPrompts, result.prompts);
        updatePromptPage(normalizePromptPage(result));
        setError(null);
        mergeSessionMetadata(result.session, mergedPrompts);
        hydratePromptHistories(result.prompts.map((prompt) => prompt.promptId));
        cursor = result.promptPage?.nextCursor ?? null;
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        handleOrphanedSession();
        return;
      }
      setError(String(e));
      console.warn("[SessionDetail] Prompt page load failed:", e);
    } finally {
      setLoadingNextPromptPage(false);
    }
  }, [
    getCurrentPrompts,
    handleOrphanedSession,
    hydratePromptHistories,
    isCurrentSessionViewRequest,
    loadingNextPromptPage,
    mergePromptPage,
    mergeSessionMetadata,
    nextSessionViewRequestGeneration,
    normalizePromptPage,
    updatePromptPage,
    promptPage.nextCursor,
    sessionId,
  ]);

  useSyncEffect(() => {
    setError(null);
    setOwnerAvatarUrl(initialOwnerAvatarUrl);
    setPromptPage((prev) =>
      prev.nextCursor === null && prev.total === null ? prev : { nextCursor: null, total: null },
    );
    setLoadingNextPromptPage(false);
    setSessionHydrated(!hasInitialSession);
    clearPromptHistoryStates();
    wsBootstrappedRef.current = false;
    wsBootstrapTimeoutElapsedRef.current = false;
    httpBootstrapStartedRef.current = false;
    historyHydrationGenerationRef.current += 1;
    historyHydrationActiveCountRef.current = 0;
    historyHydrationQueueRef.current = [];
    historyProbeInFlightRef.current = null;
    activePromptHistoryRefreshInFlightRef.current = null;
    queuedActivePromptHistoryRefreshRef.current = null;
    activePromptHistoryRefreshRequestIdRef.current = 0;
    authoritativeSessionViewLoadedRef.current = false;
    seedBootstrapFailureDeferredRef.current = false;
    sessionViewRequestGenerationRef.current += 1;
    promptHistoryInflightRef.current.clear();
    hydratedPromptIdsRef.current.clear();
    pendingBucketedPromptIdsRef.current.clear();
    queuedPromptIdsRef.current.clear();
    clearBootstrapTimeout();
    historyRequestControllerRef.current?.abort();
    historyRequestControllerRef.current = new AbortController();

    void bootstrapFromHttpRef.current();
    bootstrapTimeoutRef.current = setTimeout(() => {
      wsBootstrapTimeoutElapsedRef.current = true;
      void bootstrapFromHttpRef.current();
    }, WS_BOOTSTRAP_TIMEOUT_MS);

    startPollingRef.current();
    import("../datadog").then(({ setDatadogSessionContext }) => setDatadogSessionContext(sessionId));

    return () => {
      clearBootstrapTimeout();
      historyRequestControllerRef.current?.abort();
      historyRequestControllerRef.current = null;
      activePromptHistoryRefreshInFlightRef.current = null;
      queuedActivePromptHistoryRefreshRef.current = null;
      activePromptHistoryRefreshRequestIdRef.current += 1;
      authoritativeSessionViewLoadedRef.current = false;
      wsBootstrapTimeoutElapsedRef.current = false;
      sessionViewRequestGenerationRef.current += 1;
      historyHydrationGenerationRef.current += 1;
      historyHydrationActiveCountRef.current = 0;
      historyHydrationQueueRef.current = [];
      historyProbeInFlightRef.current = null;
      promptHistoryInflightRef.current.clear();
      hydratedPromptIdsRef.current.clear();
      pendingBucketedPromptIdsRef.current.clear();
      queuedPromptIdsRef.current.clear();
      clearPromptHistoryStates();
      stopPollingRef.current();
      import("../datadog").then(({ clearDatadogSessionContext }) => clearDatadogSessionContext());
    };
  }, [clearBootstrapTimeout, clearPromptHistoryStates, initialOwnerAvatarUrl, sessionId]);

  return {
    bootstrapFromHttp,
    clearBootstrapTimeout,
    error,
    fetchPromptHistoryWithRetry,
    fetchPromptHistoryOnce,
    hydratePromptHistories,
    loadNextPromptPage,
    loadRemainingPromptPages,
    loadingNextPromptPage,
    markPromptHistoriesSkipped,
    ownerAvatarUrl,
    promptPage,
    promptHistoryStates,
    prioritizePromptHistories,
    refresh,
    refreshActivePromptHistory,
    sessionHydrated,
    setError,
    setSessionHydrated,
    wsBootstrappedRef,
  };
}
