import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { FirstPartyDynamicToolImageContentItem } from "./first-party-dynamic-tools.js";

export const DYNAMIC_TOOL_IMAGE_ROOT = "/tmp/phase-evidence/desktop";
export const DYNAMIC_TOOL_IMAGE_MAX_BYTES = 2.5 * 1024 * 1024;
export const DYNAMIC_TOOL_IMAGE_MAX_WIDTH = 4096;
export const DYNAMIC_TOOL_IMAGE_MAX_HEIGHT = 4096;

export type DynamicToolImageMimeType = "image/jpeg" | "image/png" | "image/webp";
export type DynamicToolImageDetail = "high" | "low";

export type DynamicToolImageValidationErrorCode =
  | "not_absolute"
  | "path_traversal"
  | "outside_root"
  | "symlink"
  | "not_file"
  | "too_large"
  | "unsupported_mime_type"
  | "invalid_dimensions"
  | "dimension_limit_exceeded";

export type DynamicToolImageValidationResult =
  | { ok: true; item: FirstPartyDynamicToolImageContentItem }
  | { ok: false; code: DynamicToolImageValidationErrorCode; message: string };

export function desktopScenarioImageRoot(scenarioId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(scenarioId)) {
    throw new Error("Desktop image scenario id must be 1-80 URL-safe filename characters.");
  }
  return path.join(DYNAMIC_TOOL_IMAGE_ROOT, scenarioId);
}

export async function validateDynamicToolImageContentItem(params: {
  imagePath: string;
  rootDir: string;
  label: string;
  detail: DynamicToolImageDetail;
  maxBytes?: number;
  maxWidth?: number;
  maxHeight?: number;
}): Promise<DynamicToolImageValidationResult> {
  if (!path.isAbsolute(params.imagePath)) {
    return { ok: false, code: "not_absolute", message: "Dynamic tool image path must be absolute." };
  }
  if (params.imagePath.split(path.sep).includes("..")) {
    return { ok: false, code: "path_traversal", message: "Dynamic tool image path must not contain '..'." };
  }

  const rootRealPath = await realpath(params.rootDir).catch(() => null);
  if (!rootRealPath) {
    return { ok: false, code: "outside_root", message: "Dynamic tool image root does not exist." };
  }

  const requestedPath = path.resolve(params.imagePath);
  const requestedRoot = path.resolve(params.rootDir);
  if (!isPathInsideRoot(requestedPath, requestedRoot)) {
    return { ok: false, code: "outside_root", message: "Dynamic tool image path must stay inside its root." };
  }

  if (await pathContainsSymlink(requestedRoot, requestedPath)) {
    return { ok: false, code: "symlink", message: "Dynamic tool image paths must not contain symlinks." };
  }

  const fileRealPath = await realpath(params.imagePath).catch(() => null);
  if (!fileRealPath) {
    return { ok: false, code: "not_file", message: "Dynamic tool image path must point to a regular file." };
  }
  if (!isPathInsideRoot(fileRealPath, rootRealPath)) {
    return { ok: false, code: "outside_root", message: "Dynamic tool image path must stay inside its root." };
  }

  const fileStat = await stat(fileRealPath).catch(() => null);
  if (!fileStat?.isFile()) {
    return { ok: false, code: "not_file", message: "Dynamic tool image path must point to a regular file." };
  }

  const maxBytes = params.maxBytes ?? DYNAMIC_TOOL_IMAGE_MAX_BYTES;
  if (fileStat.size > maxBytes) {
    return {
      ok: false,
      code: "too_large",
      message: `Dynamic tool image is ${fileStat.size} bytes, exceeding the ${maxBytes} byte limit.`,
    };
  }

  const header = await readImageHeader(fileRealPath);
  const parsed = parseImageHeader(header);
  if (!parsed) {
    return {
      ok: false,
      code: "unsupported_mime_type",
      message: "Dynamic tool image must be a PNG, JPEG, or WebP file.",
    };
  }
  if (
    !Number.isSafeInteger(parsed.width) ||
    !Number.isSafeInteger(parsed.height) ||
    parsed.width < 1 ||
    parsed.height < 1
  ) {
    return { ok: false, code: "invalid_dimensions", message: "Dynamic tool image dimensions are invalid." };
  }

  const maxWidth = params.maxWidth ?? DYNAMIC_TOOL_IMAGE_MAX_WIDTH;
  const maxHeight = params.maxHeight ?? DYNAMIC_TOOL_IMAGE_MAX_HEIGHT;
  if (parsed.width > maxWidth || parsed.height > maxHeight) {
    return {
      ok: false,
      code: "dimension_limit_exceeded",
      message: `Dynamic tool image dimensions ${parsed.width}x${parsed.height} exceed ${maxWidth}x${maxHeight}.`,
    };
  }

  return {
    ok: true,
    item: {
      type: "inputImage",
      path: fileRealPath,
      mimeType: parsed.mimeType,
      label: params.label,
      detail: params.detail,
      width: parsed.width,
      height: parsed.height,
      bytes: fileStat.size,
    },
  };
}

export function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function pathContainsSymlink(rootRealPath: string, fileRealPath: string): Promise<boolean> {
  const relative = path.relative(rootRealPath, fileRealPath);
  let current = rootRealPath;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const entry = await lstat(current).catch(() => null);
    if (!entry) return false;
    if (entry.isSymbolicLink()) return true;
  }
  return false;
}

async function readImageHeader(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function parseImageHeader(
  buffer: Buffer,
): { mimeType: DynamicToolImageMimeType; width: number; height: number } | null {
  const webp = parseWebpDimensions(buffer);
  if (webp) return { mimeType: "image/webp", ...webp };
  const png = parsePngDimensions(buffer);
  if (png) return { mimeType: "image/png", ...png };
  const jpeg = parseJpegDimensions(buffer);
  if (jpeg) return { mimeType: "image/jpeg", ...jpeg };
  return null;
}

function parseWebpDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 16 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") {
    return null;
  }
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkType = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + chunkSize;
    if (payloadEnd > buffer.length) return null;
    if (chunkType === "VP8X" && chunkSize >= 10) {
      return {
        width: 1 + buffer.readUIntLE(payloadStart + 4, 3),
        height: 1 + buffer.readUIntLE(payloadStart + 7, 3),
      };
    }
    if (
      chunkType === "VP8 " &&
      chunkSize >= 10 &&
      buffer.subarray(payloadStart + 3, payloadStart + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))
    ) {
      return {
        width: buffer.readUInt16LE(payloadStart + 6) & 0x3fff,
        height: buffer.readUInt16LE(payloadStart + 8) & 0x3fff,
      };
    }
    if (chunkType === "VP8L" && chunkSize >= 5 && buffer[payloadStart] === 0x2f) {
      const width = 1 + ((buffer[payloadStart + 1] | (buffer[payloadStart + 2] << 8)) & 0x3fff);
      const height =
        1 +
        (((buffer[payloadStart + 2] >> 6) | (buffer[payloadStart + 3] << 2) | (buffer[payloadStart + 4] << 10)) &
          0x3fff);
      return { width, height };
    }
    offset = payloadEnd + (chunkSize % 2);
  }
  return null;
}

function parsePngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  if (!buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null;
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function parseJpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (offset + 2 > buffer.length) return null;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) return null;
    if (isJpegStartOfFrame(marker)) {
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
  }
  return null;
}

function isJpegStartOfFrame(marker: number | undefined): boolean {
  return (
    marker === 0xc0 ||
    marker === 0xc1 ||
    marker === 0xc2 ||
    marker === 0xc3 ||
    marker === 0xc5 ||
    marker === 0xc6 ||
    marker === 0xc7 ||
    marker === 0xc9 ||
    marker === 0xca ||
    marker === 0xcb ||
    marker === 0xcd ||
    marker === 0xce ||
    marker === 0xcf
  );
}
