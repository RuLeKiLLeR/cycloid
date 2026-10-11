import { readFile } from "node:fs/promises";

import { stringifyError } from "../../../../shared/utils/errors.js";
import type { BridgeLogger } from "../logger.js";
import type {
  FirstPartyDynamicToolCallResult,
  FirstPartyDynamicToolContentItem,
  FirstPartyDynamicToolImageContentItem,
  FirstPartyDynamicToolSpec,
  FirstPartyDynamicToolTextContentItem,
} from "./first-party-dynamic-tools.js";

export const CLAUDE_IMAGE_FEEDBACK_NATIVE_MCP_TOOL_RESULT_IMAGES = true;
export const CLAUDE_IMAGE_FEEDBACK_JSON_CONTENT_ITEMS = true;
export const CLAUDE_IMAGE_FEEDBACK_FIXTURE_NAME = "known_image_fixture";

export type ClaudeImageFeedbackDeliveryConfig = {
  nativeMcpToolResultImages: boolean;
  jsonSerializedContentItems: boolean;
};

export type ClaudeImageFeedbackUnsupportedReason =
  "json_only_content_items_not_model_visible" | "no_delivery_path_available";

export type ClaudeImageFeedbackCapability =
  | {
      supported: true;
      deliveryPath: "native_mcp_tool_result_image";
      fixture: string;
    }
  | {
      supported: false;
      reason: ClaudeImageFeedbackUnsupportedReason;
      fixture: string;
    };

export type ClaudeMcpToolResultContentItem =
  | { type: "text"; text: string }
  | {
      type: "image";
      data: string;
      mimeType: "image/jpeg" | "image/png" | "image/webp";
      _meta: {
        cycloidLabel: string;
        cycloidDetail: "high" | "low";
        cycloidWidth: number;
        cycloidHeight: number;
        cycloidBytes: number;
      };
    };

export type DesktopModelImageFeedbackUnsupportedFields = {
  event: "desktop.model_image_feedback_unsupported";
  backend: "claude_code";
  modelId: string | null;
  reason: ClaudeImageFeedbackUnsupportedReason;
  registrationBlocked: boolean;
};

export const DEFAULT_CLAUDE_IMAGE_FEEDBACK_DELIVERY_CONFIG: ClaudeImageFeedbackDeliveryConfig = {
  nativeMcpToolResultImages: CLAUDE_IMAGE_FEEDBACK_NATIVE_MCP_TOOL_RESULT_IMAGES,
  jsonSerializedContentItems: CLAUDE_IMAGE_FEEDBACK_JSON_CONTENT_ITEMS,
};

export function resolveClaudeImageFeedbackCapability(
  config: ClaudeImageFeedbackDeliveryConfig,
): ClaudeImageFeedbackCapability {
  if (config.nativeMcpToolResultImages) {
    return {
      supported: true,
      deliveryPath: "native_mcp_tool_result_image",
      fixture: CLAUDE_IMAGE_FEEDBACK_FIXTURE_NAME,
    };
  }
  return {
    supported: false,
    reason: config.jsonSerializedContentItems
      ? "json_only_content_items_not_model_visible"
      : "no_delivery_path_available",
    fixture: CLAUDE_IMAGE_FEEDBACK_FIXTURE_NAME,
  };
}

export function defaultClaudeImageFeedbackCapability(): ClaudeImageFeedbackCapability {
  return resolveClaudeImageFeedbackCapability(DEFAULT_CLAUDE_IMAGE_FEEDBACK_DELIVERY_CONFIG);
}

export async function buildClaudeMcpContentItemsForDynamicToolResult(params: {
  result: FirstPartyDynamicToolCallResult;
  capability: ClaudeImageFeedbackCapability;
  promptLog: BridgeLogger | null;
}): Promise<{
  content: ClaudeMcpToolResultContentItem[];
  unsupportedReason: ClaudeImageFeedbackUnsupportedReason | null;
}> {
  const imageItems = params.result.contentItems.filter(isFirstPartyDynamicToolImageContentItem);
  const textContent = textOnlyContentItems(params.result).map((item) => ({
    type: "text" as const,
    text: item.text,
  }));
  if (imageItems.length === 0) return { content: textContent, unsupportedReason: null };

  if (!params.capability.supported) {
    return { content: textContent, unsupportedReason: params.capability.reason };
  }

  const imageContent: ClaudeMcpToolResultContentItem[] = [];
  const settledImageContent = await Promise.allSettled(imageItems.map(readClaudeMcpImageContentItem));
  settledImageContent.forEach((result, index) => {
    const item = imageItems[index];
    if (result.status === "fulfilled") {
      imageContent.push(result.value);
      return;
    }
    params.promptLog?.warn(
      {
        event: "desktop.image_feedback_read_failed",
        backend: "claude_code",
        path: item?.path ?? null,
        label: item?.label ?? null,
        error: stringifyError(result.reason),
      },
      "Failed to read Claude Code desktop image feedback image",
    );
  });
  return { content: [...textContent, ...imageContent], unsupportedReason: null };
}

export function filterClaudeDesktopDynamicToolSpecsForImageFeedback(params: {
  specs: readonly FirstPartyDynamicToolSpec[];
  capability: ClaudeImageFeedbackCapability;
  modelId: string | null;
  emitUnsupported: (fields: DesktopModelImageFeedbackUnsupportedFields) => void;
}): FirstPartyDynamicToolSpec[] {
  const desktopSpecs = params.specs.filter((spec) => spec.namespace === "desktop");
  if (desktopSpecs.length === 0 || params.capability.supported) return [...params.specs];

  params.emitUnsupported({
    event: "desktop.model_image_feedback_unsupported",
    backend: "claude_code",
    modelId: params.modelId,
    reason: params.capability.reason,
    registrationBlocked: true,
  });
  return params.specs.filter((spec) => spec.namespace !== "desktop");
}

async function readClaudeMcpImageContentItem(
  item: FirstPartyDynamicToolImageContentItem,
): Promise<ClaudeMcpToolResultContentItem> {
  return {
    type: "image",
    data: await readFile(item.path, "base64"),
    mimeType: item.mimeType,
    _meta: {
      cycloidLabel: item.label,
      cycloidDetail: item.detail,
      cycloidWidth: item.width,
      cycloidHeight: item.height,
      cycloidBytes: item.bytes,
    },
  };
}

function textOnlyContentItems(result: FirstPartyDynamicToolCallResult): FirstPartyDynamicToolTextContentItem[] {
  const textItems = result.contentItems.filter(isFirstPartyDynamicToolTextContentItem);
  if (textItems.length > 0) return textItems;
  return [{ type: "inputText", text: JSON.stringify({ success: result.success }) }];
}

function isFirstPartyDynamicToolTextContentItem(
  item: FirstPartyDynamicToolContentItem,
): item is FirstPartyDynamicToolTextContentItem {
  return item.type === "inputText";
}

function isFirstPartyDynamicToolImageContentItem(
  item: FirstPartyDynamicToolContentItem,
): item is FirstPartyDynamicToolImageContentItem {
  return item.type === "inputImage";
}
