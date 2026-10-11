import {
  ALLOWED_IMAGE_MEDIA_TYPES,
  MAX_PROMPT_SQL_PAYLOAD_BYTES,
  MAX_UPLOADED_FILE_SIZE_BYTES,
  MAX_UPLOADED_FILES,
  MAX_UPLOADED_IMAGE_SIZE_BYTES,
  MAX_UPLOADED_IMAGES,
  UPLOADED_FILE_EXTENSIONS,
} from "../constants/uploads.js";
import type { UploadedFile, UploadedImage } from "../types/sandbox.js";

type NamedItem = { name: string };
type SizedNamedItem = NamedItem & { size: number };
type TypedSizedNamedItem = SizedNamedItem & { type: string };
type UploadKind = "file" | "image";

export type UploadValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };
export type AcceptUploadedImagePayloadResult =
  { ok: true; image: UploadedImage } | { ok: false; code: "duplicate_name" | "invalid_payload"; error: string };

const ALLOWED_IMAGE_MEDIA_TYPE_SET = new Set<string>(ALLOWED_IMAGE_MEDIA_TYPES);
function ok<T>(value: T): UploadValidationResult<T> {
  return { ok: true, value };
}

function fail<T>(error: string): UploadValidationResult<T> {
  return { ok: false, error };
}

function validateUploadedName(name: string, kind: "file" | "image"): string | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return `Uploaded ${kind} name must be a non-empty string`;
  }
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return `Invalid uploaded ${kind} name: ${trimmed}`;
  }
  return null;
}

function getFileExtension(name: string): string {
  const lastDot = name.lastIndexOf(".");
  return lastDot >= 0 ? name.slice(lastDot).toLowerCase() : "";
}

function trimNamedItems<T extends NamedItem>(items: readonly T[]): T[] {
  return items.map((item) => ({ ...item, name: item.name.trim() }));
}

type SharedUploadValidationOptions<T extends NamedItem> = {
  items: readonly T[];
  existingNames?: readonly string[];
  kind: UploadKind;
  max: number;
  label: string;
  normalizeItems?: (items: readonly T[]) => T[];
  validateItem: (item: T) => string | null;
};

function validateUploadItems<T extends NamedItem>({
  items,
  existingNames = [],
  kind,
  max,
  label,
  normalizeItems,
  validateItem,
}: SharedUploadValidationOptions<T>): UploadValidationResult<T[]> {
  const normalized = normalizeItems ? normalizeItems(items) : [...items];
  const deduped = deduplicateByName(normalized, existingNames);
  const capacityError = checkUploadCapacity(existingNames.length, deduped.length, max, label);
  if (capacityError) return fail(capacityError);

  for (const item of deduped) {
    const nameError = validateUploadedName(item.name, kind);
    if (nameError) return fail(nameError);

    const itemError = validateItem(item);
    if (itemError) return fail(itemError);
  }

  return ok(deduped);
}

function hasNullBytes(content: string): boolean {
  return content.slice(0, 8192).includes("\0");
}

function checkUploadCapacity(currentCount: number, incomingCount: number, max: number, label: string): string | null {
  const remaining = max - currentCount;
  if (incomingCount > remaining) {
    return `Maximum ${max} ${label} (${remaining} remaining)`;
  }
  return null;
}

function deduplicateByName<T extends NamedItem>(items: readonly T[], existingNames: readonly string[] = []): T[] {
  const seen = new Set(existingNames);
  const deduped: T[] = [];
  for (const item of items) {
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    deduped.push(item);
  }
  return deduped;
}

export function estimateDecodedBase64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function isSupportedImageMimeType(mediaType: string): boolean {
  return ALLOWED_IMAGE_MEDIA_TYPE_SET.has(mediaType.toLowerCase());
}

export function isValidBase64(data: string): boolean {
  if (data.length === 0 || data.length % 4 !== 0) return false;

  let paddingStart = data.length;
  while (paddingStart > 0 && data[paddingStart - 1] === "=") {
    paddingStart -= 1;
  }
  const paddingLength = data.length - paddingStart;
  if (paddingLength > 2) return false;

  for (let index = 0; index < paddingStart; index += 1) {
    const code = data.charCodeAt(index);
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    const isPlus = code === 43;
    const isSlash = code === 47;
    if (!isUpper && !isLower && !isDigit && !isPlus && !isSlash) return false;
  }

  for (let index = paddingStart; index < data.length; index += 1) {
    if (data[index] !== "=") return false;
  }

  return true;
}

export function validateUploadedFileSelection<T extends SizedNamedItem>(
  files: readonly T[],
  existingNames: readonly string[] = [],
): UploadValidationResult<T[]> {
  return validateUploadItems({
    items: files,
    existingNames,
    kind: "file",
    max: MAX_UPLOADED_FILES,
    label: "uploaded files",
    validateItem: (file) => {
      const ext = getFileExtension(file.name);
      if (!(UPLOADED_FILE_EXTENSIONS as readonly string[]).includes(ext)) {
        return `Unsupported file type: ${file.name}. Supported: ${UPLOADED_FILE_EXTENSIONS.join(", ")}`;
      }
      if (file.size > MAX_UPLOADED_FILE_SIZE_BYTES) {
        return `File too large: ${file.name} (${Math.round(file.size / 1024)}KB, max ${MAX_UPLOADED_FILE_SIZE_BYTES / 1024}KB)`;
      }
      return null;
    },
  });
}

export function validateUploadedImageSelection<T extends TypedSizedNamedItem>(
  images: readonly T[],
  existingNames: readonly string[] = [],
  label = "uploaded images",
): UploadValidationResult<T[]> {
  return validateUploadItems({
    items: images,
    existingNames,
    kind: "image",
    max: MAX_UPLOADED_IMAGES,
    label,
    validateItem: (image) => {
      if (!ALLOWED_IMAGE_MEDIA_TYPE_SET.has(image.type)) {
        return `Unsupported image type: ${image.type}. Supported: ${ALLOWED_IMAGE_MEDIA_TYPES.join(", ")}`;
      }
      if (image.size > MAX_UPLOADED_IMAGE_SIZE_BYTES) {
        return `Image too large: ${image.name} (${Math.round(image.size / 1024)}KB, max ${MAX_UPLOADED_IMAGE_SIZE_BYTES / 1024 / 1024}MB)`;
      }
      return null;
    },
  });
}

export function validateUploadedFilePayload(
  files: readonly UploadedFile[],
  existingNames: readonly string[] = [],
): UploadValidationResult<UploadedFile[]> {
  return validateUploadItems({
    items: files,
    existingNames,
    kind: "file",
    max: MAX_UPLOADED_FILES,
    label: "uploaded files",
    normalizeItems: trimNamedItems,
    validateItem: (file) => {
      const byteLength = new TextEncoder().encode(file.content).byteLength;
      if (byteLength > MAX_UPLOADED_FILE_SIZE_BYTES) {
        return `Uploaded file too large: ${file.name} (${byteLength} bytes, max ${MAX_UPLOADED_FILE_SIZE_BYTES})`;
      }
      if (hasNullBytes(file.content)) {
        return `Binary files are not supported: ${file.name}`;
      }
      return null;
    },
  });
}

export function validateUploadedImagePayload(
  images: readonly UploadedImage[],
  existingNames: readonly string[] = [],
): UploadValidationResult<UploadedImage[]> {
  return validateUploadItems({
    items: images,
    existingNames,
    kind: "image",
    max: MAX_UPLOADED_IMAGES,
    label: "uploaded images",
    normalizeItems: trimNamedItems,
    validateItem: (image) => {
      if (!ALLOWED_IMAGE_MEDIA_TYPE_SET.has(image.mediaType)) {
        return `Unsupported image type: ${image.mediaType}. Supported: ${ALLOWED_IMAGE_MEDIA_TYPES.join(", ")}`;
      }
      if (!image.data) {
        return `Uploaded image data must be a non-empty base64 string: ${image.name}`;
      }
      if (!isValidBase64(image.data)) {
        return `Invalid base64 data for image: ${image.name}`;
      }
      const decodedBytes = estimateDecodedBase64Bytes(image.data);
      if (decodedBytes > MAX_UPLOADED_IMAGE_SIZE_BYTES) {
        return `Uploaded image too large: ${image.name} (approx ${Math.round(decodedBytes / 1024 / 1024)}MB, max 5MB)`;
      }
      return null;
    },
  });
}

export function acceptUploadedImagePayload(
  image: UploadedImage,
  existingImages: readonly UploadedImage[],
): AcceptUploadedImagePayloadResult {
  const validation = validateUploadedImagePayload(
    [image],
    existingImages.map((existing) => existing.name),
  );
  if (!validation.ok) {
    return { ok: false, code: "invalid_payload", error: validation.error };
  }
  const acceptedImage = validation.value[0];
  if (!acceptedImage) {
    return { ok: false, code: "duplicate_name", error: "Duplicate attachment name" };
  }
  return { ok: true, image: acceptedImage };
}

export function validatePromptUploadSqlPayload(
  uploads: Partial<{
    promptText: string;
    replyToText: string;
    uploadedFiles: UploadedFile[];
    uploadedImages: UploadedImage[];
  }>,
): UploadValidationResult<void> {
  const promptText = uploads.promptText ?? "";
  const replyToText = uploads.replyToText ?? promptText;
  const uploadedFilesJson = uploads.uploadedFiles?.length ? JSON.stringify(uploads.uploadedFiles) : "";
  const uploadedImagesJson = uploads.uploadedImages?.length ? JSON.stringify(uploads.uploadedImages) : "";
  const encoder = new TextEncoder();
  const promptTextBytes = encoder.encode(promptText).byteLength;
  const replyToTextBytes = encoder.encode(replyToText).byteLength;
  const uploadJsonBytes = encoder.encode(uploadedFilesJson).byteLength + encoder.encode(uploadedImagesJson).byteLength;
  const byteLength = promptTextBytes + replyToTextBytes + uploadJsonBytes;
  const hasAttachments = (uploads.uploadedFiles?.length ?? 0) > 0 || (uploads.uploadedImages?.length ?? 0) > 0;
  if (uploadJsonBytes > MAX_PROMPT_SQL_PAYLOAD_BYTES) {
    return fail(
      `Uploaded prompt attachments are too large (${uploadJsonBytes} bytes, max ${MAX_PROMPT_SQL_PAYLOAD_BYTES}). Remove an attachment or use smaller images.`,
    );
  }
  if (byteLength > MAX_PROMPT_SQL_PAYLOAD_BYTES) {
    return fail(
      hasAttachments
        ? `Prompt and attachments are too large (${byteLength} bytes, max ${MAX_PROMPT_SQL_PAYLOAD_BYTES}). Shorten the prompt or remove an attachment.`
        : `Prompt is too large (${byteLength} bytes, max ${MAX_PROMPT_SQL_PAYLOAD_BYTES}). Shorten the prompt.`,
    );
  }
  return ok(undefined);
}

export function trimUploadedImagesToPromptBudget(params: {
  promptText: string;
  replyToText?: string;
  uploadedImages: readonly UploadedImage[];
  uploadedFiles?: readonly UploadedFile[];
}): { uploadedImages: UploadedImage[]; droppedCount: number } {
  const uploadedImages = [...params.uploadedImages];
  while (
    uploadedImages.length > 0 &&
    !validatePromptUploadSqlPayload({
      promptText: params.promptText,
      replyToText: params.replyToText,
      uploadedFiles: params.uploadedFiles ? [...params.uploadedFiles] : undefined,
      uploadedImages,
    }).ok
  ) {
    uploadedImages.pop();
  }
  return { uploadedImages, droppedCount: params.uploadedImages.length - uploadedImages.length };
}
