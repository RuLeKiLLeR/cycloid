import type { UploadedImage } from "../../../../shared/types/sandbox.js";

const ALLOWED_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type ImagePart = {
  type: "file";
  mime: string;
  filename: string;
  url: string;
};

const IMAGE_TOKEN_ESTIMATE_DIVISOR = 750;

export function estimateImageTokens(width: number, height: number): number {
  if (width <= 0 || height <= 0) return 0;
  return Math.ceil((width * height) / IMAGE_TOKEN_ESTIMATE_DIVISOR);
}

/**
 * Convert uploaded image records into prompt image parts.
 * Images are encoded as data URLs for transport to the bridge adapter; the
 * Codex adapter materializes them to local files before invoking the SDK.
 */
export function buildImageParts(uploadedImages: UploadedImage[]): ImagePart[] {
  return uploadedImages
    .filter((img) => ALLOWED_MEDIA_TYPES.has(img.mediaType) && img.data.length > 0)
    .map((img) => ({
      type: "file" as const,
      mime: img.mediaType,
      filename: img.name,
      url: `data:${img.mediaType};base64,${img.data}`,
    }));
}
