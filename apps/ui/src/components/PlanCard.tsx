import { memo, useCallback, useMemo, useRef, useState } from "react";

import { PLAN_CONTEXT_MAX_CHARS, validatePlanMarkdown } from "../../../../shared/plan-mode";
import type { SessionPlanStatus } from "../../../../shared/types/session-plan";
import { stringifyError } from "../../../../shared/utils/errors.js";
import {
  approveSessionPlan,
  fetchSessionPlan,
  type SessionPlan,
  SessionPlanConflictError,
  updateSessionPlan,
} from "../api/sessions";
import { useOnChange, useSyncEffect } from "../hooks/useEffects";
import { extractPlanMarkdown, parsePlanSummary } from "../utils/plan-summary";
import { CaretRightIcon, DownloadIcon, SpinnerIcon } from "./icons";
import { MarkdownEventContent } from "./MarkdownEventContent";
import { ArtifactChip, Button, Textarea } from "./ui";

const EDITOR_MAX_HEIGHT_PX = 480;

type Props = {
  content: string;
  generating: boolean;
  sessionId: string;
  promptId: string;
  planApprovalPending: boolean;
  planRevision: number | null;
  planStatus: SessionPlanStatus | null;
  planAutoReason: string | null;
  planPromptFailed: boolean;
  onDiscuss: (() => void) | null;
};

/** Turn a plan title into a safe, lowercase `.md` filename stem. */
function planFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "");
  return `${slug || "plan"}.md`;
}

function invalidPlanReason(plan: SessionPlan, planPromptFailed: boolean): string | null {
  if (planPromptFailed) return "The planning turn failed.";
  if (plan.valid === true || plan.userEdited) return null;
  if (plan.valid !== false && validatePlanMarkdown(plan.markdown ?? "").valid) return null;

  switch (plan.missingReason) {
    case "missing_final_response":
      return "No plan response was captured.";
    case "plan_prompt_failed":
      return "The planning turn failed.";
    case "plan_capture_failed":
      return "The plan could not be captured.";
    default:
      return "The plan is missing required sections.";
  }
}

/**
 * Renders a plan-mode planning turn as a compact card. A parked card proves it
 * owns the server's latest planPromptId before exposing revision-bound actions,
 * so historical and superseded plan cards remain read-only.
 */
function PlanCardComponent({
  content,
  generating,
  sessionId,
  promptId,
  planApprovalPending,
  planRevision,
  planStatus,
  planAutoReason,
  planPromptFailed,
  onDiscuss,
}: Props) {
  const [open, setOpen] = useState(false);
  const [latestPlan, setLatestPlan] = useState<SessionPlan | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [savedInEditor, setSavedInEditor] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [approvalSubmitted, setApprovalSubmitted] = useState(false);
  const [locallySavedRevision, setLocallySavedRevision] = useState<number | null>(null);
  const [planChanged, setPlanChanged] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  const transcriptMarkdown = useMemo(() => extractPlanMarkdown(content), [content]);
  const canLoadLatestPlan =
    !generating && planRevision !== null && (planStatus === "pending" || planStatus === "approved");
  const isParkedCandidate =
    !generating && onDiscuss !== null && planApprovalPending && planStatus === "pending" && planRevision !== null;
  const showPlanAutoReason = planAutoReason && isParkedCandidate;

  useSyncEffect(() => {
    let active = true;
    if (!canLoadLatestPlan) {
      setLatestPlan(null);
      return;
    }
    void fetchSessionPlan(sessionId)
      .then((plan) => {
        if (active) setLatestPlan(plan);
      })
      .catch((error) => {
        if (active) setActionError(stringifyError(error));
      });
    return () => {
      active = false;
    };
  }, [canLoadLatestPlan, planRevision, sessionId]);

  useSyncEffect(() => {
    if (!editing) return;
    const editor = editorRef.current;
    if (!editor) return;
    editor.style.height = "auto";
    editor.style.height = `${Math.min(editor.scrollHeight, EDITOR_MAX_HEIGHT_PX)}px`;
    editor.style.overflowY = editor.scrollHeight > EDITOR_MAX_HEIGHT_PX ? "auto" : "hidden";
  }, [draft, editing]);

  useOnChange([planRevision], () => {
    setLocallySavedRevision(null);
    setPlanChanged(false);
    setActionError(null);
  });

  useOnChange([planApprovalPending], () => {
    if (planApprovalPending) return;
    setOpen(false);
    setEditing(false);
    setSavedInEditor(false);
    setAccepting(false);
    setSaving(false);
    setApprovalSubmitted(false);
    setPlanChanged(false);
    setActionError(null);
  });

  const isAuthoritativeCard = latestPlan?.planPromptId === promptId;
  const boundRevision = locallySavedRevision ?? planRevision;
  const showsActions =
    isParkedCandidate &&
    isAuthoritativeCard &&
    latestPlan.status === "pending" &&
    latestPlan.revision === boundRevision &&
    !planChanged &&
    !approvalSubmitted;
  const displayedMarkdown =
    isAuthoritativeCard && latestPlan.markdown !== null ? latestPlan.markdown : transcriptMarkdown;
  const hasUnsavedDraft = editing && draft.trim() !== (latestPlan?.markdown ?? "").trim();
  const summary = useMemo(() => parsePlanSummary(displayedMarkdown), [displayedMarkdown]);
  const failureReason = latestPlan && isAuthoritativeCard ? invalidPlanReason(latestPlan, planPromptFailed) : null;
  const metadata =
    latestPlan && isAuthoritativeCard ? `${latestPlan.userEdited ? "edited · " : ""}rev ${latestPlan.revision}` : null;

  const refetchAfterConflict = useCallback(async () => {
    const refreshed = await fetchSessionPlan(sessionId);
    setLatestPlan(refreshed);
    setPlanChanged(true);
  }, [sessionId]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([displayedMarkdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = planFilename(summary.title);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [displayedMarkdown, summary.title]);

  const handleAccept = useCallback(async () => {
    if (!latestPlan || failureReason || !showsActions) return;
    setAccepting(true);
    setActionError(null);
    setPlanChanged(false);
    try {
      await approveSessionPlan(sessionId, latestPlan.revision);
      setApprovalSubmitted(true);
      setOpen(false);
    } catch (error) {
      if (error instanceof SessionPlanConflictError) {
        try {
          await refetchAfterConflict();
          if (error.kind === "state") setActionError("This plan is no longer awaiting approval.");
        } catch (refetchError) {
          setActionError(stringifyError(refetchError));
        }
      } else {
        setActionError(stringifyError(error));
      }
    } finally {
      setAccepting(false);
    }
  }, [failureReason, latestPlan, refetchAfterConflict, sessionId, showsActions]);

  const beginEdit = useCallback(() => {
    if (!latestPlan || !showsActions) return;
    setDraft(latestPlan.markdown ?? "");
    setActionError(null);
    setPlanChanged(false);
    setSavedInEditor(false);
    setEditing(true);
    setOpen(true);
  }, [latestPlan, showsActions]);

  const cancelEdit = useCallback(() => {
    setDraft(latestPlan?.markdown ?? "");
    setActionError(null);
    setSavedInEditor(false);
    setEditing(false);
  }, [latestPlan]);

  const saveEdit = useCallback(async () => {
    if (!latestPlan || !draft.trim() || !hasUnsavedDraft || saving || !showsActions) return;
    setSaving(true);
    setActionError(null);
    setPlanChanged(false);
    try {
      const result = await updateSessionPlan(sessionId, latestPlan.revision, draft);
      setLatestPlan({
        ...latestPlan,
        markdown: draft.trim(),
        userEdited: true,
        valid: true,
        missingReason: null,
        revision: result.revision,
        status: result.status,
        updatedAt: new Date().toISOString(),
      });
      setLocallySavedRevision(result.revision);
      setSavedInEditor(true);
    } catch (error) {
      if (error instanceof SessionPlanConflictError) {
        try {
          await refetchAfterConflict();
          if (error.kind === "state") setActionError("This plan is no longer awaiting approval.");
        } catch (refetchError) {
          setActionError(stringifyError(refetchError));
        }
      } else {
        setActionError(stringifyError(error));
      }
    } finally {
      setSaving(false);
    }
  }, [draft, hasUnsavedDraft, latestPlan, refetchAfterConflict, saving, sessionId, showsActions]);

  return (
    <div
      className={`session-stack-surface overflow-hidden ${showsActions ? "session-stack-surface-left-accent" : ""}`}
      data-plan-card="true"
    >
      {/* Single non-wrapping header line: the toggle owns the leftover width
          (Button is shrink-0 by default, so it rides a min-w-0 flex-1 wrapper)
          and the title truncates with an ellipsis instead of clipping mid-word
          or wrapping the caret onto its own line. */}
      <div className="flex flex-nowrap items-center gap-x-2 px-2 py-1.5">
        <span className="flex min-w-0 flex-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen((prev) => !prev)}
            aria-expanded={open}
            className="w-full min-w-0 justify-start gap-2"
          >
            <CaretRightIcon
              className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform duration-150 ${open ? "rotate-90" : ""}`}
            />
            {/* Chip primitive, not a bare mono word: inline mono beside the
                sans title needs the chip's box to read as intentional — and
                the violet eyebrow-accent is reserved for running readouts. */}
            <ArtifactChip kind="text" label="Plan" className="shrink-0" />
            {generating ? (
              <span className="inline-flex items-center gap-1.5 text-md font-medium text-text-secondary">
                <SpinnerIcon className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                Planning…
              </span>
            ) : (
              <span className="min-w-0 truncate text-md font-medium text-text-primary" title={summary.title}>
                {summary.title}
              </span>
            )}
            {metadata && <span className="shrink-0 text-xs text-text-muted">{metadata}</span>}
          </Button>
        </span>
        {!generating && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDownload}
            aria-label="Download plan as Markdown"
            title="Download plan (.md)"
            className="shrink-0 px-2 text-text-muted"
          >
            <DownloadIcon className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      {showPlanAutoReason && (
        <div className="border-t border-border/60 px-4 py-2 text-sm text-text-secondary">
          Auto chose to plan because: {planAutoReason}
        </div>
      )}
      {open && (
        <div className="border-t border-border/80 px-4 py-3">
          {editing ? (
            <Textarea
              ref={editorRef}
              aria-label="Edit plan"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              // Raw-markdown authoring surface: code fences, indentation, tables,
              // and paths need monospace while editing, so this stays font-mono
              // even though the rendered plan reads as Geist prose.
              className="resize-none font-mono text-sm"
            />
          ) : (
            <MarkdownEventContent content={displayedMarkdown} renderAsPlainText={false} />
          )}
        </div>
      )}
      {(showsActions || approvalSubmitted || (planChanged && isAuthoritativeCard)) && (
        <div className="border-t border-border/80 px-4 py-3">
          {approvalSubmitted ? (
            <div role="status" className="text-sm text-text-secondary">
              Plan accepted. Starting implementation…
            </div>
          ) : (
            <>
              {failureReason && (
                <div role="alert" className="mb-3 text-sm text-error">
                  Accept is unavailable: {failureReason}
                </div>
              )}
              {planChanged && (
                <div role="status" className="mb-3 text-sm text-warning">
                  Plan changed. Review the latest revision before accepting.
                </div>
              )}
              {actionError && (
                <div role="alert" className="mb-3 text-sm text-error">
                  {actionError}
                </div>
              )}
              {editing && draft.length > PLAN_CONTEXT_MAX_CHARS && (
                <div role="status" className="mb-3 text-sm text-warning">
                  Only the first {PLAN_CONTEXT_MAX_CHARS.toLocaleString()} characters will be included when Cycloid
                  implements this plan.
                </div>
              )}
              {(editing || showsActions) && (
                <div className="flex flex-wrap items-center gap-2">
                  {editing ? (
                    <>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => void saveEdit()}
                        disabled={!showsActions || !draft.trim() || !hasUnsavedDraft || saving}
                      >
                        {saving ? "Saving…" : savedInEditor && !hasUnsavedDraft ? "Saved" : "Save plan"}
                      </Button>
                      <Button variant="secondary" size="sm" onClick={cancelEdit} disabled={saving}>
                        {savedInEditor && !hasUnsavedDraft ? "Done" : "Cancel"}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => void handleAccept()}
                        disabled={Boolean(failureReason) || accepting}
                      >
                        {accepting ? "Accepting…" : "Accept"}
                      </Button>
                      <Button variant="secondary" size="sm" onClick={beginEdit} disabled={accepting}>
                        Edit
                      </Button>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export const PlanCard = memo(PlanCardComponent);
