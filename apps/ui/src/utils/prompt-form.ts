import { ALLOWED_IMAGE_MEDIA_TYPES } from "../../../../shared/constants/uploads";
import type { PlanModeSetting } from "../../../../shared/plan-mode";
import { isPromptSendDisabled } from "../../../../shared/session/eligibility.js";
import type { Phase, SandboxSubstate, StopMode } from "../../../../shared/session/phase.js";
import type { UploadedFile, UploadedImage } from "../../../../shared/types/sandbox";

export type LifecycleSnapshot = {
  phase: Phase;
  sandboxSubstate?: SandboxSubstate;
  stopMode?: StopMode;
  // True while the session is parked on an unapproved plan (plan-approval gate).
  // The park projects `phase: "waiting_for_input"` like a real pending question,
  // so it needs its own flag to swap the composer placeholder to the Discuss
  // hint. Omitted by the home composer, which is never parked (absence = false).
  planApprovalPending?: boolean;
};

type ImageUploadSelectionCandidate = {
  file: File;
  name: string;
  size: number;
  type: string;
};

const IMAGE_MEDIA_TYPE_BY_EXTENSION = new Map<string, (typeof ALLOWED_IMAGE_MEDIA_TYPES)[number]>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);
const GENERIC_FILE_MEDIA_TYPES = new Set(["", "application/octet-stream"]);

/**
 * Parses @path tokens from text and returns unique paths that exist in cache.
 * Returns an empty array when no tokens are found or the cache is unavailable.
 */
export function parseAtTokens(text: string, cache: string[] | null): string[] {
  const matches = text.match(/(?:^|\s)@(\S+)/g);
  if (!matches || !cache) return [];
  const paths = matches.map((m) => m.trim().slice(1));
  const valid = paths.filter((p) => cache.includes(p));
  return [...new Set(valid)];
}

/** Generic FileReader wrapper. Returns the raw result string for the chosen read method. */
export function readFileWith(file: File, method: "readAsText" | "readAsDataURL"): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(reader.error?.message ?? "Failed to read file"));
    reader[method](file);
  });
}

/** Reads a File as base64-encoded data (strips the data-URL prefix). */
export async function readFileAsBase64(file: File): Promise<string> {
  const dataUrl = await readFileWith(file, "readAsDataURL");
  const base64 = dataUrl.split(",")[1];
  if (!base64) throw new Error("Failed to read file as base64");
  return base64;
}

export function partitionFilesByKind(files: File[]): { images: File[]; nonImages: File[] } {
  const images: File[] = [];
  const nonImages: File[] = [];

  for (const file of files) {
    const isImage = (ALLOWED_IMAGE_MEDIA_TYPES as readonly string[]).includes(file.type) || !!inferImageMediaType(file);

    if (isImage) {
      images.push(file);
    } else {
      nonImages.push(file);
    }
  }

  return { images, nonImages };
}

function inferImageMediaType(file: Pick<File, "name" | "type">): (typeof ALLOWED_IMAGE_MEDIA_TYPES)[number] | null {
  if (!GENERIC_FILE_MEDIA_TYPES.has(file.type)) return null;
  const lowerName = file.name.toLowerCase();
  for (const [extension, mediaType] of IMAGE_MEDIA_TYPE_BY_EXTENSION) {
    if (lowerName.endsWith(extension)) return mediaType;
  }
  return null;
}

function buildGeneratedImageName(file: Pick<File, "type">, timestamp: number, index: number): string {
  const subtype = file.type.split("/")[1] || "png";
  return `image-${timestamp}-${index}.${subtype}`;
}

export function prepareImageSelectionCandidates(
  imageFiles: File[],
  timestamp: number,
): ImageUploadSelectionCandidate[] {
  return imageFiles.map((file, index) => ({
    file,
    name: file.name || buildGeneratedImageName(file, timestamp, index),
    size: file.size,
    type: (ALLOWED_IMAGE_MEDIA_TYPES as readonly string[]).includes(file.type)
      ? file.type
      : (inferImageMediaType(file) ?? file.type),
  }));
}

/** Returns true when the textarea should be disabled based on session phase. */
export function isStatusDisabled(snap: LifecycleSnapshot): boolean {
  // A parked plan keeps the composer ENABLED — it is the Discuss channel — so
  // `isPromptSendDisabled` ignores the flag; we still thread the real value so
  // no call site hard-codes it.
  return isPromptSendDisabled(snap.phase, snap.stopMode, snap.sandboxSubstate, snap.planApprovalPending ?? false);
}

/** Returns the placeholder string for the prompt textarea. */
export function getPlaceholder(snap: LifecycleSnapshot, externalDisabled: boolean, customPlaceholder?: string): string {
  if (externalDisabled) return "Select a repo to start";
  if (customPlaceholder) return customPlaceholder;
  // A parked plan projects `waiting_for_input`; steer the composer toward the
  // Discuss channel rather than the "answer the question" copy below.
  if (snap.planApprovalPending) return "Discuss the plan…";
  if (snap.phase === "running" && snap.sandboxSubstate === "creating") {
    return "Starting your environment… prompt will be queued";
  }
  if (snap.phase === "running" && snap.sandboxSubstate === "reconnecting") {
    return "Reconnecting… prompt will be queued";
  }
  if (snap.phase === "running") return "Queue a follow-up prompt…";
  if (snap.phase === "waiting_for_input") return "Answer the question or queue a follow-up prompt…";
  if (snap.phase === "failed") return "Session failed - prompts are disabled";
  if (snap.phase === "blocked") return "Cycloid is blocked and needs your attention";
  if (snap.phase === "stopped" && snap.stopMode === "user") {
    return "Session was stopped by you. Click Resume to continue.";
  }
  if (snap.phase === "stopped") return "Send a prompt to resume - a fresh environment will start.";
  if (snap.phase === "archived") return "Session is not accepting prompts";
  return "Enter a prompt…";
}

type SubmitPayload = {
  prompt: string;
  skills?: string[];
  files?: string[];
  uploadedFiles?: UploadedFile[];
  uploadedImages?: UploadedImage[];
  reasoningEffort?: string;
  // Explicit plan-mode value from the home composer chip at submit time. Only
  // set when the plan-approval capability is on; undefined leaves the control
  // plane to derive plan mode from the user setting.
  planMode?: PlanModeSetting;
};

/** Builds the payload for prompt submission from form state. */
export function buildSubmitPayload(opts: {
  prompt: string;
  skills: string[];
  attachedFiles: string[];
  uploadedFiles: UploadedFile[];
  uploadedImages: UploadedImage[];
  reasoningEffort: string | undefined;
  planMode: PlanModeSetting | undefined;
}): SubmitPayload {
  return {
    prompt: opts.prompt,
    skills: opts.skills.length ? opts.skills : undefined,
    files: opts.attachedFiles.length ? opts.attachedFiles : undefined,
    uploadedFiles: opts.uploadedFiles.length ? opts.uploadedFiles : undefined,
    uploadedImages: opts.uploadedImages.length ? opts.uploadedImages : undefined,
    reasoningEffort: opts.reasoningEffort,
    planMode: opts.planMode,
  };
}
