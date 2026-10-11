import { randomBytes } from "crypto";
import { describe, expect, it } from "vitest";

import {
  JPEG_CONVERSION_QUALITY,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_MEGAPIXELS,
  PNG_JPEG_CONVERSION_THRESHOLD,
} from "../../apps/sandbox-bridge/src/constants/bridge.js";
import { processUploadedImage } from "../../apps/sandbox-bridge/src/services/image-processing.js";
import { buildImageParts, estimateImageTokens } from "../../apps/sandbox-bridge/src/utils/uploaded-images.js";

const sharp = (await import("sharp")).default;

async function makeSolidImageBase64(width: number, height: number, format: "png" | "jpeg"): Promise<string> {
  const buffer = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 120, g: 40, b: 200 },
    },
  })
    [format]()
    .toBuffer();

  return buffer.toString("base64");
}

async function makeNoisyPngBase64(width: number, height: number): Promise<string> {
  const raw = randomBytes(width * height * 3);

  const buffer = await sharp(raw, {
    raw: {
      width,
      height,
      channels: 3,
    },
  })
    .png()
    .toBuffer();

  return buffer.toString("base64");
}

const PNG_BASE64 = await makeSolidImageBase64(1, 1, "png");

describe("buildImageParts", () => {
  it("builds a data URL for allowed image types", () => {
    const parts = buildImageParts([{ name: "screenshot.png", mediaType: "image/png", data: PNG_BASE64 }]);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      type: "file",
      mime: "image/png",
      filename: "screenshot.png",
      url: `data:image/png;base64,${PNG_BASE64}`,
    });
  });

  it("filters out invalid images and preserves order", () => {
    const parts = buildImageParts([
      { name: "bad.bmp", mediaType: "image/bmp", data: PNG_BASE64 },
      { name: "first.png", mediaType: "image/png", data: "aaa" },
      { name: "empty.png", mediaType: "image/png", data: "" },
      { name: "second.jpg", mediaType: "image/jpeg", data: "bbb" },
    ]);

    expect(parts).toHaveLength(2);
    expect(parts[0].filename).toBe("first.png");
    expect(parts[1].filename).toBe("second.jpg");
  });
});

describe("estimateImageTokens", () => {
  it("returns zero for non-positive dimensions", () => {
    expect(estimateImageTokens(0, 100)).toBe(0);
    expect(estimateImageTokens(100, 0)).toBe(0);
  });

  it("uses the configured pixel heuristic", () => {
    expect(estimateImageTokens(750, 1)).toBe(1);
    expect(estimateImageTokens(768, 768)).toBe(Math.ceil((768 * 768) / 750));
  });
});

describe("processUploadedImage", () => {
  it("passes through small images without resizing or conversion", async () => {
    const originalData = await makeSolidImageBase64(640, 480, "jpeg");

    const image = await processUploadedImage({
      name: "small.jpg",
      mediaType: "image/jpeg",
      data: originalData,
    });

    expect(image.image.mediaType).toBe("image/jpeg");
    expect(image.image.data).toBe(originalData);
    expect(image.width).toBe(640);
    expect(image.height).toBe(480);
    expect(image.resized).toBe(false);
    expect(image.formatConverted).toBe(false);
  });

  it("resizes images whose longest edge exceeds the cap", async () => {
    const originalData = await makeSolidImageBase64(3_000, 1_000, "png");

    const image = await processUploadedImage({
      name: "wide.png",
      mediaType: "image/png",
      data: originalData,
    });

    expect(image.resized).toBe(true);
    expect(image.width).toBe(MAX_IMAGE_DIMENSION);
    expect(image.height).toBe(523);
  });

  it("converts large PNG uploads to jpeg", async () => {
    const largePngData = await makeNoisyPngBase64(1_024, 1_024);
    expect(Buffer.byteLength(largePngData, "base64")).toBeGreaterThan(PNG_JPEG_CONVERSION_THRESHOLD);

    const image = await processUploadedImage({
      name: "large.png",
      mediaType: "image/png",
      data: largePngData,
    });

    expect(image.image.mediaType).toBe("image/jpeg");
    expect(image.formatConverted).toBe(true);

    const jpegBytes = Buffer.from(image.image.data, "base64");
    expect(jpegBytes[0]).toBe(0xff);
    expect(jpegBytes[1]).toBe(0xd8);

    const metadata = await sharp(jpegBytes).metadata();
    expect(metadata.format).toBe("jpeg");
    expect(image.outputBytes).toBeGreaterThan(0);
    expect(JPEG_CONVERSION_QUALITY).toBe(85);
  });

  it("returns the original image with a warning when megapixels exceed the guardrail", async () => {
    const overLimitSide = Math.ceil(Math.sqrt((MAX_IMAGE_MEGAPIXELS + 1) * 1_000_000));
    const originalData = await makeSolidImageBase64(overLimitSide, overLimitSide, "png");

    const image = await processUploadedImage({
      name: "huge.png",
      mediaType: "image/png",
      data: originalData,
    });

    expect(image.warning).toContain(`${MAX_IMAGE_MEGAPIXELS}`);
    expect(image.image.data).toBe(originalData);
    expect(image.resized).toBe(false);
    expect(image.formatConverted).toBe(false);
  });

  it("throws on corrupt image data", async () => {
    const invalidData = Buffer.from("not an image").toString("base64");

    await expect(
      processUploadedImage({
        name: "broken.png",
        mediaType: "image/png",
        data: invalidData,
      }),
    ).rejects.toThrow("unsupported image format");
  });
});
