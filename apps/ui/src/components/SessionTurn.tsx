import { Fragment, memo, Suspense, useCallback, useId, useRef, useState } from "react";

import { derivePromptDisplayText } from "../../../../shared/transcript/prompt-display.js";
import type { SessionPlanStatus } from "../../../../shared/types/session-plan.js";
import { useLayoutSyncEffect, useMountEffect, useSyncEffect } from "../hooks/useEffects";
import type { AgentScreenshot } from "../hooks/useSessionScreenshots";
import { lazyWithRetry } from "../lazy-with-retry";
import type { ActivityEvent, Phase, PromptRow } from "../types";
import { isActivePrompt } from "../utils/status-display";
import { formatTimestamp } from "../utils/time";
import { BotAvatar } from "./BotAvatar";
import { CloseIcon } from "./icons";
import { MessageBubble } from "./MessageBubble";
import { Transcript } from "./Transcript";
import { Badge, Button, Modal } from "./ui";
import { cx } from "./ui/utils";

const EMPTY_AGENT_SCREENSHOTS: AgentScreenshot[] = [];

const LazyMarkdownContent = lazyWithRetry(() =>
  import("./MarkdownContent").then((m) => ({ default: m.MarkdownContent })),
);

const EMPTY_ACTIVITY_EVENTS: ActivityEvent[] = [];
const PROMPT_COLLAPSE_MAX_HEIGHT_CLASS = "max-h-56";
const PROMPT_COLLAPSE_MAX_HEIGHT_PX = 224;

function UserAvatar({ url }: { url: string | null }) {
  if (url) {
    return (
      <img
        src={url}
        alt=""
        width={28}
        height={28}
        loading="lazy"
        className="w-7 h-7 rounded-full shrink-0 img-outline"
      />
    );
  }
  return (
    <div className="w-7 h-7 rounded-full bg-surface-2 flex items-center justify-center shrink-0">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-text-muted"
      >
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    </div>
  );
}

const PromptContent = memo(function PromptContent({ prompt }: { prompt: PromptRow }) {
  const displayPrompt = derivePromptDisplayText(prompt);
  const hasStoredSkillInvocation = prompt.skills?.length
    ? displayPrompt.trimStart().startsWith(`/${prompt.skills[0]}`)
    : false;
  const skillPrefix =
    prompt.skills?.length && !hasStoredSkillInvocation ? (
      <>
        {prompt.skills.map((skill, index) => (
          <Fragment key={`${skill}-${index}`}>
            <span className="font-mono text-accent">/{skill}</span>{" "}
          </Fragment>
        ))}
      </>
    ) : undefined;

  if (prompt.skills?.length) {
    return (
      <Suspense
        fallback={
          <div className="whitespace-pre-wrap break-words text-inherit">
            {skillPrefix}
            {displayPrompt}
          </div>
        }
      >
        <LazyMarkdownContent content={displayPrompt} prefix={skillPrefix} />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<div className="whitespace-pre-wrap break-words text-inherit">{displayPrompt}</div>}>
      <LazyMarkdownContent content={displayPrompt} />
    </Suspense>
  );
});

function CollapsiblePromptContent({ prompt }: { prompt: PromptRow }) {
  const contentId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [canCollapse, setCanCollapse] = useState(false);

  const measureOverflow = useCallback(() => {
    const node = contentRef.current;
    if (!node) return;
    setCanCollapse(node.scrollHeight > PROMPT_COLLAPSE_MAX_HEIGHT_PX + 1);
  }, []);

  useLayoutSyncEffect(() => {
    measureOverflow();
  }, [measureOverflow, prompt.prompt, prompt.skills, prompt.files, prompt.uploadedFiles, prompt.uploadedImages]);

  useSyncEffect(() => {
    const node = contentRef.current;
    if (!node) return;

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => measureOverflow());
      observer.observe(node);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", measureOverflow);
    return () => window.removeEventListener("resize", measureOverflow);
  }, [measureOverflow]);

  const isClamped = canCollapse && !expanded;

  return (
    <div className="space-y-2">
      <div className="relative">
        <div
          id={contentId}
          ref={contentRef}
          data-prompt-content-region="true"
          className={isClamped ? `${PROMPT_COLLAPSE_MAX_HEIGHT_CLASS} overflow-hidden` : undefined}
        >
          <PromptContent prompt={prompt} />
        </div>
        {isClamped ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-b from-transparent to-surface-1"
          />
        ) : null}
      </div>
      {canCollapse ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((current) => !current)}
          className="text-xs font-medium text-accent transition-colors hover:text-accent-hover"
        >
          {expanded ? "Show less" : "Show full prompt"}
        </button>
      ) : null}
    </div>
  );
}

function createImageObjectUrl(image: { mediaType: string | null; data?: string }): string | null {
  if (!image.mediaType?.startsWith("image/") || !image.data) return null;
  try {
    const binary = atob(image.data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return URL.createObjectURL(new Blob([bytes], { type: image.mediaType }));
  } catch {
    return null;
  }
}

type Props = {
  prompt: PromptRow;
  transcriptEvents: ActivityEvent[];
  isInFlightTurn: boolean;
  transcriptHydrationPending?: boolean;
  transcriptMayBeIncomplete?: boolean;
  fallbackAvatarUrl: string | null;
  sessionPhase: Phase;
  // A parked plan projects `waiting_for_input` like a real pending question;
  // this flag keeps the transcript-liveness gate (respond affordance) off so the
  // park never renders as an answerable question.
  planApprovalPending: boolean;
  planRevision: number | null;
  planStatus: SessionPlanStatus | null;
  planAutoReason?: string | null;
  onDiscussPlan: (() => void) | null;
  repoOwner?: string | null;
  repoName?: string | null;
  agentScreenshots?: AgentScreenshot[];
  onAnswerQuestion?: (questionId: string, answer: string) => void;
  supportView?: boolean;
};

type ImagePreview = {
  name: string;
  src: string;
  layout: ImagePreviewLayout;
};

type UploadedImagePreview = {
  key: string;
  name: string;
  src: string | null;
};

type ImagePreviewLayout = "unknown" | "portrait" | "landscape" | "square";

const IMAGE_PREVIEW_MODAL_BASE_CLASS_NAME = "flex max-h-[88vh] w-fit flex-col overflow-hidden p-0";
const IMAGE_PREVIEW_MODAL_NARROW_CLASS_NAME = "max-w-[86vw]";
const IMAGE_PREVIEW_MODAL_WIDE_CLASS_NAME = "max-w-[min(96vw,1440px)]";

const IMAGE_PREVIEW_MODAL_WIDTH_CLASS_NAME: Record<ImagePreviewLayout, string> = {
  unknown: IMAGE_PREVIEW_MODAL_NARROW_CLASS_NAME,
  portrait: IMAGE_PREVIEW_MODAL_NARROW_CLASS_NAME,
  landscape: IMAGE_PREVIEW_MODAL_WIDE_CLASS_NAME,
  square: IMAGE_PREVIEW_MODAL_NARROW_CLASS_NAME,
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

function SessionTurnComponent({
  prompt: p,
  transcriptEvents,
  isInFlightTurn,
  transcriptHydrationPending = false,
  transcriptMayBeIncomplete = false,
  fallbackAvatarUrl,
  sessionPhase,
  planApprovalPending,
  planRevision,
  planStatus,
  planAutoReason,
  onDiscussPlan,
  repoOwner,
  repoName,
  agentScreenshots = EMPTY_AGENT_SCREENSHOTS,
  onAnswerQuestion,
  supportView = false,
}: Props) {
  const [previewImage, setPreviewImage] = useState<ImagePreview | null>(null);
  const [uploadedImagePreviews, setUploadedImagePreviews] = useState<UploadedImagePreview[]>([]);
  const previewCloseButtonRef = useRef<HTMLButtonElement>(null);
  const uploadedImageObjectUrlsRef = useRef(new Map<string, string>());
  const avatarUrl = p.actorAvatarUrl ?? fallbackAvatarUrl;
  const previewModalClassName = cx(
    IMAGE_PREVIEW_MODAL_BASE_CLASS_NAME,
    IMAGE_PREVIEW_MODAL_WIDTH_CLASS_NAME[previewImage?.layout ?? "unknown"],
  );

  const openImagePreview = (name: string, src: string, image: HTMLImageElement | null = null) => {
    setPreviewImage({ name, src, layout: imagePreviewLayoutFromElement(image) });
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

  // Lazily turn uploaded image base64 payloads into blob URLs and cache per
  // upload identity. Caching means rerenders reuse the same blob URL instead
  // of allocating a new object URL each pass. When uploads change, evict
  // stale entries and close any preview pointing at a URL we're about to
  // revoke so the modal doesn't render a freed handle. We use
  // useLayoutSyncEffect so thumbnails appear on the first paint instead of
  // flashing in after an async post-paint commit.
  useLayoutSyncEffect(() => {
    const nextActiveCacheKeys = new Set<string>();
    const nextPreviews = (p.uploadedImages ?? []).map((img, index) => {
      // Cheap identity: name + mediaType + length + 64-char prefix. Avoids
      // duplicating the full base64 payload (which can be hundreds of KB
      // per image) in the cache key and in each preview's React key.
      const dataFingerprint = img.data ? `${img.data.length}:${img.data.slice(0, 64)}` : "";
      const cacheKey = `${img.name}:${img.mediaType}:${dataFingerprint}`;
      let src: string | null = null;
      if (img.mediaType?.startsWith("image/") && img.data) {
        nextActiveCacheKeys.add(cacheKey);
        src = uploadedImageObjectUrlsRef.current.get(cacheKey) ?? null;
        if (!src) {
          src = createImageObjectUrl(img);
          if (src) uploadedImageObjectUrlsRef.current.set(cacheKey, src);
        }
      }
      return { key: `${cacheKey}:${index}`, name: img.name, src };
    });

    for (const [cacheKey, objectUrl] of uploadedImageObjectUrlsRef.current.entries()) {
      if (nextActiveCacheKeys.has(cacheKey)) continue;
      if (previewImage?.src === objectUrl) {
        setPreviewImage(null);
      }
      URL.revokeObjectURL(objectUrl);
      uploadedImageObjectUrlsRef.current.delete(cacheKey);
    }

    setUploadedImagePreviews(nextPreviews);
    // previewImage is intentionally omitted: opening/closing the preview must
    // not retrigger cache reconciliation. When uploads change, the closure
    // already sees the latest committed previewImage value.
  }, [p.uploadedImages]);

  useMountEffect(() => () => {
    for (const objectUrl of uploadedImageObjectUrlsRef.current.values()) {
      URL.revokeObjectURL(objectUrl);
    }
    uploadedImageObjectUrlsRef.current.clear();
  });

  return (
    <div className="mb-8">
      {/* Plan mode auto-continues into implementation: render a transition
          instead of echoing the original prompt as a second user turn. */}
      {p.continuesPlan ? (
        <div className="mb-2 flex items-start gap-3 text-sm text-text-secondary">
          <BotAvatar />
          <span className="min-w-0 flex-1 pt-1.5">Implementing plan</span>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <UserAvatar url={avatarUrl} />
          <div className="flex-1 min-w-0">
            {p.status === "queued" && (
              <div className="mb-1.5">
                <Badge tone="default" role="status">
                  Queued
                </Badge>
              </div>
            )}
            <MessageBubble data-role="user" padding="roomy">
              <CollapsiblePromptContent prompt={p} />
              {p.files && p.files.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {p.files.map((f) => (
                    <span key={f} className="px-1.5 py-0.5 rounded bg-accent-soft text-accent text-2xs font-medium">
                      {f}
                    </span>
                  ))}
                </div>
              )}
              {p.uploadedFiles && p.uploadedFiles.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {p.uploadedFiles.map((f) => (
                    <span
                      key={f.name}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-accent-soft text-accent text-2xs font-mono-tabular"
                    >
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="shrink-0"
                      >
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="17 8 12 3 7 8" />
                        <line x1="12" y1="3" x2="12" y2="15" />
                      </svg>
                      {f.name}
                    </span>
                  ))}
                </div>
              )}
              {uploadedImagePreviews.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {uploadedImagePreviews.map((img) => {
                    const imageSrc = img.src;
                    return (
                      <Fragment key={img.key}>
                        {imageSrc ? (
                          <button
                            type="button"
                            onClick={(event) => {
                              openImagePreview(img.name, imageSrc, event.currentTarget.querySelector("img"));
                            }}
                            aria-label={`Open uploaded image ${img.name}`}
                            title={img.name}
                            className="group block w-28 overflow-hidden rounded-md border border-warning-soft-border bg-warning-soft text-left cursor-pointer"
                          >
                            <img src={imageSrc} alt={img.name} className="h-20 w-full object-cover" />
                            <span className="block truncate px-1.5 py-1 text-2xs font-mono-tabular text-warning group-hover:underline">
                              {img.name}
                            </span>
                          </button>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-warning-soft text-warning text-2xs font-mono-tabular">
                            <svg
                              width="10"
                              height="10"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className="shrink-0"
                            >
                              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                              <circle cx="8.5" cy="8.5" r="1.5" />
                              <polyline points="21 15 16 10 5 21" />
                            </svg>
                            {img.name}
                          </span>
                        )}
                      </Fragment>
                    );
                  })}
                </div>
              )}
            </MessageBubble>
            {formatTimestamp(p.createdAt) ? (
              <p className="mt-1 px-1 text-xs text-text-muted tabular-nums">{formatTimestamp(p.createdAt)}</p>
            ) : null}
          </div>
        </div>
      )}
      {/* Transcript events for this prompt */}
      <Transcript
        prompt={p}
        events={transcriptEvents.length > 0 ? transcriptEvents : EMPTY_ACTIVITY_EVENTS}
        isActive={p.result === null && isActivePrompt(sessionPhase, planApprovalPending)}
        showProgressIndicator={isInFlightTurn}
        repoOwner={repoOwner ?? null}
        repoName={repoName ?? null}
        onAnswerQuestion={onAnswerQuestion}
        supportView={supportView}
        hideAvatar={Boolean(p.continuesPlan)}
        planApprovalPending={planApprovalPending}
        planRevision={planRevision}
        planStatus={planStatus}
        planAutoReason={planAutoReason ?? null}
        onDiscussPlan={onDiscussPlan}
      />
      {transcriptHydrationPending && (
        <div
          role="status"
          aria-live="polite"
          className="ml-9 mt-3 flex items-center gap-2 rounded-lg border border-border bg-surface-1 px-3 py-2 text-xs text-text-muted"
        >
          <span className="status-dot status-dot-pulse h-1.5 w-1.5 rounded-full bg-accent" />
          Loading response…
        </div>
      )}
      {transcriptMayBeIncomplete && (
        <output
          aria-atomic="true"
          className="ml-9 mt-2 block rounded-lg border border-warning-soft-border bg-warning-soft px-3 py-2 text-xs text-warning"
        >
          Transcript may be incomplete.
        </output>
      )}
      {/* Agent-uploaded screenshots produced during this prompt. Mirrors the
          uploadedImages render block above (PR #2740) so user-uploaded images
          and agent screenshots share the same thumbnail + click-to-expand UX.
          The viewUrl field already routes private-repo screenshots through the
          authenticated `/view` proxy; <img src> works for both shapes. */}
      {agentScreenshots.length > 0 && (
        <div className="mt-3 ml-9 flex flex-wrap gap-3">
          {agentScreenshots.map((shot) => (
            <button
              key={shot.artifactId}
              type="button"
              onClick={(event) => openImagePreview(shot.label, shot.viewUrl, event.currentTarget.querySelector("img"))}
              aria-label={`Open agent screenshot ${shot.label}`}
              title={shot.label}
              // Sized for full-page UI screenshots — readable at glance without
              // forcing the click-to-expand. User-pasted images stay smaller
              // (w-28) since they're typically icons/snippets.
              className="group block w-80 overflow-hidden rounded-md border border-border bg-surface-1 text-left cursor-pointer"
            >
              <img
                src={shot.viewUrl}
                alt={shot.label}
                width={320}
                height={192}
                loading="lazy"
                className="h-48 w-full object-cover"
              />
              <span className="block truncate px-2 py-1.5 text-xs font-mono-tabular text-text-muted group-hover:underline">
                {shot.label}
              </span>
            </button>
          ))}
        </div>
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
    </div>
  );
}

export const SessionTurn = memo(SessionTurnComponent);
