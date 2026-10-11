import sharp from "sharp";

import type { UploadedImage } from "../../../../shared/types/sandbox.js";
import {
  JPEG_CONVERSION_QUALITY,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_MEGAPIXELS,
  PNG_JPEG_CONVERSION_THRESHOLD,
} from "../constants/bridge.js";

export type ProcessedUploadedImage = {
  image: UploadedImage;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
  originalBytes: number;
  outputBytes: number;
  resized: boolean;
  formatConverted: boolean;
  warning?: string;
};

function getTargetDimensions(width: number, height: number): { width: number; height: number } {
  const longestEdge = Math.max(width, height);
  if (longestEdge <= MAX_IMAGE_DIMENSION) return { width, height };

  const scale = MAX_IMAGE_DIMENSION / longestEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export async function processUploadedImage(image: UploadedImage): Promise<ProcessedUploadedImage> {
  const inputBuffer = Buffer.from(image.data, "base64");
  const inputBytes = inputBuffer.byteLength;
  const metadata = await sharp(inputBuffer).metadata();
  const { width, height } = metadata;

  if (!width || !height) {
    throw new Error(`Image metadata missing dimensions for ${image.name}`);
  }

  const megapixels = (width * height) / 1_000_000;
  if (megapixels > MAX_IMAGE_MEGAPIXELS) {
    return {
      image,
      originalWidth: width,
      originalHeight: height,
      width,
      height,
      originalBytes: inputBytes,
      outputBytes: inputBytes,
      resized: false,
      formatConverted: false,
      warning: `Image exceeds ${MAX_IMAGE_MEGAPIXELS} megapixels`,
    };
  }

  const target = getTargetDimensions(width, height);
  const resized = target.width !== width || target.height !== height;
  const shouldConvertToJpeg = image.mediaType === "image/png" && inputBytes > PNG_JPEG_CONVERSION_THRESHOLD;

  if (!resized && !shouldConvertToJpeg) {
    return {
      image,
      originalWidth: width,
      originalHeight: height,
      width,
      height,
      originalBytes: inputBytes,
      outputBytes: inputBytes,
      resized: false,
      formatConverted: false,
    };
  }

  let pipeline = sharp(inputBuffer);
  if (resized) {
    pipeline = pipeline.resize({
      width: target.width,
      height: target.height,
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  let mediaType = image.mediaType;
  if (shouldConvertToJpeg) {
    pipeline = pipeline.jpeg({ quality: JPEG_CONVERSION_QUALITY });
    mediaType = "image/jpeg";
  }

  const outputBuffer = await pipeline.toBuffer();
  return {
    image: {
      ...image,
      mediaType,
      data: outputBuffer.toString("base64"),
    },
    originalWidth: width,
    originalHeight: height,
    width: target.width,
    height: target.height,
    originalBytes: inputBytes,
    outputBytes: outputBuffer.byteLength,
    resized,
    formatConverted: shouldConvertToJpeg,
  };
}
