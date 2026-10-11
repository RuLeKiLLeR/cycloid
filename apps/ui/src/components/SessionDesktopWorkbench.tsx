import { useRef, useState } from "react";

import type { DesktopActionPathRow, DesktopActionPathStatus } from "../../../../shared/types/desktop-action-path";
import { useSyncEffect } from "../hooks/useEffects";
import { type SessionDesktopViewerStatus, useSessionDesktopViewer } from "../hooks/useSessionDesktopViewer";
import { formatTimestamp } from "../utils/time";
import { CloseIcon, DesktopIcon, ExpandIcon } from "./icons";
import { Button } from "./ui";
import { Modal } from "./ui/Modal";
import { cx } from "./ui/utils";

type ImagePreviewLayout = "unknown" | "portrait" | "landscape" | "square";

type ImagePreview = {
  name: string;
  src: string;
  layout: ImagePreviewLayout;
};

export type DesktopWorkbenchRecording = {
  recordingId: string;
  label: string | null;
  status: "recording" | "completed" | "failed" | "interrupted";
  startedAtMs: number | null;
  stoppedAtMs: number | null;
  durationMs: number | null;
  bytes: number | null;
  maxDurationMs: number;
  maxBytes: number;
  overlayStatus: "applied" | "failed" | "not_attempted";
  failureReason: string | null;
};

type Props = {
  sessionId: string;
  rows: DesktopActionPathRow[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  className?: string;
  recording?: DesktopWorkbenchRecording | null;
  onRefresh: () => void;
  onClose?: () => void;
};

const IMAGE_PREVIEW_MODAL_BASE_CLASS_NAME = "flex max-h-[88vh] w-fit flex-col overflow-hidden p-0";
const IMAGE_PREVIEW_MODAL_NARROW_CLASS_NAME = "max-w-[86vw]";
const IMAGE_PREVIEW_MODAL_WIDE_CLASS_NAME = "max-w-[min(96vw,1440px)]";

const IMAGE_PREVIEW_MODAL_WIDTH_CLASS_NAME: Record<ImagePreviewLayout, string> = {
  unknown: IMAGE_PREVIEW_MODAL_NARROW_CLASS_NAME,
  portrait: IMAGE_PREVIEW_MODAL_NARROW_CLASS_NAME,
  landscape: IMAGE_PREVIEW_MODAL_WIDE_CLASS_NAME,
  square: IMAGE_PREVIEW_MODAL_NARROW_CLASS_NAME,
};

const STATUS_LABELS: Record<DesktopActionPathStatus, string> = {
  completed: "Completed",
  action_failed: "Action failed",
  desktop_unavailable: "Desktop unavailable",
  screenshot_failed: "Screenshot unavailable",
  quota_exceeded: "Screenshot quota exceeded",
  pruned: "Screenshot pruned",
};

const VIEWER_STATUS_LABELS: Record<SessionDesktopViewerStatus, string> = {
  preparing: "Preparing",
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  unavailable: "Unavailable",
  rate_limited: "Rate limited",
};

const RECORDING_STATUS_LABELS: Record<DesktopWorkbenchRecording["status"], string> = {
  recording: "Recording",
  completed: "Completed",
  failed: "Recording failed",
  interrupted: "Interrupted",
};

function imagePreviewLayoutFromDimensions(width: number, height: number): ImagePreviewLayout {
  if (width <= 0 || height <= 0) return "unknown";
  if (width / height >= 1.1) return "landscape";
  if (height / width >= 1.1) return "portrait";
  return "square";
}

function imagePreviewLayoutFromElement(image: HTMLImageElement | null): ImagePreviewLayout {
  if (!image) return "unknown";
  return imagePreviewLayoutFromDimensions(image.naturalWidth, image.naturalHeight);
}

function actionKindLabel(action: DesktopActionPathRow["action"]): string {
  switch (action) {
    case "open_app":
      return "Open app";
    case "focus_window":
      return "Focus window";
    default:
      return action.charAt(0).toUpperCase() + action.slice(1);
  }
}

function statusClassName(status: DesktopActionPathStatus): string {
  if (status === "completed") return "border-success-soft-border bg-success-soft text-success";
  if (status === "action_failed" || status === "desktop_unavailable") {
    return "border-error-soft-border bg-error-soft text-error";
  }
  return "border-warning-soft-border bg-warning-soft text-warning";
}

function placeholderCopy(row: DesktopActionPathRow): string {
  const screenshotStatus = row.screenshot?.status;
  if (screenshotStatus === "pruned" || row.status === "pruned") return "Screenshot pruned";
  if (screenshotStatus === "quota_exceeded" || row.status === "quota_exceeded") return "Quota exceeded";
  if (screenshotStatus === "failed" || row.status === "screenshot_failed") return "Screenshot failed";
  if (row.status === "desktop_unavailable") return "Desktop unavailable";
  return "No screenshot";
}

function viewerStatusClassName(status: SessionDesktopViewerStatus): string {
  if (status === "connected") return "border-success-soft-border bg-success-soft text-success";
  if (status === "unavailable") return "border-error-soft-border bg-error-soft text-error";
  if (status === "rate_limited") return "border-warning-soft-border bg-warning-soft text-warning";
  return "border-accent-soft-border bg-accent-soft text-text-secondary";
}

function retryAfterCopy(retryAfterSeconds: number | null): string | null {
  if (retryAfterSeconds === null) return null;
  return `Retrying in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? "" : "s"}.`;
}

function recordingArtifactTooLarge(recording: DesktopWorkbenchRecording): boolean {
  return (
    (recording.bytes !== null && recording.bytes > recording.maxBytes) ||
    (recording.durationMs !== null && recording.durationMs > recording.maxDurationMs)
  );
}

function recordingAvailable(recording: DesktopWorkbenchRecording): boolean {
  return (
    recording.status === "completed" && recording.overlayStatus === "applied" && !recordingArtifactTooLarge(recording)
  );
}

function recordingStatusLabel(recording: DesktopWorkbenchRecording): string {
  if (recordingArtifactTooLarge(recording)) return "Artifact too large";
  if (recording.overlayStatus === "failed") return "Recording failed";
  return RECORDING_STATUS_LABELS[recording.status];
}

function recordingStatusClassName(recording: DesktopWorkbenchRecording): string {
  if (recordingAvailable(recording)) return "border-success-soft-border bg-success-soft text-success";
  if (recordingArtifactTooLarge(recording) || recording.overlayStatus === "failed" || recording.status === "failed") {
    return "border-error-soft-border bg-error-soft text-error";
  }
  return "border-warning-soft-border bg-warning-soft text-warning";
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "Size unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "Duration unknown";
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function DesktopActionThumbnail({
  row,
  onOpen,
}: {
  row: DesktopActionPathRow;
  onOpen: (image: HTMLImageElement | null) => void;
}) {
  const screenshot = row.screenshot;
  if (screenshot?.status === "available" && screenshot.viewUrl) {
    return (
      <button
        type="button"
        className="group block aspect-video w-32 shrink-0 overflow-hidden rounded-md border border-border bg-surface-1 text-left cursor-pointer"
        onClick={(event) => onOpen(event.currentTarget.querySelector("img"))}
        aria-label={`Open desktop action screenshot ${screenshot.label}`}
        title={screenshot.label}
      >
        <img
          src={screenshot.viewUrl}
          alt={screenshot.label}
          width={160}
          height={90}
          loading="lazy"
          className="h-full w-full object-contain img-outline transition-opacity group-hover:opacity-90"
        />
      </button>
    );
  }

  return (
    <div className="flex aspect-video w-32 shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 px-3 text-center text-xs text-text-muted">
      {placeholderCopy(row)}
    </div>
  );
}

export function SessionDesktopWorkbench({
  sessionId,
  rows,
  loading,
  refreshing,
  error,
  className,
  recording = null,
  onRefresh,
  onClose,
}: Props) {
  const [previewImage, setPreviewImage] = useState<ImagePreview | null>(null);
  const [liveViewerStarted, setLiveViewerStarted] = useState(false);
  const [liveViewerExpanded, setLiveViewerExpanded] = useState(false);
  const previewCloseButtonRef = useRef<HTMLButtonElement>(null);
  const liveViewerCloseButtonRef = useRef<HTMLButtonElement>(null);
  const desktopViewer = useSessionDesktopViewer(sessionId, { enabled: liveViewerStarted });
  const viewerState = desktopViewer.state;
  const viewerRetryAfterCopy = retryAfterCopy(viewerState.retryAfterSeconds);
  const previewModalClassName = cx(
    IMAGE_PREVIEW_MODAL_BASE_CLASS_NAME,
    IMAGE_PREVIEW_MODAL_WIDTH_CLASS_NAME[previewImage?.layout ?? "unknown"],
  );
  const openPreview = (row: DesktopActionPathRow, image: HTMLImageElement | null) => {
    const screenshot = row.screenshot;
    if (screenshot?.status !== "available" || !screenshot.viewUrl) return;
    setPreviewImage({
      name: screenshot.label,
      src: screenshot.viewUrl,
      layout: imagePreviewLayoutFromElement(image),
    });
  };

  const syncPreviewLayout = (image: HTMLImageElement | null) => {
    if (!image) return;
    const nextLayout = imagePreviewLayoutFromElement(image);
    if (nextLayout === "unknown") return;
    setPreviewImage((current) => {
      if (!current || current.layout === nextLayout) return current;
      return { ...current, layout: nextLayout };
    });
  };

  useSyncEffect(() => {
    if (!liveViewerExpanded) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const scrollContainers: HTMLElement[] = [
      document.body,
      ...Array.from(document.querySelectorAll<HTMLElement>("#main-content, [data-session-scroll-container]")),
    ];
    const previousOverflow = scrollContainers.map((element) => element.style.overflow);
    scrollContainers.forEach((element) => {
      element.style.overflow = "hidden";
    });
    requestAnimationFrame(() => {
      liveViewerCloseButtonRef.current?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setLiveViewerExpanded(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      scrollContainers.forEach((element, index) => {
        element.style.overflow = previousOverflow[index] ?? "";
      });
      previouslyFocused?.focus();
    };
  }, [liveViewerExpanded]);

  return (
    <section
      className={cx("session-stack-surface overflow-hidden", className)}
      aria-labelledby="desktop-workbench-heading"
    >
      <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
        <div>
          <h2 id="desktop-workbench-heading" className="text-xl font-semibold text-text-primary">
            Desktop view
          </h2>
          <p className="mt-1 text-sm text-text-muted">
            {rows.length > 0 ? `${rows.length} desktop action${rows.length === 1 ? "" : "s"}` : "Action path"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
          {onClose ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-w-8 px-2"
              aria-label="Close desktop view"
              title="Close desktop view"
              onClick={onClose}
            >
              <CloseIcon className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </div>

      {error ? (
        <div
          role="alert"
          className="border-b border-warning-soft-border bg-warning-soft px-4 py-2 text-sm text-warning"
        >
          {error}
        </div>
      ) : null}

      {liveViewerExpanded ? (
        <div
          className="editorial-fade fixed inset-0 z-50 bg-[color-mix(in_srgb,var(--color-text-primary)_40%,transparent)]"
          aria-hidden="true"
          onMouseDown={() => setLiveViewerExpanded(false)}
        />
      ) : null}

      <div
        className={cx(
          "border-b border-border p-4",
          liveViewerExpanded
            ? "editorial-fade fixed inset-3 z-50 flex flex-col overflow-hidden rounded-lg border bg-surface-1 shadow-elevated sm:inset-5"
            : null,
        )}
        aria-label={liveViewerExpanded ? "Live desktop" : "Live desktop panel"}
        role={liveViewerExpanded ? "dialog" : undefined}
        aria-modal={liveViewerExpanded ? true : undefined}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-md font-semibold text-text-primary">Live desktop</h3>
            <p className="mt-1 text-sm text-text-muted">
              {liveViewerStarted
                ? viewerState.desktopName
                  ? `${viewerState.message} ${viewerState.desktopName}`
                  : viewerState.message
                : "Live desktop is idle."}
            </p>
            {viewerRetryAfterCopy ? <p className="mt-1 text-xs text-text-muted">{viewerRetryAfterCopy}</p> : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span
              className={cx(
                "shrink-0 rounded-md border px-2 py-1 text-xs font-medium",
                liveViewerStarted
                  ? viewerStatusClassName(viewerState.status)
                  : "border-border bg-surface-2 text-text-muted",
              )}
            >
              {liveViewerStarted ? VIEWER_STATUS_LABELS[viewerState.status] : "Idle"}
            </span>
            {liveViewerStarted ? (
              <Button
                ref={liveViewerExpanded ? liveViewerCloseButtonRef : undefined}
                type="button"
                variant="ghost"
                size="sm"
                className="min-w-8 px-2"
                aria-label={liveViewerExpanded ? "Close expanded live desktop" : "Expand live desktop"}
                title={liveViewerExpanded ? "Close expanded live desktop" : "Expand live desktop"}
                onClick={() => setLiveViewerExpanded((expanded) => !expanded)}
              >
                {liveViewerExpanded ? <CloseIcon className="h-4 w-4" /> : <ExpandIcon className="h-4 w-4" />}
              </Button>
            ) : null}
          </div>
        </div>
        <div
          className={cx(
            "relative overflow-hidden rounded-md border border-border bg-surface-0",
            liveViewerExpanded ? "min-h-0 flex-1" : "aspect-[16/10]",
          )}
        >
          {liveViewerStarted ? (
            <div
              ref={desktopViewer.targetRef}
              aria-hidden="true"
              data-view-only="true"
              className="pointer-events-none h-full w-full [&_canvas]:h-full [&_canvas]:w-full [&_canvas]:object-contain"
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center bg-surface-1 px-5 text-center">
              <Button type="button" variant="secondary" size="sm" onClick={() => setLiveViewerStarted(true)}>
                <DesktopIcon className="h-4 w-4" />
                Open desktop
              </Button>
            </div>
          )}
          {liveViewerStarted && viewerState.status !== "connected" ? (
            <div
              className="absolute inset-0 flex items-center justify-center bg-surface-1 px-5 text-center"
              role={viewerState.status === "rate_limited" || viewerState.status === "unavailable" ? "alert" : "status"}
              aria-live="polite"
            >
              <div className="max-w-md">
                <p className="text-sm font-medium text-text-primary">{VIEWER_STATUS_LABELS[viewerState.status]}</p>
                <p className="mt-1 text-sm text-text-muted">{viewerState.message}</p>
                {viewerRetryAfterCopy ? <p className="mt-1 text-xs text-text-muted">{viewerRetryAfterCopy}</p> : null}
              </div>
            </div>
          ) : null}
        </div>
        <p className="mt-2 text-xs text-text-muted">View-only. Mouse, keyboard, and clipboard input are disabled.</p>
      </div>

      {recording ? (
        <div className="border-b border-border p-4" aria-label="Recording evidence">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-md font-semibold text-text-primary">Walkthrough recording</h3>
                <span
                  className={cx(
                    "rounded-md border px-2 py-0.5 text-xs font-medium",
                    recordingStatusClassName(recording),
                  )}
                >
                  {recordingStatusLabel(recording)}
                </span>
              </div>
              <p className="mt-1 truncate text-sm text-text-muted">
                {recording.label || recording.recordingId} · {formatDuration(recording.durationMs)} ·{" "}
                {formatBytes(recording.bytes)}
              </p>
              {recording.failureReason ? (
                <p className="mt-1 text-xs text-text-muted">Code: {recording.failureReason}</p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {loading ? (
        <div role="status" className="space-y-3 p-4" aria-label="Loading desktop action path">
          {[0, 1].map((index) => (
            <div key={index} className="flex gap-3 motion-safe:animate-pulse">
              <div className="aspect-video w-32 rounded-md bg-surface-2" />
              <div className="min-w-0 flex-1 space-y-2 py-1">
                <div className="h-4 w-1/3 rounded bg-surface-2" />
                <div className="h-3 w-2/3 rounded bg-surface-2" />
              </div>
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="px-4 py-5 text-sm text-text-muted">No desktop actions yet.</div>
      ) : (
        <ol className="divide-y divide-border">
          {rows.map((row) => {
            const timestamp = formatTimestamp(row.createdAtMs);
            const metadata = [
              timestamp,
              row.phase === "verification_operator" ? "Verification operator" : "Agent",
              row.activeWindowTitle,
            ].filter(Boolean);
            const issueCode = row.errorCode ?? row.warningCode;
            return (
              <li key={row.actionId} className="flex gap-3 px-4 py-3">
                <DesktopActionThumbnail row={row} onOpen={(image) => openPreview(row, image)} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium text-text-primary">
                      {row.label || actionKindLabel(row.action)}
                    </p>
                    <span
                      className={cx(
                        "rounded-md border px-1.5 py-0.5 text-2xs font-medium",
                        statusClassName(row.status),
                      )}
                    >
                      {STATUS_LABELS[row.status]}
                    </span>
                  </div>
                  {metadata.length > 0 ? (
                    <p className="mt-1 truncate text-xs text-text-muted">{metadata.join(" · ")}</p>
                  ) : null}
                  {issueCode ? <p className="mt-1 text-xs text-text-muted">Code: {issueCode}</p> : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <Modal
        open={previewImage !== null}
        onClose={() => setPreviewImage(null)}
        aria-label={previewImage?.name ?? "Image preview"}
        className={previewModalClassName}
        initialFocusRef={previewCloseButtonRef}
      >
        {previewImage ? (
          <>
            <div className="flex control-lg items-center justify-between gap-4 border-b border-border px-3">
              <div className="max-w-[min(70vw,720px)] truncate text-sm font-medium text-text-primary">
                {previewImage.name}
              </div>
              <Button
                ref={previewCloseButtonRef}
                type="button"
                variant="ghost"
                size="sm"
                className="min-w-8 px-2"
                aria-label="Close image preview"
                onClick={() => setPreviewImage(null)}
              >
                <CloseIcon className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex max-h-[calc(88vh-44px)] max-w-full items-center justify-center bg-surface-0 p-3">
              <img
                src={previewImage.src}
                alt={previewImage.name}
                onLoad={(event) => syncPreviewLayout(event.currentTarget)}
                className="max-h-[calc(88vh-68px)] max-w-full object-contain"
              />
            </div>
          </>
        ) : null}
      </Modal>
    </section>
  );
}
