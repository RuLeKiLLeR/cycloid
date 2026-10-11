import { isValidSkillName, MAX_SKILLS_PER_PROMPT } from "../../../../../shared/skills/index.js";
import type { UploadedFile, UploadedImage } from "../../../../../shared/types/sandbox.js";
import { validateUploadedFilePayload, validateUploadedImagePayload } from "../../../../../shared/utils/uploads.js";
import { asNonEmptyString, jsonErrorResponse } from "../../utils";
import type { RouteParseResult } from "../shared";

export function parsePromptFilePaths(value: unknown): RouteParseResult<string[] | undefined> {
  if (!Array.isArray(value)) {
    return { ok: true, value: undefined };
  }

  const raw = value.flatMap((entry) => {
    const normalized = asNonEmptyString(entry);
    return normalized ? [normalized] : [];
  });
  for (const filePath of raw) {
    if (filePath.startsWith("/") || filePath.split("/").includes("..")) {
      return { ok: false, response: jsonErrorResponse(`Invalid file path: ${filePath}`, 400) };
    }
  }

  const files = [...new Set(raw)];
  if (files.length > 10) {
    return { ok: false, response: jsonErrorResponse("Maximum 10 file attachments", 400) };
  }
  return { ok: true, value: files.length > 0 ? files : undefined };
}

export function parseUploadedFilesPayload(value: unknown): RouteParseResult<UploadedFile[] | undefined> {
  if (!Array.isArray(value)) {
    return { ok: true, value: undefined };
  }

  const parsed: UploadedFile[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      return { ok: false, response: jsonErrorResponse("Invalid uploaded file entry", 400) };
    }
    const { name, content } = item as { name?: unknown; content?: unknown };
    if (typeof name !== "string") {
      return { ok: false, response: jsonErrorResponse("Uploaded file name must be a non-empty string", 400) };
    }
    if (typeof content !== "string") {
      return { ok: false, response: jsonErrorResponse(`Uploaded file content must be a string: ${name}`, 400) };
    }
    parsed.push({ name, content });
  }

  const validation = validateUploadedFilePayload(parsed);
  if (!validation.ok) {
    return { ok: false, response: jsonErrorResponse(validation.error, 400) };
  }

  return { ok: true, value: validation.value.length > 0 ? validation.value : undefined };
}

export function parseUploadedImagesPayload(value: unknown): RouteParseResult<UploadedImage[] | undefined> {
  if (!Array.isArray(value)) {
    return { ok: true, value: undefined };
  }

  const parsed: UploadedImage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      return { ok: false, response: jsonErrorResponse("Invalid uploaded image entry", 400) };
    }
    const { name, mediaType, data } = item as { name?: unknown; mediaType?: unknown; data?: unknown };
    if (typeof name !== "string") {
      return { ok: false, response: jsonErrorResponse("Uploaded image name must be a non-empty string", 400) };
    }
    if (typeof mediaType !== "string") {
      return {
        ok: false,
        response: jsonErrorResponse(`Unsupported image type: ${String(mediaType)}. Supported types are required.`, 400),
      };
    }
    if (typeof data !== "string") {
      return {
        ok: false,
        response: jsonErrorResponse(`Uploaded image data must be a non-empty base64 string: ${name}`, 400),
      };
    }
    parsed.push({ name, mediaType, data });
  }

  const validation = validateUploadedImagePayload(parsed);
  if (!validation.ok) {
    return { ok: false, response: jsonErrorResponse(validation.error, 400) };
  }

  return { ok: true, value: validation.value.length > 0 ? validation.value : undefined };
}

export function parseSkillsPayload(value: unknown): RouteParseResult<string[] | undefined> {
  if (!Array.isArray(value)) {
    return { ok: true, value: undefined };
  }

  const skills: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !isValidSkillName(item)) {
      return { ok: false, response: jsonErrorResponse("Invalid skill name", 400) };
    }
    if (!skills.includes(item)) skills.push(item);
  }

  if (skills.length > MAX_SKILLS_PER_PROMPT) {
    return { ok: false, response: jsonErrorResponse(`Maximum ${MAX_SKILLS_PER_PROMPT} skills per prompt`, 400) };
  }

  return { ok: true, value: skills.length > 0 ? skills : undefined };
}
