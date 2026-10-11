import { writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

export const KNOWN_IMAGE_FIXTURE_WIDTH = 640;
export const KNOWN_IMAGE_FIXTURE_HEIGHT = 360;
export const KNOWN_IMAGE_FIXTURE_VISUAL_CODE = "VNC-742";
export const KNOWN_IMAGE_FIXTURE_POINTER = { x: 508, y: 232 } as const;

export type KnownImageVisualQuestion = {
  question: string;
  expectedAnswer: string;
};

export function buildKnownImageVisualQuestion(): KnownImageVisualQuestion {
  return {
    question: "Read the large black visual code in the image. Answer with only that code.",
    expectedAnswer: KNOWN_IMAGE_FIXTURE_VISUAL_CODE,
  };
}

export async function writeKnownImageFixturePng(outputPath: string): Promise<void> {
  await writeFile(outputPath, buildKnownImageFixturePng());
}

export function buildKnownImageFixturePng(): Buffer {
  const width = KNOWN_IMAGE_FIXTURE_WIDTH;
  const height = KNOWN_IMAGE_FIXTURE_HEIGHT;
  const pixels = Buffer.alloc(width * height * 3);
  fillRect(pixels, width, 0, 0, width, height, [244, 246, 248]);
  fillRect(pixels, width, 40, 40, 120, 92, [226, 75, 82]);
  fillRect(pixels, width, 180, 40, 120, 92, [52, 168, 83]);
  fillRect(pixels, width, 320, 40, 120, 92, [66, 133, 244]);
  fillRect(pixels, width, 460, 40, 120, 92, [251, 188, 5]);
  fillRect(pixels, width, 70, 175, 342, 72, [255, 255, 255]);
  drawText(pixels, width, 92, 194, KNOWN_IMAGE_FIXTURE_VISUAL_CODE, [15, 23, 42], 7);
  drawPointerMarker(pixels, width, KNOWN_IMAGE_FIXTURE_POINTER.x, KNOWN_IMAGE_FIXTURE_POINTER.y);
  return encodePng(width, height, pixels);
}

type Rgb = readonly [number, number, number];

const FONT_5X7: Record<string, readonly string[]> = {
  "2": ["11110", "00001", "00001", "11110", "10000", "10000", "11111"],
  "4": ["10010", "10010", "10010", "11111", "00010", "00010", "00010"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  V: ["10001", "10001", "10001", "10001", "01010", "01010", "00100"],
};

function fillRect(
  pixels: Buffer,
  width: number,
  x: number,
  y: number,
  rectWidth: number,
  rectHeight: number,
  color: Rgb,
): void {
  for (let row = y; row < y + rectHeight; row += 1) {
    for (let col = x; col < x + rectWidth; col += 1) {
      setPixel(pixels, width, col, row, color);
    }
  }
}

function drawText(pixels: Buffer, width: number, x: number, y: number, text: string, color: Rgb, scale: number): void {
  let cursor = x;
  for (const char of text) {
    const glyph = FONT_5X7[char];
    if (!glyph) {
      cursor += 6 * scale;
      continue;
    }
    for (let row = 0; row < glyph.length; row += 1) {
      const bits = glyph[row] ?? "";
      for (let col = 0; col < bits.length; col += 1) {
        if (bits[col] !== "1") continue;
        fillRect(pixels, width, cursor + col * scale, y + row * scale, scale, scale, color);
      }
    }
    cursor += 6 * scale;
  }
}

function drawPointerMarker(pixels: Buffer, width: number, x: number, y: number): void {
  fillRect(pixels, width, x - 2, y - 28, 4, 56, [15, 23, 42]);
  fillRect(pixels, width, x - 28, y - 2, 56, 4, [15, 23, 42]);
  fillRect(pixels, width, x - 10, y - 10, 20, 20, [255, 255, 255]);
  fillRect(pixels, width, x - 6, y - 6, 12, 12, [15, 23, 42]);
}

function setPixel(pixels: Buffer, width: number, x: number, y: number, color: Rgb): void {
  const height = pixels.length / (width * 3);
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const offset = (y * width + x) * 3;
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
}

function encodePng(width: number, height: number, rgbPixels: Buffer): Buffer {
  const scanlines = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const targetOffset = row * (width * 3 + 1);
    scanlines[targetOffset] = 0;
    rgbPixels.copy(scanlines, targetOffset + 1, row * width * 3, (row + 1) * width * 3);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", buildIhdr(width, height)),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function buildIhdr(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return ihdr;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
