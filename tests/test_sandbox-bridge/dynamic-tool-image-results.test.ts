import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DYNAMIC_TOOL_IMAGE_ROOT,
  validateDynamicToolImageContentItem,
} from "../../apps/sandbox-bridge/src/services/dynamic-tool-image-results.js";
import {
  buildAllDynamicToolSpecs,
  executeFirstPartyDynamicToolCall,
  serializeFirstPartyDynamicToolResultForPersistence,
} from "../../apps/sandbox-bridge/src/services/first-party-dynamic-tools.js";
import { KNOWN_IMAGE_FIXTURE_DYNAMIC_TOOL_NAME } from "../../apps/sandbox-bridge/src/services/known-image-dynamic-tool.js";
import {
  buildKnownImageVisualQuestion,
  KNOWN_IMAGE_FIXTURE_HEIGHT,
  KNOWN_IMAGE_FIXTURE_VISUAL_CODE,
  KNOWN_IMAGE_FIXTURE_WIDTH,
  writeKnownImageFixturePng,
} from "../../apps/sandbox-bridge/src/services/visual-feedback-fixture.js";

const WEBP_1280X720_BASE64 =
  "UklGRk4AAABXRUJQVlA4TEEAAAAv/8SzAAdQwIIUuP8BBW3bMOUPvzuO6H+G//znP//5z3/+85///Oc///nPf/7zn//85z//+c9//vOf//znP/+rAQA=";

describe("dynamic tool image result validation", () => {
  let rootDir: string;

  beforeEach(async () => {
    await mkdir(DYNAMIC_TOOL_IMAGE_ROOT, { recursive: true });
    rootDir = await mkdtemp(path.join(DYNAMIC_TOOL_IMAGE_ROOT, "unit-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  async function validate(imagePath: string, options: { maxBytes?: number; maxWidth?: number } = {}) {
    return validateDynamicToolImageContentItem({
      imagePath,
      rootDir,
      label: "unit image",
      detail: "high",
      ...options,
    });
  }

  it("accepts a safe PNG and reports metadata without bytes", async () => {
    const imagePath = path.join(rootDir, "known.png");
    await writeKnownImageFixturePng(imagePath);

    const result = await validate(imagePath);

    expect(result).toEqual({
      ok: true,
      item: {
        type: "inputImage",
        path: expect.stringContaining("known.png"),
        mimeType: "image/png",
        label: "unit image",
        detail: "high",
        width: KNOWN_IMAGE_FIXTURE_WIDTH,
        height: KNOWN_IMAGE_FIXTURE_HEIGHT,
        bytes: expect.any(Number),
      },
    });
    if (result.ok) expect(JSON.stringify(result.item)).not.toContain("base64");
  });

  it("accepts a direct WebP and reports its dimensions and MIME", async () => {
    const imagePath = path.join(rootDir, "desktop.webp");
    await writeFile(imagePath, Buffer.from(WEBP_1280X720_BASE64, "base64"));

    const result = await validate(imagePath);

    expect(result).toMatchObject({
      ok: true,
      item: {
        mimeType: "image/webp",
        width: 1280,
        height: 720,
        bytes: Buffer.from(WEBP_1280X720_BASE64, "base64").length,
      },
    });
  });

  it("rejects non-absolute paths", async () => {
    const result = await validate("known.png");

    expect(result).toMatchObject({ ok: false, code: "not_absolute" });
  });

  it("rejects path traversal before resolving the file", async () => {
    const imagePath = path.join(rootDir, "known.png");
    await writeKnownImageFixturePng(imagePath);

    const result = await validate(`${rootDir}${path.sep}nested${path.sep}..${path.sep}known.png`);

    expect(result).toMatchObject({ ok: false, code: "path_traversal" });
  });

  it("rejects paths outside the image root", async () => {
    const outsidePath = path.join(path.dirname(rootDir), "outside.png");
    await writeKnownImageFixturePng(outsidePath);

    const result = await validate(outsidePath);

    expect(result).toMatchObject({ ok: false, code: "outside_root" });
    await rm(outsidePath, { force: true });
  });

  it("rejects symlinked image paths", async () => {
    const targetPath = path.join(rootDir, "target.png");
    const symlinkPath = path.join(rootDir, "link.png");
    await writeKnownImageFixturePng(targetPath);
    await symlink(targetPath, symlinkPath);

    const result = await validate(symlinkPath);

    expect(result).toMatchObject({ ok: false, code: "symlink" });
  });

  it("rejects missing image paths as not_file", async () => {
    const result = await validate(path.join(rootDir, "missing.png"));

    expect(result).toMatchObject({ ok: false, code: "not_file" });
  });

  it("rejects unsupported MIME types", async () => {
    const textPath = path.join(rootDir, "not-image.png");
    await writeFile(textPath, "not actually a png");

    const result = await validate(textPath);

    expect(result).toMatchObject({ ok: false, code: "unsupported_mime_type" });
  });

  it("rejects images over the byte limit", async () => {
    const imagePath = path.join(rootDir, "known.png");
    await writeKnownImageFixturePng(imagePath);

    const result = await validate(imagePath, { maxBytes: 10 });

    expect(result).toMatchObject({ ok: false, code: "too_large" });
  });

  it("rejects dimensions over the limit", async () => {
    const imagePath = path.join(rootDir, "known.png");
    await writeKnownImageFixturePng(imagePath);

    const result = await validate(imagePath, { maxWidth: KNOWN_IMAGE_FIXTURE_WIDTH - 1 });

    expect(result).toMatchObject({ ok: false, code: "dimension_limit_exceeded" });
  });
});

describe("known image dynamic tool fixture", () => {
  it("is hidden unless the test fixture env var is enabled", () => {
    expect(buildAllDynamicToolSpecs({}).map((tool) => `${tool.namespace}.${tool.name}`)).not.toContain(
      `cycloid.${KNOWN_IMAGE_FIXTURE_DYNAMIC_TOOL_NAME}`,
    );
    expect(
      buildAllDynamicToolSpecs({ ARCANIST_TEST_DYNAMIC_TOOL_IMAGE_FIXTURE: "1" }).map(
        (tool) => `${tool.namespace}.${tool.name}`,
      ),
    ).toContain(`cycloid.${KNOWN_IMAGE_FIXTURE_DYNAMIC_TOOL_NAME}`);
  });

  it("returns text JSON plus one known image without leaking the answer in text", async () => {
    const scenarioId = `fixture-${process.pid}`;
    const result = await executeFirstPartyDynamicToolCall(
      "cycloid",
      KNOWN_IMAGE_FIXTURE_DYNAMIC_TOOL_NAME,
      { scenarioId, detail: "low" },
      { env: { ARCANIST_TEST_DYNAMIC_TOOL_IMAGE_FIXTURE: "1" } },
    );

    expect(result.success).toBe(true);
    expect(result.contentItems).toHaveLength(2);
    expect(result.contentItems[0]).toMatchObject({ type: "inputText" });
    expect(result.contentItems[1]).toMatchObject({
      type: "inputImage",
      mimeType: "image/png",
      detail: "low",
      width: KNOWN_IMAGE_FIXTURE_WIDTH,
      height: KNOWN_IMAGE_FIXTURE_HEIGHT,
    });
    expect(result.contentItems[0]?.type === "inputText" ? result.contentItems[0].text : "").not.toContain(
      KNOWN_IMAGE_FIXTURE_VISUAL_CODE,
    );
    await rm(path.join(DYNAMIC_TOOL_IMAGE_ROOT, scenarioId), { recursive: true, force: true });
  });

  it("rejects symlinked fixture roots before writing", async () => {
    const scenarioId = `fixture-link-${process.pid}`;
    const scenarioRoot = path.join(DYNAMIC_TOOL_IMAGE_ROOT, scenarioId);
    const symlinkTarget = await mkdtemp(path.join(DYNAMIC_TOOL_IMAGE_ROOT, "fixture-link-target-"));
    await symlink(symlinkTarget, scenarioRoot);

    try {
      const result = await executeFirstPartyDynamicToolCall(
        "cycloid",
        KNOWN_IMAGE_FIXTURE_DYNAMIC_TOOL_NAME,
        { scenarioId },
        { env: { ARCANIST_TEST_DYNAMIC_TOOL_IMAGE_FIXTURE: "1" } },
      );

      expect(result.success).toBe(false);
      expect(result.contentItems[0]?.type === "inputText" ? result.contentItems[0].text : "").toContain(
        "Known image fixture root must not be a symlink.",
      );
    } finally {
      await rm(scenarioRoot, { force: true });
      await rm(symlinkTarget, { recursive: true, force: true });
    }
  });

  it("provides deterministic visual-question utilities", () => {
    expect(buildKnownImageVisualQuestion()).toEqual({
      question: "Read the large black visual code in the image. Answer with only that code.",
      expectedAnswer: KNOWN_IMAGE_FIXTURE_VISUAL_CODE,
    });
  });
});

describe("dynamic tool image result persistence", () => {
  it("serializes only inputText content items for persisted transcript output", () => {
    const persisted = serializeFirstPartyDynamicToolResultForPersistence({
      success: true,
      contentItems: [
        { type: "inputText", text: '{"ok":true,"imagePath":"/tmp/phase-evidence/desktop/s/known.png"}' },
        {
          type: "inputImage",
          path: "/tmp/phase-evidence/desktop/s/known.png",
          mimeType: "image/png",
          label: "known",
          detail: "high",
          width: 640,
          height: 360,
          bytes: 1234,
        },
      ],
    });

    expect(persisted).toBe(
      '[{"type":"inputText","text":"{\\"ok\\":true,\\"imagePath\\":\\"/tmp/phase-evidence/desktop/s/known.png\\"}"}]',
    );
    expect(persisted).not.toContain("inputImage");
    expect(persisted).not.toContain("bytes");
  });
});
