import { useCallback, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useSearchParams } from "react-router";

import { isPromptSendDisabled } from "../../../../shared/session/eligibility";
import type { SsoOrg } from "../../../../shared/types/bootstrap";
import type { UploadedFile, UploadedImage } from "../../../../shared/types/sandbox";
import { stringifyError } from "../../../../shared/utils/errors.js";
import {
  archiveSession,
  createChildSession,
  fetchSessionFiles,
  respondToQuestion,
  sendPrompt,
  setSessionRepo,
  stopSession,
  warmSandbox,
} from "../api/sessions";
import { fetchRepoSkills } from "../api/skills";
import { TERMINAL_FOR_FALLBACK_POLLING_PHASES } from "../constants";
import { useSyncEffect } from "../hooks/useEffects";
import { useRefetchOnActive } from "../hooks/useRefetchOnActive";
import { useSessionActionRunner } from "../hooks/useSessionActionRunner";
import { type PromptHistoryHydrationState, useSessionBootstrap } from "../hooks/useSessionBootstrap";
import { useSessionDesktopActionPath } from "../hooks/useSessionDesktopActionPath";
import { type ActivePromptHistoryRefreshSource, useSessionFallbackPolling } from "../hooks/useSessionFallbackPolling";
import { useSessionReplay } from "../hooks/useSessionReplay";
import { useSessionRepoFallback } from "../hooks/useSessionRepoFallback";
import { useSessionScreenshots } from "../hooks/useSessionScreenshots";
import { getInFlightPromptId, useSessionState } from "../hooks/useSessionState";
import { useTransientDisconnectMask } from "../hooks/useTransientDisconnectMask";
import type { ActivityEvent, PromptRow, SessionDetail } from "../types";
import { parseRepoFullNameFromUrl } from "../utils/repos";
import { getArchivedSessionBannerMessage } from "../utils/session-close-reason";
import { useConfirm } from "./ConfirmDialog";
import { ErrorBoundary, SectionErrorFallback } from "./ErrorBoundary";
import { ChevronDownIcon, DesktopIcon, PanelRightIcon } from "./icons";
import { useLayoutContext } from "./Layout";
import { PromptForm } from "./PromptForm";
import { deriveContextUsage, type RuntimeActionId } from "./session/runtime";
import { SessionArtifactDrawer } from "./session/SessionArtifactDrawer";
import { SessionArtifactWorkspace, SessionInspector } from "./session/SessionInspector";
import { SessionPrRow } from "./session/SessionPrRow";
import { SessionRuntimeStrip } from "./session/SessionRuntimeStrip";
import { SessionDesktopWorkbench } from "./SessionDesktopWorkbench";
import { SessionHeader } from "./SessionHeader";
import { SessionProgressProvider } from "./SessionProgressIndicator";
import { SessionStickyBar } from "./SessionStickyBar";
import { SessionTurn } from "./SessionTurn";
import { SsoOrgsNotice } from "./SsoOrgsNotice";
import { useToast } from "./Toast";
import { Button, buttonClasses, IconButton, Select } from "./ui";

const EMPTY_ACTIVITY_EVENTS: ActivityEvent[] = [];
const XL_MEDIA_QUERY = "(min-width: 1280px)";

function useBelowXl(): boolean {
  const [belowXl, setBelowXl] = useState(() =>
    typeof window === "undefined" || typeof window.matchMedia !== "function"
      ? true
      : !window.matchMedia(XL_MEDIA_QUERY).matches,
  );
  useSyncEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(XL_MEDIA_QUERY);
    const update = () => setBelowXl(!media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return belowXl;
}

function useSessionPageOpenWarmup({
  disabled,
  phase,
  sessionId,
  stopMode,
}: {
  disabled: boolean;
  phase: SessionDetail["phase"] | undefined;
  sessionId: string;
  stopMode: SessionDetail["stopMode"] | undefined;
}) {
  const warmedRef = useRef<{ sessionId: string; warmed: boolean } | null>(null);

  useSyncEffect(() => {
    if (warmedRef.current?.sessionId !== sessionId) {
      warmedRef.current = { sessionId, warmed: false };
    }
    const canWarmOnOpen = phase === "idle" || (phase === "stopped" && stopMode !== "user");
    if (!canWarmOnOpen) {
      if (warmedRef.current) warmedRef.current.warmed = false;
      return;
    }
    if (disabled || warmedRef.current?.warmed) return;
    warmedRef.current.warmed = true;
    warmSandbox(sessionId, "page_open");
  }, [disabled, phase, sessionId, stopMode]);
}

function resolveSessionScrollRoot(container: HTMLElement | null): HTMLElement | null {
  let current: HTMLElement | null = container;
  while (current) {
    const style = window.getComputedStyle(current);
    const canScroll = current.scrollHeight - current.clientHeight > 1;
    const scrollsVertically =
      style.overflowY === "auto" || style.overflowY === "scroll" || style.overflowY === "overlay";
    if (canScroll && scrollsVertically) return current;
    current = current.parentElement;
  }
  if (typeof document === "undefined") return null;
  return document.scrollingElement instanceof HTMLElement
    ? document.scrollingElement
    : document.documentElement instanceof HTMLElement
      ? document.documentElement
      : null;
}

function mergeSsoOrgs(...groups: Array<SsoOrg[] | undefined>): SsoOrg[] {
  const byOrgId = new Map<number, SsoOrg>();
  for (const group of groups) {
    if (!group) continue;
    for (const org of group) {
      byOrgId.set(org.orgId, org);
    }
  }
  return Array.from(byOrgId.values());
}

type Props = {
  sessionId: string;
  initialSession?: SessionDetail;
};

/**
 * True when a session's content has painted (session loaded + at least one
 * prompt turn rendered) and we have not yet recorded the first-content timing
 * for this sessionId. Gates the once-per-session `session_first_content` RUM
 * timing so navigating between sessions in the same mount re-arms it.
 */
function shouldReportFirstContent(
  reportedSessionId: string | null,
  currentSessionId: string,
  hasSession: boolean,
  promptCount: number,
): boolean {
  return hasSession && promptCount > 0 && reportedSessionId !== currentSessionId;
}

function SessionConversationSkeleton({ className = "" }: { className?: string }) {
  return (
    <div
      data-session-conversation-skeleton
      className={`space-y-4 motion-safe:animate-pulse ${className}`.trim()}
      aria-hidden
    >
      <div className="session-stack-surface h-24" />
      <div className="session-stack-surface h-32" />
      <div className="session-stack-surface h-20" />
    </div>
  );
}

export function shouldShowTranscriptHydrationPending(
  promptHistoryState: PromptHistoryHydrationState | null,
  prompt: Pick<PromptRow, "result" | "status">,
  transcriptEventCount: number,
): boolean {
  return (
    (promptHistoryState === "pending" || promptHistoryState === "skipped_due_to_truncation") &&
    (prompt.result !== null || prompt.status === "completed" || prompt.status === "failed") &&
    transcriptEventCount === 0
  );
}

function shouldOpenDesktopPaneByDefault(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(min-width: 1280px)").matches;
}

export function SessionDetailView({ sessionId, initialSession }: Props) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const belowXl = useBelowXl();
  const artifactTriggerRef = useRef<HTMLButtonElement | null>(null);
  const {
    setSessions,
    patchSession,
    models,
    repos,
    reposLoaded,
    reposError,
    ssoOrgs,
    refreshingRepos,
    refreshRepos,
    refreshSessions,
    user,
    capabilities,
    notifySessionListSync,
  } = useLayoutContext();
  const {
    state: { session: rawSession, prompts, transcripts, incompletePromptIds, prError, tokenUsage },
    dispatch: dispatchSessionState,
    stateRef,
    initializeSessionData,
    mergeSessionMetadata,
    ingestReplayPage,
    applyPromptHistoryFetchResult,
    updateSession,
    setPrUpdated,
    answerLatestQuestion,
    getActivePromptId: getCurrentActivePromptId,
  } = useSessionState({ sessionId, initialSession });
  const session = useTransientDisconnectMask(rawSession);
  const qaChildSessionId = session?.qaRun?.childSessionId ?? session?.qaChildSessionId;
  const qaTestSessionUrl = qaChildSessionId ? `/sessions/${qaChildSessionId}` : null;
  const canTriggerQaVerification = Boolean(session?.prUrl && session.repoUrl);
  const [sessionActionInFlight, setSessionActionInFlight] = useState<RuntimeActionId | null>(null);
  const [qaVerificationLoading, setQaVerificationLoading] = useState(false);
  const [qaVerificationError, setQaVerificationError] = useState<string | null>(null);
  const [resumeSubmitPending, setResumeSubmitPending] = useState(false);
  const composerContainerRef = useRef<HTMLDivElement>(null);
  const [desktopPaneOpen, setDesktopPaneOpen] = useState(shouldOpenDesktopPaneByDefault);
  const lastSidebarSyncSnapshotRef = useRef<{
    sessionId: string;
    snapshot: string;
    verificationSnapshot: string;
  } | null>(null);
  const authenticated = user === undefined ? undefined : !!user;
  const userId = user?.id ?? null;
  const userLogin = user?.login ?? null;
  const avatarUrl = user?.avatarUrl ?? null;
  const isSupportView = Boolean(user?.impersonation?.readOnly);
  const ownerLogin = session?.ownerLogin ?? null;

  const focusComposer = useCallback(() => {
    const composer = composerContainerRef.current?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]');
    composer?.focus();
    composer?.scrollIntoView({ block: "nearest" });
  }, []);
  useSyncEffect(() => {
    setDesktopPaneOpen(false);
  }, [sessionId]);

  const refreshRef = useRef<(source?: ActivePromptHistoryRefreshSource) => Promise<void>>(async () => undefined);
  const { aggressiveFallbackActiveRef, clearPolling, startAggressiveFallbackPolling, startResiliencePolling } =
    useSessionFallbackPolling({
      refreshRef,
      sessionPhase: rawSession?.phase,
    });

  const {
    bootstrapFromHttp,
    clearBootstrapTimeout,
    error,
    fetchPromptHistoryWithRetry,
    hydratePromptHistories,
    loadNextPromptPage = async () => undefined,
    loadRemainingPromptPages = async () => undefined,
    loadingNextPromptPage = false,
    markPromptHistoriesSkipped,
    ownerAvatarUrl,
    promptPage = { nextCursor: null, total: null },
    promptHistoryStates,
    prioritizePromptHistories,
    refresh,
    refreshActivePromptHistory,
    sessionHydrated,
    setError,
    setSessionHydrated,
    wsBootstrappedRef,
  } = useSessionBootstrap({
    applyPromptHistoryFetchResult,
    getCurrentPrompts: () => stateRef.current.prompts,
    initialSession,
    initializeSessionData,
    mergeSessionMetadata,
    navigate,
    sessionId,
    setSessions,
    startPolling: startResiliencePolling,
    stopPolling: clearPolling,
  });
  const ownerPromptAvatarUrl = session?.ownerAvatarUrl ?? ownerAvatarUrl ?? avatarUrl;
  refreshRef.current = refresh;

  // Recover the open session's state when the tab returns to the foreground
  // (sleep/resume, tab switch, desktop app switch). The per-session resilience
  // poll already covers the steady state; this is the immediate refresh on
  // return so a backgrounded tab is not left showing stale session data. A
  // settled session does not change, so skip it for terminal phases -- the same
  // contract useSessionFallbackPolling uses to stop the per-session poll.
  const sessionPhase = rawSession?.phase;
  useRefetchOnActive({
    enabled: !!sessionPhase && !TERMINAL_FOR_FALLBACK_POLLING_PHASES.has(sessionPhase),
    onActive: () => {
      void refresh();
    },
  });

  const { runSessionAction } = useSessionActionRunner<RuntimeActionId>({
    refresh,
    setError,
    actionInFlight: sessionActionInFlight,
    setActionInFlight: setSessionActionInFlight,
  });

  const computerUseEnabled = capabilities?.computerUse === true;
  const desktopActionPath = useSessionDesktopActionPath(sessionId, { enabled: computerUseEnabled });

  const { loadingOlderEvents, scrollContainerRef, topSentinelRef } = useSessionReplay({
    applyPromptHistoryFetchResult,
    aggressiveFallbackActiveRef,
    bootstrapFromHttp,
    clearBootstrapTimeout,
    clearPolling,
    dispatchSessionState,
    fetchPromptHistoryOnce: (promptId, signal) =>
      fetchPromptHistoryWithRetry(promptId, {
        signal,
        source: "live_completion",
        retryOnce: true,
        markIncompleteOnFailure: true,
      }),
    getCurrentActivePromptId,
    hydratePromptHistories,
    ingestReplayPage,
    markPromptHistoriesSkipped,
    mergeSessionMetadata,
    models,
    onDesktopActionPathRow: computerUseEnabled ? desktopActionPath.ingestLiveRow : undefined,
    refreshDesktopActionPathSnapshot: computerUseEnabled ? desktopActionPath.refreshSnapshot : undefined,
    refresh,
    refreshActivePromptHistory,
    session: rawSession,
    sessionId,
    setError,
    setSessionHydrated,
    setSessions,
    refreshSessions,
    startAggressiveFallbackPolling,
    startResiliencePolling,
    stateRef,
    transcripts,
    updateSession,
    wsBootstrappedRef,
  });

  const {
    effectiveRepos,
    effectiveReposError,
    effectiveReposLoaded,
    fallbackSsoOrgs = [],
  } = useSessionRepoFallback({
    authenticated,
    repos,
    reposError,
    reposLoaded,
    session,
  });
  const effectiveSsoOrgs = useMemo(() => mergeSsoOrgs(ssoOrgs, fallbackSsoOrgs), [ssoOrgs, fallbackSsoOrgs]);

  const loadSessionFiles = useCallback(() => fetchSessionFiles(sessionId), [sessionId]);
  const loadSessionSkills = useCallback(async () => {
    const repoUrl = session?.repoUrl;
    if (!repoUrl) return [];
    const matchedRepo = repos.find((repo) => repo.url === repoUrl);
    const parsed =
      (matchedRepo ? parseRepoFullNameFromUrl(matchedRepo.fullName) : null) ?? parseRepoFullNameFromUrl(repoUrl);
    if (!parsed) return [];
    return fetchRepoSkills(parsed.owner, parsed.repo);
  }, [repos, session?.repoUrl]);

  // Agent screenshots grouped by promptId; each SessionTurn pulls its slice
  // and renders thumbnails inline beneath its transcript. MUST be called
  // before the early returns below (Rules of Hooks) — otherwise deep-linking
  // to a session URL crashes with React error #310 because the hook is
  // skipped on the initial render (session not yet loaded) then called on
  // the second render. The hook tolerates undefined sessionStatus during
  // the initial loading state.
  const agentScreenshotsByPrompt = useSessionScreenshots(sessionId, session?.phase);

  useSyncEffect(() => {
    if (!resumeSubmitPending) return;
    // Pending while we wait for either the resumable-stopped state to clear or
    // the new sandbox to spin up (running + creating). Both transition us out
    // of the pending banner. Matches the server's resumable-vs-hard-stop split
    // (`stopMode !== "user"`) so an undefined stopMode during the optimistic
    // window doesn't drop us out of the pending state.
    if (session?.phase === "stopped" && session.stopMode !== "user") return;
    if (session?.phase === "running" && session.sandboxSubstate === "creating") return;
    setResumeSubmitPending(false);
  }, [resumeSubmitPending, session?.phase, session?.stopMode, session?.sandboxSubstate]);

  // Mirror the active session's status and prUrl into the sidebar's
  // SessionMetadata cache so the sidebar row updates live alongside the
  // detail view. Without this, the row stays stale until the user clicks
  // away and back. Scoped to the active session only — sidebar entries
  // for other sessions still rely on next refetch.
  useSyncEffect(() => {
    if (!session) return;
    const verificationSnapshot = JSON.stringify({
      verificationState: session.verificationState ?? null,
      verificationResult: session.verificationResult ?? null,
      verificationNeedsWorkLabel: session.verificationNeedsWorkLabel ?? null,
      verificationAttemptCount: session.verificationAttemptCount ?? null,
      verificationMaxAttempts: session.verificationMaxAttempts ?? null,
    });
    const sidebarSyncSnapshot = JSON.stringify({
      sessionId: session.sessionId,
      phase: session.phase,
      prUrl: session.prUrl,
      reviewLoopDoneState: session.reviewLoopDoneState ?? null,
      verificationState: session.verificationState ?? null,
      verificationResult: session.verificationResult ?? null,
      verificationNeedsWorkLabel: session.verificationNeedsWorkLabel ?? null,
      verificationAttemptCount: session.verificationAttemptCount ?? null,
      verificationMaxAttempts: session.verificationMaxAttempts ?? null,
    });
    const verificationChanged =
      lastSidebarSyncSnapshotRef.current?.sessionId !== session.sessionId ||
      lastSidebarSyncSnapshotRef.current.verificationSnapshot !== verificationSnapshot;
    patchSession(session.sessionId, {
      phase: session.phase,
      prUrl: session.prUrl,
      reviewLoopDoneState: session.reviewLoopDoneState ?? null,
      verificationState: session.verificationState ?? null,
      verificationResult: session.verificationResult ?? null,
      verificationNeedsWorkLabel: session.verificationNeedsWorkLabel ?? null,
      ...(session.verificationAttemptCount !== undefined
        ? { verificationAttemptCount: session.verificationAttemptCount }
        : {}),
      ...(session.verificationMaxAttempts !== undefined
        ? { verificationMaxAttempts: session.verificationMaxAttempts }
        : {}),
      ...(verificationChanged ? { lastLiveVerificationPatchAt: Date.now() } : {}),
    });
    if (lastSidebarSyncSnapshotRef.current?.sessionId !== session.sessionId) {
      lastSidebarSyncSnapshotRef.current = {
        sessionId: session.sessionId,
        snapshot: sidebarSyncSnapshot,
        verificationSnapshot,
      };
      return;
    }
    if (lastSidebarSyncSnapshotRef.current.snapshot === sidebarSyncSnapshot) return;
    lastSidebarSyncSnapshotRef.current = {
      sessionId: session.sessionId,
      snapshot: sidebarSyncSnapshot,
      verificationSnapshot,
    };
    notifySessionListSync();
  }, [
    session?.sessionId,
    session?.phase,
    session?.prUrl,
    session?.reviewLoopDoneState,
    session?.verificationState,
    session?.verificationResult,
    session?.verificationNeedsWorkLabel,
    session?.verificationAttemptCount,
    session?.verificationMaxAttempts,
    patchSession,
    notifySessionListSync,
  ]);

  async function handlePrompt(payload: {
    prompt: string;
    skills?: string[];
    files?: string[];
    uploadedFiles?: UploadedFile[];
    uploadedImages?: UploadedImage[];
    reasoningEffort?: string;
  }) {
    if (!session) return;
    if (isSupportView) return;
    if (
      isPromptSendDisabled(
        session.phase,
        session.stopMode,
        session.sandboxSubstate,
        session.planApprovalPending ?? false,
      )
    )
      return;
    const isResumableStop = session.phase === "stopped" && session.stopMode !== "user";

    try {
      const resumableSubmit = isResumableStop;
      if (resumableSubmit) {
        setResumeSubmitPending(true);
      }
      const promptOptions = payload.skills?.length ? { skills: payload.skills } : undefined;
      await sendPrompt(
        sessionId,
        payload.prompt,
        payload.files,
        payload.uploadedFiles,
        payload.uploadedImages,
        undefined,
        promptOptions,
      );
      await refresh();
    } catch (e) {
      setResumeSubmitPending(false);
      setError(String(e));
      throw e;
    }
  }

  const promptPlaceholder =
    resumeSubmitPending && session?.phase === "running" && session.sandboxSubstate === "creating"
      ? "Resuming session…"
      : session?.phase === "idle" && session.userStopped
        ? "Context kept — add what you missed…"
        : undefined;

  async function handleTriggerQaVerification() {
    if (!session?.prUrl || !session.repoUrl || isSupportView) return;
    const repository = parseRepoFullNameFromUrl(session.repoUrl);
    if (!repository) {
      setQaVerificationError("Could not determine repository for QA verification.");
      return;
    }
    setQaVerificationLoading(true);
    setQaVerificationError(null);
    try {
      const prompt = [
        "qa=true",
        "",
        `Verify the pull request: ${session.prUrl}`,
        "",
        "First emit the Phase 1 VerificationPlannerArtifact. The planner decides whether QA can be skipped or must run, whether runtime evidence is needed, and the required proof contract. Do not start app/runtime services during the planner step.",
      ].join("\n");
      const result = await createChildSession(sessionId, {
        prompt,
        repositoryId: `${repository.owner}/${repository.repo}`,
        model: session.model ?? undefined,
        qa: true,
        targetPrUrl: session.prUrl,
        forceNewSession: true,
      });
      await refreshSessions();
      await refresh();
      navigate(`/sessions/${result.childSessionId}`);
    } catch (error) {
      setQaVerificationError(stringifyError(error));
    } finally {
      setQaVerificationLoading(false);
    }
  }

  async function performRuntimeAction(action: RuntimeActionId) {
    if (isSupportView || sessionActionInFlight) return;
    setSessionActionInFlight(action);
    try {
      if (action === "stop") {
        await stopSession(sessionId);
        toast("Session stopped", { variant: "success" });
      } else if (action === "archive") {
        await archiveSession(sessionId);
        toast("Session archived", { variant: "success" });
      } else {
        warmSandbox(sessionId);
        toast("Warming sandbox");
      }
      await refresh();
    } catch (error) {
      toast(stringifyError(error), { variant: "error" });
    } finally {
      setSessionActionInFlight(null);
    }
  }

  // The single confirm idiom for session-lifecycle actions: header Stop and
  // the Runtime panel's actions all route through here, so every destructive
  // path shares the same useConfirm dialog. Stop is resumable — the confirm
  // exists because it interrupts in-flight work, not because it is
  // unrecoverable; archive is the destructive one.
  async function handleRuntimeAction(action: RuntimeActionId) {
    if (isSupportView) return;
    if (action === "stop") {
      // The PR clause only appears when a PR actually exists — otherwise it
      // reads as a warning about an object the session never produced.
      const confirmed = await confirm({
        message: session?.prUrl
          ? "Stop this session? You can send a new prompt to resume. Any open PR stays open."
          : "Stop this session? You can send a new prompt to resume.",
        confirmLabel: "Stop session",
      });
      if (!confirmed) return;
    } else if (action === "archive") {
      const confirmed = await confirm({
        message: "Archive this session? This closes the session permanently.",
        confirmLabel: "Archive",
        destructive: true,
      });
      if (!confirmed) return;
    }
    await performRuntimeAction(action);
  }

  async function handleRepoSelect(repoUrl: string) {
    if (isSupportView) return;
    await runSessionAction({
      action: () => {
        const repo = effectiveRepos.find((r) => r.url === repoUrl);
        return setSessionRepo(sessionId, repoUrl, repo?.defaultBranch);
      },
    });
  }

  const handleAnswer = useCallback(
    async (questionId: string, answer: string) => {
      if (isSupportView) return;
      await runSessionAction({
        action: () => respondToQuestion(sessionId, answer, questionId),
        onSuccess: () => {
          answerLatestQuestion(answer);
        },
        refreshOnSuccess: false,
      });
    },
    [answerLatestQuestion, isSupportView, runSessionAction, sessionId],
  );

  const decoratedPrompts = useMemo(() => {
    return prompts.map((prompt) => {
      const isCurrentUserActor = prompt.actorUserId != null && String(userId) === String(prompt.actorUserId);
      if (isCurrentUserActor) {
        return {
          ...prompt,
          actorLogin: prompt.actorLogin ?? userLogin,
          actorAvatarUrl: prompt.actorAvatarUrl ?? avatarUrl,
        };
      }

      const isOwnerActor = prompt.actorUserId == null;
      if (isOwnerActor) {
        return {
          ...prompt,
          actorLogin: prompt.actorLogin ?? ownerLogin,
          actorAvatarUrl: prompt.actorAvatarUrl ?? ownerPromptAvatarUrl,
        };
      }

      return prompt;
    });
  }, [prompts, userId, userLogin, ownerLogin, ownerPromptAvatarUrl, avatarUrl]);
  const promptTurnNodesRef = useRef(new Map<string, HTMLDivElement>());
  const promptVisibilityObserverRef = useRef<IntersectionObserver | null>(null);
  const headerVisibilitySentinelRef = useRef<HTMLDivElement | null>(null);
  const [sessionHeaderVisible, setSessionHeaderVisible] = useState(true);
  const [visiblePromptIds, setVisiblePromptIds] = useState<Set<string>>(new Set());
  const decoratedPromptIds = useMemo(() => decoratedPrompts.map((prompt) => prompt.promptId), [decoratedPrompts]);
  // Latest known context-window usage from streamed events; shared by the
  // composer runtime strip and the inspector's Runtime tab.
  const runtimeContextUsage = useMemo(
    () => deriveContextUsage(decoratedPromptIds, transcripts),
    [decoratedPromptIds, transcripts],
  );
  const openArtifacts = useCallback(
    (trigger: HTMLButtonElement) => {
      artifactTriggerRef.current = trigger;
      setSearchParams(
        (current) => {
          const updated = new URLSearchParams(current);
          if (!updated.get("artifact")) updated.set("artifact", "summary");
          return updated;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  const closeArtifacts = useCallback(() => {
    setSearchParams(
      (current) => {
        const updated = new URLSearchParams(current);
        updated.delete("artifact");
        return updated;
      },
      { replace: true },
    );
  }, [setSearchParams]);
  const artifactDrawerOpen = belowXl && searchParams.has("artifact");
  const inFlightPromptId = useMemo(() => getInFlightPromptId(decoratedPrompts), [decoratedPrompts]);
  const decoratedPromptIdsKey = decoratedPromptIds.join("\n");

  const registerPromptTurnNode = useCallback((promptId: string, node: HTMLDivElement | null) => {
    const previousNode = promptTurnNodesRef.current.get(promptId);
    if (previousNode && previousNode !== node) {
      promptVisibilityObserverRef.current?.unobserve(previousNode);
      promptTurnNodesRef.current.delete(promptId);
    }

    if (!node) return;
    promptTurnNodesRef.current.set(promptId, node);
    promptVisibilityObserverRef.current?.observe(node);
  }, []);

  useSyncEffect(() => {
    const promptIds = new Set(decoratedPromptIds);
    promptTurnNodesRef.current.forEach((node, promptId) => {
      if (promptIds.has(promptId)) return;
      promptVisibilityObserverRef.current?.unobserve(node);
      promptTurnNodesRef.current.delete(promptId);
    });
    setVisiblePromptIds((prev) => {
      const next = new Set(Array.from(prev).filter((promptId) => promptIds.has(promptId)));
      return next.size === prev.size ? prev : next;
    });
  }, [decoratedPromptIdsKey]);

  useSyncEffect(() => {
    if (decoratedPromptIds.length === 0 || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        setVisiblePromptIds((prev) => {
          let changed = false;
          const next = new Set(prev);
          for (const entry of entries) {
            const promptId = (entry.target as HTMLElement).dataset.promptId;
            if (!promptId) continue;
            if (entry.isIntersecting) {
              if (!next.has(promptId)) {
                next.add(promptId);
                changed = true;
              }
            } else if (next.delete(promptId)) {
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      { root: null, rootMargin: "300px 0px 300px 0px" },
    );

    promptVisibilityObserverRef.current = observer;
    for (const promptId of decoratedPromptIds) {
      const node = promptTurnNodesRef.current.get(promptId);
      if (node) observer.observe(node);
    }

    return () => {
      observer.disconnect();
      if (promptVisibilityObserverRef.current === observer) {
        promptVisibilityObserverRef.current = null;
      }
    };
  }, [decoratedPromptIdsKey]);

  const [sessionScrollContainerEl, setSessionScrollContainerEl] = useState<HTMLDivElement | null>(null);
  const setSessionScrollContainerNode = useCallback(
    (node: HTMLDivElement | null) => {
      scrollContainerRef(node);
      setSessionScrollContainerEl(node);
    },
    [scrollContainerRef],
  );

  useSyncEffect(() => {
    const headerNode = headerVisibilitySentinelRef.current;
    const scrollNode = sessionScrollContainerEl;
    if (!headerNode || !scrollNode || typeof IntersectionObserver === "undefined") {
      setSessionHeaderVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        setSessionHeaderVisible(entry?.isIntersecting ?? true);
      },
      { root: scrollNode, threshold: 0 },
    );
    observer.observe(headerNode);

    return () => {
      observer.disconnect();
    };
  }, [session?.sessionId, sessionScrollContainerEl]);

  const scrollToBottomNow = useCallback(() => {
    const root = resolveSessionScrollRoot(sessionScrollContainerEl);
    if (!root) return;
    root.scrollTop = root.scrollHeight;
  }, [sessionScrollContainerEl]);
  const scrollToBottom = useCallback(() => {
    void (async () => {
      await loadRemainingPromptPages();
      requestAnimationFrame(scrollToBottomNow);
    })();
  }, [loadRemainingPromptPages, scrollToBottomNow]);

  const visiblePromptHydrationOrder = useMemo(
    () => decoratedPromptIds.filter((promptId) => visiblePromptIds.has(promptId)),
    [decoratedPromptIds, visiblePromptIds],
  );
  const prioritizedPromptHydrationOrder = useMemo(() => {
    const activePromptId = inFlightPromptId;
    if (!activePromptId) return visiblePromptHydrationOrder;
    return [activePromptId, ...visiblePromptHydrationOrder.filter((promptId) => promptId !== activePromptId)];
  }, [inFlightPromptId, visiblePromptHydrationOrder]);

  useSyncEffect(() => {
    prioritizePromptHistories(prioritizedPromptHydrationOrder);
  }, [prioritizePromptHistories, prioritizedPromptHydrationOrder]);

  // Record session-open -> first-paint latency once per session. Fires in a
  // post-commit effect (content is on screen) and re-arms when sessionId changes.
  const firstContentReportedRef = useRef<string | null>(null);
  useSyncEffect(() => {
    if (
      !shouldReportFirstContent(firstContentReportedRef.current, sessionId, Boolean(session), decoratedPrompts.length)
    )
      return;
    firstContentReportedRef.current = sessionId;
    // Capture the paint timestamp now (epoch ms) so the timing reflects this
    // moment, not whenever the lazy Datadog import / RUM init resolves.
    const paintEpochMs = Date.now();
    void import("../datadog").then(({ addSessionTiming }) => addSessionTiming("session_first_content", paintEpochMs));
  }, [sessionId, session, decoratedPrompts.length]);

  const showingSeedState = !sessionHydrated;
  const needsRepo = Boolean(sessionHydrated && session && !session.repoUrl);
  useSessionPageOpenWarmup({
    disabled: isSupportView || needsRepo,
    phase: session?.phase,
    sessionId,
    stopMode: session?.stopMode,
  });

  if (error)
    return (
      <div className="mx-auto w-full max-w-[72rem] px-4 py-16">
        <div role="alert" className="session-stack-surface mx-auto max-w-md p-6 text-center">
          <p className="text-lg font-medium text-text-primary">Couldn&rsquo;t load this session</p>
          <Button type="button" onClick={() => void refresh()} variant="primary" size="md" className="mt-4">
            Retry
          </Button>
          <details className="mt-4 text-left">
            <summary className="cursor-pointer text-sm text-text-muted">Details</summary>
            <p className="mt-1.5 break-words whitespace-pre-wrap text-sm text-text-muted">{error}</p>
          </details>
        </div>
      </div>
    );
  if (!session)
    return (
      <>
        <span role="status" className="sr-only">
          Loading session…
        </span>
        <div
          className="mx-auto w-full max-w-[72rem] motion-safe:animate-pulse px-4 md:px-10 pt-8 md:pt-14 pb-8"
          aria-hidden
        >
          <div className="h-8 w-2/3 max-w-md bg-surface-2" />
          <div className="mt-6 h-4 w-40 bg-surface-2" />
          <div className="mt-10 space-y-4">
            <div className="session-stack-surface h-24" />
            <div className="session-stack-surface h-32" />
            <div className="session-stack-surface h-20" />
          </div>
        </div>
      </>
    );

  const archivedBannerMessage = getArchivedSessionBannerMessage(session.closeReason);
  // Tonal elevation only: the fixed wrapper owns the surface step + 1px
  // border; the IconButton inside stays the standard ghost square.
  const scrollToBottomControl = (
    <span className="fixed bottom-6 right-6 z-30 inline-flex border border-border bg-surface-1">
      <IconButton label="Scroll to bottom" size="md" onClick={scrollToBottom}>
        <ChevronDownIcon />
      </IconButton>
    </span>
  );
  const desktopActionCount = desktopActionPath.rows.length;
  const desktopViewLabel =
    desktopActionCount > 0
      ? `Desktop view, ${desktopActionCount} action${desktopActionCount === 1 ? "" : "s"}`
      : "Desktop view";

  return (
    <div className="flex h-full min-h-0 w-full">
      {createPortal(scrollToBottomControl, document.body)}
      {/* Session column self-pads (16px mobile / 40px desktop gutters) to match
          the .control-room-content page rhythm now that Layout renders p-0. */}
      <div className="mx-auto flex h-full min-h-0 w-full min-w-0 max-w-[72rem] flex-1 flex-col px-4 md:px-10 xl:min-w-[32rem]">
        <div
          ref={setSessionScrollContainerNode}
          data-session-scroll-container
          className="flex-1 min-h-0 overflow-y-auto"
        >
          <SessionStickyBar
            session={session}
            hydrated={sessionHydrated}
            visible={!sessionHeaderVisible}
            onViewPr={() => setPrUpdated(false)}
          />
          {belowXl && (!desktopPaneOpen || !sessionHeaderVisible) && (
            <div
              className={
                sessionHeaderVisible
                  ? "mb-3 flex justify-end gap-2"
                  : "sticky top-12 z-20 flex h-0 justify-end gap-2 pr-2"
              }
            >
              {computerUseEnabled && !desktopPaneOpen ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  aria-expanded={desktopPaneOpen}
                  aria-label={desktopViewLabel}
                  onClick={() => setDesktopPaneOpen(true)}
                >
                  <DesktopIcon className="h-4 w-4" />
                  Desktop view
                  {desktopActionCount > 0 ? (
                    <span className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-2xs text-text-muted">
                      {desktopActionCount}
                    </span>
                  ) : null}
                </Button>
              ) : null}
              {!sessionHeaderVisible ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={(event) => openArtifacts(event.currentTarget)}
                >
                  Details
                </Button>
              ) : null}
            </div>
          )}
          {/* Header */}
          <div ref={headerVisibilitySentinelRef} className="editorial-rise editorial-rise-1">
            <SessionHeader
              session={session}
              onStop={() => void handleRuntimeAction("stop")}
              readOnly={isSupportView}
              hydrated={sessionHydrated}
              onOpenArtifacts={belowXl ? openArtifacts : undefined}
            />
          </div>

          {/* Repo selection */}
          {needsRepo && !isSupportView && (
            <div className="session-stack-surface mb-6 p-6">
              {authenticated === undefined && <div className="text-sm text-text-muted">Checking authentication…</div>}
              {authenticated === false && (
                <div>
                  <p className="text-sm font-medium text-text-primary mb-3">Connect a repository</p>
                  <a
                    href="/auth/github"
                    className={buttonClasses({
                      variant: "secondary",
                      size: "lg",
                      className: "bg-surface-2 px-4 hover:bg-surface-3",
                    })}
                  >
                    Connect GitHub
                  </a>
                </div>
              )}
              {authenticated && (
                <div>
                  <label htmlFor="session-repo-select" className="block text-sm font-medium text-text-primary mb-3">
                    Connect a repository
                  </label>
                  <SsoOrgsNotice
                    ssoOrgs={effectiveSsoOrgs}
                    onRefresh={refreshRepos}
                    refreshing={refreshingRepos}
                    className="mb-4"
                  />
                  {!effectiveReposLoaded ? (
                    <div className="text-sm text-text-muted">Loading repos…</div>
                  ) : effectiveReposError ? (
                    <div className="text-sm text-error">{effectiveReposError}</div>
                  ) : (
                    <Select id="session-repo-select" defaultValue="" onChange={(e) => handleRepoSelect(e.target.value)}>
                      <option value="" disabled>
                        Choose a repo…
                      </option>
                      {effectiveRepos.map((r) => (
                        <option key={r.url} value={r.url}>
                          {r.fullName}
                          {r.private ? " (private)" : ""}
                        </option>
                      ))}
                    </Select>
                  )}
                  <p className="mt-3 text-sm text-text-secondary">
                    Repository not listed?{" "}
                    <Link to="/settings/integrations" className="text-accent hover:underline">
                      Manage repository access
                    </Link>
                  </p>
                </div>
              )}
            </div>
          )}

          {session.phase === "archived" && (
            <div className="session-stack-surface mb-6 px-4 py-3">
              <p className="max-w-2xl text-sm text-text-secondary">{archivedBannerMessage}</p>
            </div>
          )}

          {/* Prompt history */}
          <SessionProgressProvider
            value={{
              phase: session.phase,
              finalizingStep: session.finalizingStep ?? null,
              queueLength: session.queueLength,
            }}
          >
            <ErrorBoundary
              fallback={({ error, resetError }) => (
                <SectionErrorFallback error={error} resetError={resetError} label="Conversation" />
              )}
              boundary="conversation"
            >
              {/* Thread region: mounts once per session (key={id} remount);
                  streaming events re-render children without remounting this
                  wrapper, so the rise plays only on page entrance. */}
              <div className="editorial-rise editorial-rise-2 mb-6">
                {showingSeedState && (
                  <>
                    <span role="status" className="sr-only">
                      Loading session details…
                    </span>
                    <SessionConversationSkeleton className="mt-2" />
                  </>
                )}
                {!showingSeedState && prompts.length === 0 && (
                  <div className="text-sm text-text-muted">No prompts yet.</div>
                )}
                {loadingOlderEvents && (
                  <div className="flex items-center justify-center py-3 text-xs text-text-muted">
                    Loading earlier messages…
                  </div>
                )}
                <div ref={topSentinelRef} className="h-px" />
                {decoratedPrompts.map((prompt) => {
                  const isOwnerActor = prompt.actorUserId == null;
                  const transcriptEvents = transcripts.get(prompt.promptId) ?? EMPTY_ACTIVITY_EVENTS;
                  const promptHistoryState = promptHistoryStates.get(prompt.promptId) ?? null;
                  const transcriptHydrationPending = shouldShowTranscriptHydrationPending(
                    promptHistoryState,
                    prompt,
                    transcriptEvents.length,
                  );
                  return (
                    <div
                      key={prompt.promptId}
                      ref={(node) => registerPromptTurnNode(prompt.promptId, node)}
                      data-prompt-id={prompt.promptId}
                      /* Keyed by promptId, so a turn mounts once and stays
                         mounted while its transcript streams — the fade plays
                         only when a new turn arrives, never per event. */
                      className="editorial-fade"
                    >
                      <SessionTurn
                        prompt={prompt}
                        transcriptEvents={transcriptEvents}
                        isInFlightTurn={prompt.promptId === inFlightPromptId}
                        transcriptHydrationPending={transcriptHydrationPending}
                        transcriptMayBeIncomplete={incompletePromptIds.has(prompt.promptId)}
                        fallbackAvatarUrl={isOwnerActor ? ownerPromptAvatarUrl : null}
                        sessionPhase={session.phase}
                        planApprovalPending={session.planApprovalPending ?? false}
                        planRevision={session.planRevision ?? null}
                        planStatus={session.planStatus ?? null}
                        planAutoReason={session.planAutoReason ?? null}
                        onDiscussPlan={isSupportView ? null : focusComposer}
                        repoOwner={session.repoOwner ?? null}
                        repoName={session.repoName ?? null}
                        agentScreenshots={agentScreenshotsByPrompt.get(prompt.promptId)}
                        onAnswerQuestion={isSupportView ? undefined : handleAnswer}
                        supportView={isSupportView}
                      />
                    </div>
                  );
                })}
                {promptPage.nextCursor !== null && (
                  <div className="flex justify-center py-4">
                    <Button
                      type="button"
                      onClick={() => void loadNextPromptPage()}
                      disabled={loadingNextPromptPage}
                      variant="secondary"
                      size="sm"
                    >
                      {loadingNextPromptPage ? "Loading…" : "Load more prompts"}
                    </Button>
                  </div>
                )}
              </div>
            </ErrorBoundary>
          </SessionProgressProvider>

          {/* The thread shows PR state; the PR object (actions, QA verify,
              review loop) lives on the PR artifact tab. */}
          <SessionPrRow session={session} prError={prError} />
        </div>
        {/* Composer area - pinned at bottom, outside scroll */}
        <div className="bg-surface-0 pt-2 pb-2 -mx-1 px-1">
          <div className="flex items-start gap-3">
            <div className="w-6 shrink-0" aria-hidden="true" />
            <div ref={composerContainerRef} className="min-w-0 flex-1">
              {sessionHydrated && !session.prUrl && (
                <SessionRuntimeStrip session={session} contextUsage={runtimeContextUsage} tokenUsage={tokenUsage} />
              )}
              {isSupportView ? (
                <div className="session-stack-surface mt-4 px-4 py-3 text-sm text-text-muted">
                  Read-only support view.
                </div>
              ) : showingSeedState ? (
                <div className="session-stack-surface mt-4 px-4 py-3 text-sm text-text-muted">
                  Loading session details…
                </div>
              ) : (
                <PromptForm
                  lifecycle={{
                    phase: session.phase,
                    sandboxSubstate: session.sandboxSubstate,
                    stopMode: session.stopMode,
                    planApprovalPending: session.planApprovalPending ?? false,
                  }}
                  onSubmit={handlePrompt}
                  onWarm={() => warmSandbox(sessionId)}
                  loadFiles={loadSessionFiles}
                  loadSkills={session.repoUrl ? loadSessionSkills : undefined}
                  disabled={needsRepo}
                  placeholder={promptPlaceholder}
                  matchChatPadding
                />
              )}
            </div>
          </div>
        </div>
      </div>
      {!belowXl && (
        <ErrorBoundary
          fallback={({ error, resetError }) => (
            <SectionErrorFallback error={error} resetError={resetError} label="Artifacts" />
          )}
          boundary="artifacts"
        >
          <SessionInspector
            session={session}
            hydrated={sessionHydrated}
            prompts={decoratedPrompts}
            transcripts={transcripts}
            screenshotsByPrompt={agentScreenshotsByPrompt}
            contextUsage={runtimeContextUsage}
            tokenUsage={tokenUsage}
            runtimeActionInFlight={sessionActionInFlight}
            onRuntimeAction={(action) => void handleRuntimeAction(action)}
            prError={prError}
            qaTestSessionUrl={qaTestSessionUrl}
            canTriggerQaVerification={canTriggerQaVerification}
            qaVerificationLoading={qaVerificationLoading}
            qaVerificationError={qaVerificationError}
            onTriggerQaVerification={handleTriggerQaVerification}
            onViewPr={() => setPrUpdated(false)}
            readOnly={isSupportView}
          />
        </ErrorBoundary>
      )}
      {computerUseEnabled ? (
        desktopPaneOpen ? (
          <aside
            id="session-desktop-pane"
            className="fixed inset-y-0 right-0 z-50 flex w-[min(28rem,100vw)] min-w-0 flex-col border-l border-border bg-surface-0 p-3 xl:static xl:z-auto xl:w-[28rem] xl:shrink-0 xl:p-0"
            aria-label="Desktop view"
          >
            <div className="min-h-0 flex-1 overflow-y-auto">
              <SessionDesktopWorkbench
                sessionId={sessionId}
                rows={desktopActionPath.rows}
                loading={desktopActionPath.loading}
                refreshing={desktopActionPath.refreshing}
                error={desktopActionPath.error}
                className="min-h-full"
                onRefresh={desktopActionPath.refreshSnapshot}
                onClose={() => setDesktopPaneOpen(false)}
              />
            </div>
          </aside>
        ) : (
          <aside
            className="hidden min-h-0 border-l border-border pt-3 pl-2 xl:block"
            aria-label="Desktop view collapsed"
          >
            <span className="sr-only">Action path</span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="min-w-8 px-2"
              aria-expanded={desktopPaneOpen}
              aria-label={desktopViewLabel}
              title={desktopViewLabel}
              onClick={() => setDesktopPaneOpen(true)}
            >
              <PanelRightIcon className="h-4 w-4" />
            </Button>
            {desktopActionCount > 0 ? (
              <div className="mt-2 text-center text-2xs font-medium text-text-muted">{desktopActionCount}</div>
            ) : null}
          </aside>
        )
      ) : null}
      <SessionArtifactDrawer open={artifactDrawerOpen} onClose={closeArtifacts} returnFocusRef={artifactTriggerRef}>
        <ErrorBoundary
          fallback={({ error, resetError }) => (
            <SectionErrorFallback error={error} resetError={resetError} label="Artifacts" />
          )}
          boundary="artifact-drawer"
        >
          <SessionArtifactWorkspace
            session={session}
            hydrated={sessionHydrated}
            prompts={decoratedPrompts}
            transcripts={transcripts}
            screenshotsByPrompt={agentScreenshotsByPrompt}
            contextUsage={runtimeContextUsage}
            tokenUsage={tokenUsage}
            runtimeActionInFlight={sessionActionInFlight}
            onRuntimeAction={(action) => void handleRuntimeAction(action)}
            prError={prError}
            qaTestSessionUrl={qaTestSessionUrl}
            canTriggerQaVerification={canTriggerQaVerification}
            qaVerificationLoading={qaVerificationLoading}
            qaVerificationError={qaVerificationError}
            onTriggerQaVerification={handleTriggerQaVerification}
            onViewPr={() => setPrUpdated(false)}
            readOnly={isSupportView}
          />
        </ErrorBoundary>
      </SessionArtifactDrawer>
    </div>
  );
}
