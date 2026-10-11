import { useRef, useState } from "react";

import type { SessionTokenUsage } from "../../hooks/session-state/types";
import { useSyncEffect } from "../../hooks/useEffects";
import type { SessionDetail } from "../../types";
import { getCanonicalSessionStatus } from "../SessionHeader";
import { cx } from "../ui";
import {
  type ContextUsage,
  deriveSandboxState,
  formatExactTokenCount,
  formatUsd,
  hasTokenUsage,
  mergeExactContextUsage,
} from "./runtime";

type Props = {
  session: SessionDetail;
  contextUsage: ContextUsage | null;
  tokenUsage: SessionTokenUsage;
};

/**
 * One-line runtime readout near the composer: canonical status, sandbox state,
 * model, and context fill when a context event has streamed. Status renders
 * from the same projections the page already uses. Exact durable-event token
 * usage and cost render only after the first usage event arrives.
 */
export function SessionRuntimeStrip({ session, contextUsage, tokenUsage }: Props) {
  const canonical = getCanonicalSessionStatus(session);
  const sandbox = deriveSandboxState(session);
  const modelLabel = session.model?.modelID ?? null;
  const exactContextUsage = mergeExactContextUsage(tokenUsage, contextUsage);
  const fillPercent = exactContextUsage?.fillPercent ?? null;
  const hasUsage = hasTokenUsage(tokenUsage);

  const isLive = canonical.tone === "accent";
  const isDone = canonical.tone === "success";
  const dotClass = isLive
    ? "bg-live review-loop-breathe"
    : canonical.tone === "error"
      ? "bg-error"
      : canonical.tone === "muted"
        ? "bg-text-muted"
        : "bg-text-secondary";

  // One-time settle when the status flips live -> done while this strip is
  // mounted. Keyed to the observed transition (ref holds the previous render's
  // liveness), so mounting an already-done session plays nothing, and the
  // strip's constant streaming re-renders never retrigger it.
  const wasLiveRef = useRef(isLive);
  const [settled, setSettled] = useState(false);
  useSyncEffect(() => {
    if (wasLiveRef.current && isDone) setSettled(true);
    else if (isLive) setSettled(false);
    wasLiveRef.current = isLive;
  }, [isLive, isDone]);

  return (
    <div
      aria-label={`Session runtime: ${canonical.label}, sandbox ${sandbox.label.toLowerCase()}`}
      className="mb-1.5 flex min-w-0 flex-wrap items-center gap-2 px-1 text-xs text-text-muted"
    >
      <span className={cx("flex shrink-0 items-center gap-2", settled && "review-loop-settle")}>
        <span aria-hidden className={cx("status-dot size-1.5 shrink-0 rounded-full", dotClass)} />
        <span className="shrink-0 text-text-secondary">{canonical.label}</span>
      </span>
      <span aria-hidden className="shrink-0">
        ·
      </span>
      <span className="shrink-0">Sandbox {sandbox.label.toLowerCase()}</span>
      {modelLabel && (
        <>
          <span aria-hidden className="shrink-0">
            ·
          </span>
          <span className="min-w-0 truncate font-mono-tabular" title={modelLabel}>
            {modelLabel}
          </span>
        </>
      )}
      {fillPercent !== null && (
        <>
          <span aria-hidden className="shrink-0">
            ·
          </span>
          <span className="shrink-0 font-mono-tabular">context {fillPercent}%</span>
        </>
      )}
      {hasUsage && (
        <>
          <span aria-hidden className="shrink-0">
            ·
          </span>
          <span className="shrink-0 font-mono-tabular">{formatExactTokenCount(tokenUsage.totalTokens)} tokens</span>
          <span aria-hidden className="shrink-0">
            ·
          </span>
          <span className="shrink-0 font-mono-tabular">{formatUsd(tokenUsage.cost)}</span>
        </>
      )}
    </div>
  );
}
