import { readFileSync, rmSync } from "fs";
import { afterAll, describe, expect, it, vi } from "vitest";

import { createRealGitRepoFixture } from "../test_sandbox-bridge/helpers/repo-fixture.js";

const uploadMocks = vi.hoisted(() => ({
  processUploadedImage: vi.fn(),
}));

vi.mock("../../apps/sandbox-bridge/src/services/image-processing.js", () => ({
  processUploadedImage: uploadMocks.processUploadedImage,
}));

vi.mock("ws", () => ({ default: class {}, WebSocket: class {} }));

const { AgentBridge } = await import("../../apps/sandbox-bridge/src/bridge.js");
const { estimateTokens } = await import("../../apps/sandbox-bridge/src/utils/tokens.js");
const { UPLOAD_TRUNCATION_NOTE } = await import("../../apps/sandbox-bridge/src/constants/bridge.js");
const { OpenAIModel } = await import("../../shared/constants/models.js");

// This suite does not mock child_process, so the constructor's repo
// validation runs real git; an explicit fixture keeps it host-independent.
const repoFixturePath = createRealGitRepoFixture();
afterAll(() => rmSync(repoFixturePath, { recursive: true, force: true }));

function makeBridge() {
  return new AgentBridge({
    repoPath: repoFixturePath,
    sandboxId: "sbx-1",
    sessionId: "sess-1",
    controlPlaneUrl: "https://control.example.com",
    authToken: "secret",
  });
}

function makePromptLog() {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  log.child.mockReturnValue(log);
  return log;
}

describe("upload budget cap", () => {
  it("includes uploads normally when they fit under the cap", async () => {
    const bridge = makeBridge();
    const promptLog = makePromptLog();

    uploadMocks.processUploadedImage.mockResolvedValue({
      image: { name: "shot.png", mediaType: "image/png", data: "processed" },
      originalWidth: 640,
      originalHeight: 480,
      width: 640,
      height: 480,
      originalBytes: 10_000,
      outputBytes: 8_000,
      resized: false,
      formatConverted: false,
    });

    const prepared = await bridge["prepareUploadedContentForPrompt"]({
      model: OpenAIModel.GPT54Mini,
      uploadedFiles: [{ name: "notes.txt", content: "short notes" }],
      uploadedImages: [{ name: "shot.png", mediaType: "image/png", data: "raw" }],
      promptLog,
    });

    expect(prepared.imageParts).toHaveLength(1);
    expect(prepared.syntheticTextParts).toHaveLength(1);
    expect(prepared.syntheticTextParts[0].text).toContain("short notes");
    expect(prepared.syntheticTextParts[0].text).not.toContain(UPLOAD_TRUNCATION_NOTE);
    expect(promptLog.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("Uploaded content exceeded budget"),
    );
  });

  it("caps oversized upload context as a single guard and includes the truncation note", async () => {
    const bridge = makeBridge();
    const promptLog = makePromptLog();
    const oversizedContent = ["first line", "middle line\n".repeat(300_000), "last line"].join("\n");

    const prepared = await bridge["prepareUploadedContentForPrompt"]({
      uploadedFiles: [{ name: "notes.txt", content: oversizedContent }],
      uploadedImages: [],
      promptLog,
    });

    expect(prepared.imageParts).toHaveLength(0);
    expect(prepared.syntheticTextParts[0].text).toBe(UPLOAD_TRUNCATION_NOTE);
    expect(prepared.syntheticTextParts[1].text).toMatch(/^<uploaded_files_[a-f0-9]{8}>/);
    expect(prepared.syntheticTextParts[1].text).toMatch(/<\/uploaded_files_[a-f0-9]{8}>$/);
    expect(prepared.syntheticTextParts[1].text).toContain("UNTRUSTED content");
    expect(prepared.syntheticTextParts[1].text).toContain('name="uploaded_context.txt"');
    expect(prepared.syntheticTextParts[1].text).toContain("[truncated: uploaded context was");
    expect(prepared.syntheticTextParts[1].text).toContain("first line");
    expect(prepared.syntheticTextParts[1].text).toContain("last line");
    expect(promptLog.warn).toHaveBeenCalledWith(
      {
        event: "upload_budget.exceeded",
        model: expect.any(String),
        uploadBudgetTokens: expect.any(Number),
        estimatedUploadTokens: expect.any(Number),
        fileCount: 1,
        imageCount: 0,
      },
      "Uploaded content exceeded budget",
    );
    const uploadBudgetWarning = promptLog.warn.mock.calls.find(
      ([, message]) => message === "Uploaded content exceeded budget",
    );
    const uploadBudgetTokens = uploadBudgetWarning?.[0].uploadBudgetTokens;
    expect(typeof uploadBudgetTokens).toBe("number");
    expect(estimateTokens(prepared.syntheticTextParts[1].text)).toBeLessThanOrEqual(Number(uploadBudgetTokens) + 1_000);
  });

  it("omits uploaded text when image tokens leave no text budget", async () => {
    const bridge = makeBridge();
    const promptLog = makePromptLog();

    uploadMocks.processUploadedImage.mockResolvedValue({
      image: { name: "huge.png", mediaType: "image/png", data: "processed" },
      originalWidth: 12_000,
      originalHeight: 12_000,
      width: 12_000,
      height: 12_000,
      originalBytes: 400_000,
      outputBytes: 400_000,
      resized: false,
      formatConverted: false,
    });

    const prepared = await bridge["prepareUploadedContentForPrompt"]({
      model: OpenAIModel.GPT54Mini,
      uploadedFiles: [{ name: "notes.txt", content: "important\n".repeat(500) }],
      uploadedImages: [{ name: "huge.png", mediaType: "image/png", data: "raw" }],
      promptLog,
    });

    expect(prepared.imageParts).toHaveLength(1);
    expect(prepared.syntheticTextParts).toEqual([{ type: "text", text: UPLOAD_TRUNCATION_NOTE, synthetic: true }]);
    expect(promptLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "upload_budget.exceeded",
        model: OpenAIModel.GPT54Mini,
        fileCount: 1,
        imageCount: 1,
      }),
      "Uploaded content exceeded budget",
    );
  });

  it("does not define a Datadog log-derived metric for upload budget caps", () => {
    let logMetrics: string;
    try {
      logMetrics = readFileSync("infra/datadog-log-metrics.tf", "utf8");
    } catch (error) {
      throw new Error("Expected to read infra/datadog-log-metrics.tf from the repository root", { cause: error });
    }

    expect(logMetrics).not.toMatch(/upload[_-]budget/i);
  });
});
