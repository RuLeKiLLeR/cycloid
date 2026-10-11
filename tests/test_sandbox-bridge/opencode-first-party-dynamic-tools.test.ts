import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { executeKnownImageFixtureDynamicToolCall } from "../../apps/sandbox-bridge/src/services/known-image-dynamic-tool.js";
import {
  appendOpencodeMemoryTelemetry,
  buildOpencodeFirstPartyDynamicToolsProjection,
  loadOpencodeMemoryContext,
  OPENCODE_FIRST_PARTY_DYNAMIC_TOOLS_MCP_SERVER_NAME,
  OPENCODE_FIRST_PARTY_MCP_SERVER_FLAG,
  OPENCODE_MEMORY_CONTEXT_FILE_ENV,
  OPENCODE_MEMORY_TELEMETRY_FILE_ENV,
} from "../../apps/sandbox-bridge/src/services/opencode-first-party-dynamic-tools.js";
import {
  buildOpencodeMcpContentItemsForDynamicToolResult,
  defaultOpencodeImageFeedbackCapability,
  filterOpencodeDesktopDynamicToolSpecsForImageFeedback,
  getApprovedOpencodeDesktopImageFeedbackModelIds,
  OPENCODE_IMAGE_FEEDBACK_MODEL_ENV,
  OPENCODE_IMAGE_INPUT_MAX_BYTES,
  resolveOpencodeImageFeedbackCapability,
} from "../../apps/sandbox-bridge/src/services/opencode-image-feedback.js";
import { BasetenModel } from "../../shared/constants/models.js";

describe("opencode first-party dynamic tools MCP projection", () => {
  it("builds a local MCP config for available first-party dynamic tools", () => {
    const projection = buildOpencodeFirstPartyDynamicToolsProjection({
      DD_API_KEY: "dd-api",
      DD_APP_KEY: "dd-app",
      DD_SITE: "datadoghq.com",
    });

    expect(projection?.toolNames).toContain("datadog.search_datadog_logs");
    expect(projection?.guidance).toContain("# First-party dynamic tools");
    expect(projection?.mcpConfig).toMatchObject({
      type: "local",
      enabled: true,
      timeout: 10_000,
    });
    expect(OPENCODE_FIRST_PARTY_DYNAMIC_TOOLS_MCP_SERVER_NAME).toBe("cycloid_first_party_dynamic_tools");
  });

  it("launches the MCP server by re-invoking the bundled bridge, not tsx/a loose .ts file", () => {
    // Regression: the E2B image ships only `bundle.js` (no `tsx`, no `.ts`), so a
    // `tsx/cli`-based launch crashed every opencode prompt with MODULE_NOT_FOUND.
    // The command must be `node <bundle> --first-party-mcp-server`.
    const projection = buildOpencodeFirstPartyDynamicToolsProjection({ DD_API_KEY: "dd-api", DD_APP_KEY: "dd-app" });
    // Assert non-null first so a projection regression fails as "unexpectedly
    // null" rather than a confusing "undefined !== execPath" on command[0].
    expect(projection).not.toBeNull();
    const command = projection?.mcpConfig.command ?? [];

    expect(command[0]).toBe(process.execPath);
    expect(command[command.length - 1]).toBe(OPENCODE_FIRST_PARTY_MCP_SERVER_FLAG);
    expect(command.join(" ")).not.toContain("tsx");
    expect(command.join(" ")).not.toContain(".ts");
  });

  it("passes memory side-channel env into the MCP subprocess environment", () => {
    const projection = buildOpencodeFirstPartyDynamicToolsProjection(
      { DD_API_KEY: "dd-api", DD_APP_KEY: "dd-app" },
      {
        [OPENCODE_MEMORY_CONTEXT_FILE_ENV]: "/tmp/context.json",
        [OPENCODE_MEMORY_TELEMETRY_FILE_ENV]: "/tmp/telemetry.jsonl",
      },
    );

    expect(projection?.mcpConfig.environment).toMatchObject({
      [OPENCODE_MEMORY_CONTEXT_FILE_ENV]: "/tmp/context.json",
      [OPENCODE_MEMORY_TELEMETRY_FILE_ENV]: "/tmp/telemetry.jsonl",
    });
  });

  it("passes agent role into the MCP subprocess environment and hides verification side effects", () => {
    const projection = buildOpencodeFirstPartyDynamicToolsProjection(
      { LINEAR_ACCESS_TOKEN: "linear-token" },
      {},
      { agentRole: "verification" },
    );

    expect(projection?.toolNames).toContain("linear.get_issue");
    expect(projection?.toolNames).not.toContain("linear.create_issue");
    expect(projection?.toolNames).not.toContain("linear.update_issue");
    expect(projection?.toolNames).not.toContain("linear.create_comment");
    expect(projection?.mcpConfig.environment).toMatchObject({
      ARCANIST_AGENT_ROLE: "verification",
    });
  });

  it("loads injected memory context and appends telemetry through files", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-tool-test-"));
    const contextFile = join(dir, "context.json");
    const telemetryFile = join(dir, "telemetry.jsonl");
    writeFileSync(
      contextFile,
      JSON.stringify({
        repoMemories: [{ id: "mem-d1", memory: "Use the injected memory pool" }],
        memoryRefs: [["mem-d1", { id: "mem-d1", path: "d1:mem-d1" }]],
      }),
      "utf8",
    );

    const context = loadOpencodeMemoryContext({ [OPENCODE_MEMORY_CONTEXT_FILE_ENV]: contextFile });
    expect(context.repoMemories?.[0]?.id).toBe("mem-d1");
    expect(context.memoryRefById?.get("mem-d1")?.path).toBe("d1:mem-d1");

    appendOpencodeMemoryTelemetry({ [OPENCODE_MEMORY_TELEMETRY_FILE_ENV]: telemetryFile }, "memory_recall.returned", {
      requestedMemoryIds: ["mem-d1"],
      returnedMemoryIds: ["mem-d1"],
    });
    expect(readFileSync(telemetryFile, "utf8")).toContain("mem-d1");
  });

  it("honors ARCANIST_BRIDGE_BUNDLE_PATH for the MCP bundle path", () => {
    const projection = buildOpencodeFirstPartyDynamicToolsProjection({
      DD_API_KEY: "dd-api",
      DD_APP_KEY: "dd-app",
      ARCANIST_BRIDGE_BUNDLE_PATH: "/app/bridge/bundle.js",
    });

    expect(projection?.mcpConfig.command).toEqual([
      process.execPath,
      "/app/bridge/bundle.js",
      OPENCODE_FIRST_PARTY_MCP_SERVER_FLAG,
    ]);
  });

  it("exposes a runnable MCP server entrypoint that loads from the bundle import graph", async () => {
    // Loader harness (replaces the prior string-only assertion): proves the MCP
    // server module is importable in-process - i.e. it is reachable from the
    // bundle's import graph and registers tools without a tsx/.ts subprocess.
    const mod = await import("../../apps/sandbox-bridge/src/services/opencode-first-party-mcp-server.js");
    expect(typeof mod.runOpencodeFirstPartyMcpServer).toBe("function");
  });

  it("projects known dynamic-tool images into opencode MCP image content for every approved desktop model", async () => {
    const approvedModels = getApprovedOpencodeDesktopImageFeedbackModelIds();
    expect(approvedModels).toEqual([BasetenModel.KimiK27Code]);

    for (const modelId of approvedModels) {
      const result = await executeKnownImageFixtureDynamicToolCall({
        scenarioId: `opencode-feedback-${modelId}`,
        detail: "high",
      });
      const projected = await buildOpencodeMcpContentItemsForDynamicToolResult({
        result,
        capability: defaultOpencodeImageFeedbackCapability(modelId),
      });

      expect(projected.unsupportedReason).toBeNull();
      expect(projected.content[0]).toEqual({
        type: "text",
        text: expect.stringContaining('"fixture":"known_image"'),
      });
      expect(projected.content[1]).toMatchObject({
        type: "image",
        mimeType: "image/png",
        _meta: {
          cycloidLabel: "Known visual-feedback fixture",
          cycloidDetail: "high",
          cycloidWidth: 640,
          cycloidHeight: 360,
        },
      });
      expect(projected.content[1].data).toEqual(expect.any(String));
      expect(JSON.stringify(projected.content)).not.toContain("inputImage");
    }
  });

  it("keeps valid opencode MCP images when another image is oversized", async () => {
    const result = await executeKnownImageFixtureDynamicToolCall({
      scenarioId: "opencode-feedback-partial-oversized",
      detail: "high",
    });
    const projected = await buildOpencodeMcpContentItemsForDynamicToolResult({
      capability: defaultOpencodeImageFeedbackCapability(BasetenModel.KimiK27Code),
      result: {
        success: true,
        contentItems: [
          ...result.contentItems,
          {
            type: "inputImage",
            path: "/tmp/phase-evidence/desktop/opencode/too-large.png",
            mimeType: "image/png",
            label: "too large",
            detail: "high",
            width: 1,
            height: 1,
            bytes: OPENCODE_IMAGE_INPUT_MAX_BYTES + 1,
          },
        ],
      },
    });

    expect(projected.unsupportedReason).toBe("image_too_large");
    expect(projected.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining('"fixture":"known_image"'),
    });
    expect(projected.content[1]).toMatchObject({
      type: "image",
      mimeType: "image/png",
      _meta: {
        cycloidLabel: "Known visual-feedback fixture",
      },
    });
    expect(projected.content).toHaveLength(2);
  });

  it("rejects oversized opencode MCP images before returning image content", async () => {
    const projected = await buildOpencodeMcpContentItemsForDynamicToolResult({
      capability: defaultOpencodeImageFeedbackCapability(BasetenModel.KimiK27Code),
      result: {
        success: true,
        contentItems: [
          { type: "inputText", text: '{"ok":true}' },
          {
            type: "inputImage",
            path: "/tmp/phase-evidence/desktop/opencode/too-large.png",
            mimeType: "image/png",
            label: "too large",
            detail: "high",
            width: 1,
            height: 1,
            bytes: OPENCODE_IMAGE_INPUT_MAX_BYTES + 1,
          },
        ],
      },
    });

    expect(projected.unsupportedReason).toBe("image_too_large");
    expect(projected.content).toEqual([{ type: "text", text: '{"ok":true}' }]);
  });

  it("preserves opencode MCP text output when reading an image fails", async () => {
    const projected = await buildOpencodeMcpContentItemsForDynamicToolResult({
      capability: defaultOpencodeImageFeedbackCapability(BasetenModel.KimiK27Code),
      result: {
        success: true,
        contentItems: [
          { type: "inputText", text: '{"ok":true,"fallback":"text"}' },
          {
            type: "inputImage",
            path: "/tmp/phase-evidence/desktop/opencode/missing.png",
            mimeType: "image/png",
            label: "missing",
            detail: "high",
            width: 1,
            height: 1,
            bytes: 42,
          },
        ],
      },
    });

    expect(projected.unsupportedReason).toBeNull();
    expect(projected.content).toEqual([{ type: "text", text: '{"ok":true,"fallback":"text"}' }]);
  });

  it("keeps desktop tools for unsupported opencode models", () => {
    const unsupportedModelId = "retired-opencode-model";
    const emitted = [];
    const specs = filterOpencodeDesktopDynamicToolSpecsForImageFeedback({
      capability: defaultOpencodeImageFeedbackCapability(unsupportedModelId),
      emitUnsupported: (fields) => emitted.push(fields),
      specs: [
        {
          namespace: "desktop",
          name: "click",
          description: "Click the desktop.",
          inputSchema: { type: "object" },
        },
        {
          namespace: "cycloid",
          name: "memory_recall",
          description: "Recall memory.",
          inputSchema: { type: "object" },
        },
      ],
    });

    expect(specs.map((spec) => `${spec.namespace}.${spec.name}`)).toEqual(["desktop.click", "cycloid.memory_recall"]);
    expect(emitted).toEqual([
      {
        event: "desktop.model_image_feedback_unsupported",
        backend: "opencode",
        modelId: unsupportedModelId,
        reason: "model_not_approved",
        registrationBlocked: false,
      },
    ]);
  });

  it("passes approved opencode desktop model capability into the MCP subprocess environment", () => {
    const projection = buildOpencodeFirstPartyDynamicToolsProjection(
      { DD_API_KEY: "dd-api", DD_APP_KEY: "dd-app" },
      { [OPENCODE_IMAGE_FEEDBACK_MODEL_ENV]: BasetenModel.KimiK27Code },
      { modelId: BasetenModel.KimiK27Code },
    );

    expect(projection?.mcpConfig.environment).toMatchObject({
      [OPENCODE_IMAGE_FEEDBACK_MODEL_ENV]: BasetenModel.KimiK27Code,
    });
    expect(resolveOpencodeImageFeedbackCapability({ modelId: BasetenModel.KimiK27Code })).toMatchObject({
      supported: true,
      deliveryPath: "native_mcp_tool_result_image",
      fixture: "known_image_fixture",
    });
  });
});
