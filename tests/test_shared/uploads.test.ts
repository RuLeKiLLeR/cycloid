import { describe, expect, it } from "vitest";

import type { UploadedFile, UploadedImage } from "../../shared/types/sandbox.js";
import {
  estimateDecodedBase64Bytes,
  isValidBase64,
  validatePromptUploadSqlPayload,
  validateUploadedFilePayload,
  validateUploadedFileSelection,
  validateUploadedImagePayload,
  validateUploadedImageSelection,
} from "../../shared/utils/uploads.js";

describe("validateUploadedFilePayload", () => {
  it("rejects binary file content", () => {
    const files: UploadedFile[] = [{ name: "binary.txt", content: "abc\0def" }];
    expect(validateUploadedFilePayload(files)).toEqual({
      ok: false,
      error: "Binary files are not supported: binary.txt",
    });
  });

  it("trims names and drops duplicates by name", () => {
    const files: UploadedFile[] = [
      { name: "  notes.txt  ", content: "hello" },
      { name: "notes.txt", content: "ignored duplicate" },
    ];

    expect(validateUploadedFilePayload(files)).toEqual({
      ok: true,
      value: [{ name: "notes.txt", content: "hello" }],
    });
  });

  it("rejects empty names after payload normalization", () => {
    const files: UploadedFile[] = [{ name: "   ", content: "hello" }];
    expect(validateUploadedFilePayload(files)).toEqual({
      ok: false,
      error: "Uploaded file name must be a non-empty string",
    });
  });
});

describe("validateUploadedFileSelection", () => {
  it("rejects path-like names through the shared name validation stage", () => {
    const files = [{ name: "nested/notes.txt", size: 10 }];
    expect(validateUploadedFileSelection(files)).toEqual({
      ok: false,
      error: "Invalid uploaded file name: nested/notes.txt",
    });
  });
});

describe("validateUploadedImageSelection", () => {
  it("rejects unsupported media types", () => {
    const images = [{ name: "diagram.bmp", size: 100, type: "image/bmp" }];
    expect(validateUploadedImageSelection(images)).toEqual({
      ok: false,
      error: "Unsupported image type: image/bmp. Supported: image/png, image/jpeg, image/gif, image/webp",
    });
  });

  it("deduplicates within-batch duplicate image names before validation", () => {
    const images = [
      { name: "keep.png", size: 100, type: "image/png" },
      { name: "keep.png", size: 200, type: "image/png" },
      { name: "new.png", size: 300, type: "image/png" },
    ];

    expect(validateUploadedImageSelection(images, [])).toEqual({
      ok: true,
      value: [images[0], images[2]],
    });
  });
});

describe("validateUploadedImagePayload", () => {
  it("rejects invalid base64 payloads", () => {
    const images: UploadedImage[] = [{ name: "diagram.png", mediaType: "image/png", data: "not-valid-base64!!!" }];
    expect(validateUploadedImagePayload(images)).toEqual({
      ok: false,
      error: "Invalid base64 data for image: diagram.png",
    });
  });

  it("reports invalid base64 before size when a payload is both malformed and huge", () => {
    const images: UploadedImage[] = [{ name: "diagram.png", mediaType: "image/png", data: "!".repeat(7_000_000) }];
    expect(validateUploadedImagePayload(images)).toEqual({
      ok: false,
      error: "Invalid base64 data for image: diagram.png",
    });
  });

  it("rejects oversized decoded payloads", () => {
    const images: UploadedImage[] = [{ name: "diagram.png", mediaType: "image/png", data: "A".repeat(7_000_000) }];
    expect(validateUploadedImagePayload(images)).toEqual({
      ok: false,
      error: "Uploaded image too large: diagram.png (approx 5MB, max 5MB)",
    });
  });

  it("trims image names and drops duplicates by name", () => {
    const images: UploadedImage[] = [
      { name: "  diagram.png  ", mediaType: "image/png", data: "aGVsbG8=" },
      { name: "diagram.png", mediaType: "image/png", data: "aGVsbG8=" },
    ];

    expect(validateUploadedImagePayload(images)).toEqual({
      ok: true,
      value: [{ name: "diagram.png", mediaType: "image/png", data: "aGVsbG8=" }],
    });
  });
});

describe("validatePromptUploadSqlPayload", () => {
  it("warns when base64 image JSON would exceed the prompt storage budget", () => {
    const images: UploadedImage[] = [{ name: "large.png", mediaType: "image/png", data: "A".repeat(2_400_000) }];

    const result = validatePromptUploadSqlPayload({ uploadedImages: images });

    expect(result).toEqual({
      ok: false,
      error:
        "Uploaded prompt attachments are too large (2400056 bytes, max 1800000). Remove an attachment or use smaller images.",
    });
  });

  it("rejects a large prompt combined with near-limit attachment JSON", () => {
    const images: UploadedImage[] = [{ name: "large.png", mediaType: "image/png", data: "A".repeat(1_790_000) }];

    const result = validatePromptUploadSqlPayload({
      promptText: "x".repeat(20_000),
      uploadedImages: images,
    });

    expect(result).toEqual({
      ok: false,
      error:
        "Prompt and attachments are too large (1830056 bytes, max 1800000). Shorten the prompt or remove an attachment.",
    });
  });

  it("counts duplicated reply text in the prompt row budget by default", () => {
    const images: UploadedImage[] = [{ name: "large.png", mediaType: "image/png", data: "A".repeat(1_790_000) }];

    const result = validatePromptUploadSqlPayload({
      promptText: "x".repeat(5_000),
      uploadedImages: images,
    });

    expect(result).toEqual({
      ok: false,
      error:
        "Prompt and attachments are too large (1800056 bytes, max 1800000). Shorten the prompt or remove an attachment.",
    });
  });

  it("uses a prompt-only error when no attachments are present", () => {
    const result = validatePromptUploadSqlPayload({
      promptText: "x".repeat(900_001),
    });

    expect(result).toEqual({
      ok: false,
      error: "Prompt is too large (1800002 bytes, max 1800000). Shorten the prompt.",
    });
  });
});

describe("base64 helpers", () => {
  it("accepts padded base64 data", () => {
    expect(isValidBase64("aGVsbG8=")).toBe(true);
  });

  it("estimates decoded size from encoded length", () => {
    expect(estimateDecodedBase64Bytes("QUJDRA==")).toBe(4);
  });
});
