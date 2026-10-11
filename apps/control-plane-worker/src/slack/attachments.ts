import { MAX_UPLOADED_FILE_SIZE_BYTES, MAX_UPLOADED_IMAGE_SIZE_BYTES } from "../../../../shared/constants/uploads.js";
import type { UploadedFile, UploadedImage } from "../../../../shared/types/sandbox.js";
import {
  acceptUploadedImagePayload,
  arrayBufferToBase64,
  isSupportedImageMimeType,
  validateUploadedFilePayload,
} from "../../../../shared/utils/uploads.js";
import {
  SLACK_API_BASE,
  SLACK_MAX_ATTACHMENTS_PER_EVENT,
  SLACK_MAX_ATTACHMENTS_PER_THREAD,
  SLACK_TEXT_ATTACHMENT_EXTENSIONS,
  SLACK_TEXT_ATTACHMENT_MIME_TYPES,
} from "../constants/slack";
import { createLogger } from "../logger";
import { tracedFetch } from "../observability/wrappers";
import { normalizeWebhookReference } from "../utils";

const log = createLogger({ bindings: { component: "slack-attachments" } });

const TEXT_ATTACHMENT_MIME_TYPE_SET = new Set<string>(SLACK_TEXT_ATTACHMENT_MIME_TYPES);
const TEXT_ATTACHMENT_EXTENSION_SET = new Set<string>(SLACK_TEXT_ATTACHMENT_EXTENSIONS);

type SlackAttachmentSkipCode =
  | "download_failed"
  | "download_url_unavailable"
  | "duplicate_name"
  | "external_file"
  | "invalid_payload"
  | "metadata_failed"
  | "too_large"
  | "too_many"
  | "unsupported_type"
  | "utf8_decode_failed";

export interface SkippedSlackAttachment {
  filename: string;
  code: SlackAttachmentSkipCode;
  reason: string;
}

export interface SlackAttachmentResult {
  uploadedFiles: UploadedFile[];
  uploadedImages: UploadedImage[];
  skipped: SkippedSlackAttachment[];
}

interface ProcessSlackAttachmentOptions {
  downloadSupported?: boolean;
}

interface SlackFilesInfoResponse {
  ok: boolean;
  error?: string;
  file?: Record<string, unknown>;
}

interface SlackFileInfo {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  urlPrivateDownload: string | null;
  urlPrivate: string | null;
  isExternal: boolean;
  mode: string | null;
}

interface SlackAttachmentRefs {
  fileIds: string[];
  omittedCount: number;
}

function normalizeSlackFileSize(rawValue: unknown): number | null {
  return typeof rawValue === "number" && Number.isFinite(rawValue) && rawValue >= 0 ? rawValue : null;
}

function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  return lastDot >= 0 ? filename.slice(lastDot).toLowerCase() : "";
}

function isSupportedTextAttachment(name: string, mimetype: string): boolean {
  const normalizedMime = mimetype.toLowerCase();
  if (normalizedMime.startsWith("text/")) return true;
  if (TEXT_ATTACHMENT_MIME_TYPE_SET.has(normalizedMime)) return true;
  return TEXT_ATTACHMENT_EXTENSION_SET.has(getFileExtension(name));
}

function hasSafeSlackDownloadHost(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && (url.hostname === "slack.com" || url.hostname.endsWith(".slack.com"));
  } catch {
    return false;
  }
}

function makeSkip(filename: string | null, code: SlackAttachmentSkipCode, reason: string): SkippedSlackAttachment {
  return {
    filename: filename?.trim() || "Slack attachment",
    code,
    reason,
  };
}

function collectSlackAttachmentRefs(
  event: Record<string, unknown>,
  maxAttachments = SLACK_MAX_ATTACHMENTS_PER_EVENT,
): SlackAttachmentRefs {
  const seen = new Set<string>();
  let omittedCount = 0;

  const addFileId = (rawValue: unknown) => {
    const fileId = normalizeWebhookReference(rawValue);
    if (!fileId) return;
    if (seen.has(fileId)) return;
    if (seen.size >= maxAttachments) {
      omittedCount += 1;
      return;
    }
    seen.add(fileId);
  };

  if (Array.isArray(event.files)) {
    for (const file of event.files) {
      if (file && typeof file === "object") {
        addFileId((file as Record<string, unknown>).id);
      }
    }
  }

  if (Array.isArray(event.attachments)) {
    for (const attachment of event.attachments) {
      if (attachment && typeof attachment === "object") {
        addFileId((attachment as Record<string, unknown>).file_id);
      }
    }
  }

  return { fileIds: [...seen], omittedCount };
}

function collectSlackAttachmentRefsFromMessages(
  messages: readonly Record<string, unknown>[],
  maxAttachments = SLACK_MAX_ATTACHMENTS_PER_THREAD,
): SlackAttachmentRefs {
  const seen = new Set<string>();
  let omittedCount = 0;

  for (const message of messages) {
    const refs = collectSlackAttachmentRefs(message, Number.MAX_SAFE_INTEGER);
    for (const fileId of refs.fileIds) {
      if (seen.has(fileId)) continue;
      if (seen.size >= maxAttachments) {
        omittedCount += 1;
        continue;
      }
      seen.add(fileId);
    }
  }

  return { fileIds: [...seen], omittedCount };
}

export function extractSlackAttachmentRefsFromEvent(event: Record<string, unknown> | undefined): SlackAttachmentRefs {
  if (!event) return { fileIds: [], omittedCount: 0 };
  return collectSlackAttachmentRefs(event);
}

export function extractSlackAttachmentRefsFromMessages(
  messages: readonly Record<string, unknown>[],
): SlackAttachmentRefs {
  return collectSlackAttachmentRefsFromMessages(messages);
}

export function extractSlackFileIdsFromEvent(event: Record<string, unknown> | undefined): string[] {
  return extractSlackAttachmentRefsFromEvent(event).fileIds;
}

export function hasSlackFileAttachments(event: Record<string, unknown> | undefined): boolean {
  return extractSlackFileIdsFromEvent(event).length > 0;
}

async function fetchSlackFileInfo(token: string, fileId: string): Promise<SlackFileInfo | null> {
  const params = new URLSearchParams({ file: fileId });
  try {
    const response = await tracedFetch(
      `${SLACK_API_BASE}/files.info?${params}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      },
      "slack.files.info",
    );
    if (!response.ok) {
      log.warn({ fileId, httpStatus: response.status }, "Slack files.info HTTP request failed");
      return null;
    }

    const result = (await response.json()) as SlackFilesInfoResponse;
    if (!result.ok || !result.file) {
      log.warn({ fileId, slackError: result.error }, "Slack files.info returned an error");
      return null;
    }

    const file = result.file;
    const name = normalizeWebhookReference(file.name) ?? normalizeWebhookReference(file.title) ?? "Slack attachment";
    const size = normalizeSlackFileSize(file.size);
    if (size === null) {
      log.warn({ fileId }, "Slack files.info returned invalid file size");
      return null;
    }

    return {
      id: fileId,
      name,
      mimetype: normalizeWebhookReference(file.mimetype)?.toLowerCase() ?? "application/octet-stream",
      size,
      urlPrivateDownload: normalizeWebhookReference(file.url_private_download),
      urlPrivate: normalizeWebhookReference(file.url_private),
      isExternal: file.is_external === true,
      mode: normalizeWebhookReference(file.mode),
    };
  } catch (error) {
    log.warn({ fileId, error: String(error) }, "Failed to fetch Slack file metadata");
    return null;
  }
}

async function downloadSlackFile(
  token: string,
  fileInfo: SlackFileInfo,
  maxBytes: number,
): Promise<ArrayBuffer | null> {
  const downloadUrl = fileInfo.urlPrivateDownload ?? fileInfo.urlPrivate;
  if (!downloadUrl || !hasSafeSlackDownloadHost(downloadUrl)) {
    return null;
  }

  try {
    const response = await tracedFetch(
      downloadUrl,
      {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      },
      "slack.file.download",
    );
    if (!response.ok) {
      log.warn({ fileId: fileInfo.id, httpStatus: response.status }, "Slack file download failed");
      return null;
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const parsedLength = Number(contentLength);
      if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
        log.warn({ fileId: fileInfo.id, contentLength: parsedLength, maxBytes }, "Slack file content-length too large");
        return null;
      }
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      log.warn({ fileId: fileInfo.id, byteLength: buffer.byteLength, maxBytes }, "Slack file body too large");
      return null;
    }
    return buffer;
  } catch (error) {
    log.warn({ fileId: fileInfo.id, error: String(error) }, "Failed to download Slack file");
    return null;
  }
}

function acceptUploadedFile(result: SlackAttachmentResult, file: UploadedFile): void {
  const validation = validateUploadedFilePayload(
    [file],
    result.uploadedFiles.map((existing) => existing.name),
  );
  if (!validation.ok) {
    result.skipped.push(makeSkip(file.name, "invalid_payload", validation.error));
    return;
  }
  if (validation.value.length === 0) {
    result.skipped.push(makeSkip(file.name, "duplicate_name", "Duplicate attachment name"));
    return;
  }
  result.uploadedFiles.push(validation.value[0]);
}

function acceptUploadedImage(result: SlackAttachmentResult, image: UploadedImage): void {
  const accepted = acceptUploadedImagePayload(image, result.uploadedImages);
  if (!accepted.ok) {
    result.skipped.push(makeSkip(image.name, accepted.code, accepted.error));
    return;
  }
  result.uploadedImages.push(accepted.image);
}

async function processSlackFile(
  token: string,
  fileId: string,
  result: SlackAttachmentResult,
  options: ProcessSlackAttachmentOptions,
): Promise<void> {
  const fileInfo = await fetchSlackFileInfo(token, fileId);
  if (!fileInfo) {
    result.skipped.push(makeSkip(null, "metadata_failed", "Unable to read file metadata from Slack"));
    return;
  }

  if (fileInfo.isExternal || fileInfo.mode === "external" || fileInfo.mode === "remote") {
    result.skipped.push(makeSkip(fileInfo.name, "external_file", "External Slack files are not supported"));
    return;
  }

  if (isSupportedImageMimeType(fileInfo.mimetype)) {
    if (fileInfo.size > MAX_UPLOADED_IMAGE_SIZE_BYTES) {
      result.skipped.push(makeSkip(fileInfo.name, "too_large", "Image is larger than the 5 MB limit"));
      return;
    }
    if (!fileInfo.urlPrivateDownload && !fileInfo.urlPrivate) {
      result.skipped.push(makeSkip(fileInfo.name, "download_url_unavailable", "Slack did not provide a download URL"));
      return;
    }
    if (options.downloadSupported === false) return;

    const buffer = await downloadSlackFile(token, fileInfo, MAX_UPLOADED_IMAGE_SIZE_BYTES);
    if (!buffer) {
      result.skipped.push(makeSkip(fileInfo.name, "download_failed", "Unable to download image from Slack"));
      return;
    }

    acceptUploadedImage(result, {
      name: fileInfo.name,
      mediaType: fileInfo.mimetype,
      data: arrayBufferToBase64(buffer),
    });
    return;
  }

  if (!isSupportedTextAttachment(fileInfo.name, fileInfo.mimetype)) {
    result.skipped.push(makeSkip(fileInfo.name, "unsupported_type", `Unsupported file type: ${fileInfo.mimetype}`));
    return;
  }

  if (fileInfo.size > MAX_UPLOADED_FILE_SIZE_BYTES) {
    result.skipped.push(makeSkip(fileInfo.name, "too_large", "File is larger than the 100 KB limit"));
    return;
  }
  if (!fileInfo.urlPrivateDownload && !fileInfo.urlPrivate) {
    result.skipped.push(makeSkip(fileInfo.name, "download_url_unavailable", "Slack did not provide a download URL"));
    return;
  }
  if (options.downloadSupported === false) return;

  const buffer = await downloadSlackFile(token, fileInfo, MAX_UPLOADED_FILE_SIZE_BYTES);
  if (!buffer) {
    result.skipped.push(makeSkip(fileInfo.name, "download_failed", "Unable to download file from Slack"));
    return;
  }

  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    acceptUploadedFile(result, { name: fileInfo.name, content });
  } catch {
    result.skipped.push(makeSkip(fileInfo.name, "utf8_decode_failed", "File is not valid UTF-8 text"));
  }
}

export async function processSlackAttachments(
  token: string,
  event: Record<string, unknown> | undefined,
  options: ProcessSlackAttachmentOptions = {},
): Promise<SlackAttachmentResult> {
  return processSlackAttachmentsFromMessages(token, event ? [event] : [], options);
}

export async function processSlackAttachmentsFromMessages(
  token: string,
  messages: readonly Record<string, unknown>[],
  options: ProcessSlackAttachmentOptions = {},
): Promise<SlackAttachmentResult> {
  const result: SlackAttachmentResult = { uploadedFiles: [], uploadedImages: [], skipped: [] };
  if (messages.length === 0) return result;

  const refs = collectSlackAttachmentRefsFromMessages(messages);
  if (refs.omittedCount > 0) {
    result.skipped.push(
      makeSkip(
        "additional attachments",
        "too_many",
        `Only the first ${SLACK_MAX_ATTACHMENTS_PER_THREAD} Slack attachments are processed`,
      ),
    );
  }
  if (refs.fileIds.length === 0) return result;

  log.info({ count: refs.fileIds.length, omittedCount: refs.omittedCount }, "Processing Slack attachments");
  for (const fileId of refs.fileIds) {
    await processSlackFile(token, fileId, result, options);
  }

  log.info(
    {
      uploadedFiles: result.uploadedFiles.length,
      uploadedImages: result.uploadedImages.length,
      skipped: result.skipped.map((skip) => skip.code),
    },
    "Processed Slack attachments",
  );
  return result;
}
