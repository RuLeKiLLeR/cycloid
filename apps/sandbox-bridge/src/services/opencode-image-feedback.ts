import { readFile } from "node:fs/promises";

import { OPENCODE_AGENT_RUNTIME_BACKEND } from "../../../../shared/agent/agent-runtime-backend.js";
import {
  BasetenModel,
  getModelDesktopImageFeedbackConfig,
  type ModelDesktopImageFeedbackConfig,
} from "../../../../shared/constants/models.js";
import type {
  FirstPartyDynamicToolCallResult,
  FirstPartyDynamicToolContentItem,
  FirstPartyDynamicToolImageContentItem,
  FirstPartyDynamicToolSpec,
  FirstPartyDynamicToolTextContentItem,
} from "./first-party-dynamic-tools.js";

export const OPENCODE_IMAGE_FEEDBACK_NATIVE_MCP_TOOL_RESULT_IMAGES = true;
export const OPENCODE_IMAGE_FEEDBACK_SYNTHETIC_IMAGE_CONTEXT = false;
export const OPENCODE_IMAGE_FEEDBACK_JSON_CONTENT_ITEMS = true;
export const OPENCODE_IMAGE_FEEDBACK_FIXTURE_NAME = "known_image_fixture";
export const OPENCODE_IMAGE_INPUT_MAX_BYTES = 20 * 1024 * 1024;
export const OPENCODE_IMAGE_FEEDBACK_MODEL_ENV = "ARCANIST_OPENCODE_IMAGE_FEEDBACK_MODEL_ID";

export type OpencodeImageFeedbackDeliveryConfig = {
  nativeMcpToolResultImages: boolean;
  syntheticImageContext: boolean;
  jsonSerializedContentItems: boolean;
};

export type OpencodeImageFeedbackUnsupportedReason =
  "model_not_approved" | "json_only_content_items_not_model_visible" | "no_delivery_path_available" | "image_too_large";

export type OpencodeImageFeedbackCapability =
  | {
      supported: true;
      modelId: string;
      deliveryPath: ModelDesktopImageFeedbackConfig["deliveryPath"];
      fixture: ModelDesktopImageFeedbackConfig["fixture"];
      verifiedAt: string;
    }
  | {
      supported: false;
      modelId: string | null;
      reason: OpencodeImageFeedbackUnsupportedReason;
      fixture: string;
    };

export type OpencodeMcpToolResultContentItem =
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
  backend: "opencode";
  modelId: string | null;
  reason: OpencodeImageFeedbackUnsupportedReason;
  registrationBlocked: boolean;
};

export const DEFAULT_OPENCODE_IMAGE_FEEDBACK_DELIVERY_CONFIG: OpencodeImageFeedbackDeliveryConfig = {
  nativeMcpToolResultImages: OPENCODE_IMAGE_FEEDBACK_NATIVE_MCP_TOOL_RESULT_IMAGES,
  syntheticImageContext: OPENCODE_IMAGE_FEEDBACK_SYNTHETIC_IMAGE_CONTEXT,
  jsonSerializedContentItems: OPENCODE_IMAGE_FEEDBACK_JSON_CONTENT_ITEMS,
};

export function resolveOpencodeImageFeedbackModelId(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string | null {
  return env[OPENCODE_IMAGE_FEEDBACK_MODEL_ENV]?.trim() || env.MODEL?.trim() || null;
}

export function resolveOpencodeImageFeedbackCapability(params: {
  modelId: string | null;
  config?: OpencodeImageFeedbackDeliveryConfig;
}): OpencodeImageFeedbackCapability {
  const modelConfig = params.modelId
    ? getModelDesktopImageFeedbackConfig(params.modelId, OPENCODE_AGENT_RUNTIME_BACKEND)
    : undefined;
  if (!params.modelId || !modelConfig) {
    return {
      supported: false,
      modelId: params.modelId,
      reason: "model_not_approved",
      fixture: OPENCODE_IMAGE_FEEDBACK_FIXTURE_NAME,
    };
  }

  const config = params.config ?? DEFAULT_OPENCODE_IMAGE_FEEDBACK_DELIVERY_CONFIG;
  if (config.nativeMcpToolResultImages && modelConfig.deliveryPath === "native_mcp_tool_result_image") {
    return {
      supported: true,
      modelId: params.modelId,
      deliveryPath: "native_mcp_tool_result_image",
      fixture: modelConfig.fixture,
      verifiedAt: modelConfig.verifiedAt,
    };
  }
  if (config.syntheticImageContext && modelConfig.deliveryPath === "synthetic_image_context") {
    return {
      supported: true,
      modelId: params.modelId,
      deliveryPath: "synthetic_image_context",
      fixture: modelConfig.fixture,
      verifiedAt: modelConfig.verifiedAt,
    };
  }
  return {
    supported: false,
    modelId: params.modelId,
    reason: config.jsonSerializedContentItems
      ? "json_only_content_items_not_model_visible"
      : "no_delivery_path_available",
    fixture: modelConfig.fixture,
  };
}

export function defaultOpencodeImageFeedbackCapability(modelId: string | null): OpencodeImageFeedbackCapability {
  return resolveOpencodeImageFeedbackCapability({ modelId });
}

export async function buildOpencodeMcpContentItemsForDynamicToolResult(params: {
  result: FirstPartyDynamicToolCallResult;
  capability: OpencodeImageFeedbackCapability;
}): Promise<{
  content: OpencodeMcpToolResultContentItem[];
  unsupportedReason: OpencodeImageFeedbackUnsupportedReason | null;
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

  let unsupportedReason: OpencodeImageFeedbackUnsupportedReason | null = null;
  const validImageItems = imageItems.filter((item) => {
    const limitFailure = validateOpencodeMcpImageItemLimits(item);
    if (!limitFailure) return true;
    unsupportedReason ??= limitFailure;
    return false;
  });

  const imageContent: OpencodeMcpToolResultContentItem[] = [];
  const settledImageContent = await Promise.allSettled(validImageItems.map(readOpencodeMcpImageContentItem));
  settledImageContent.forEach((result) => {
    if (result.status === "fulfilled") imageContent.push(result.value);
  });
  return { content: [...textContent, ...imageContent], unsupportedReason };
}

export function filterOpencodeDesktopDynamicToolSpecsForImageFeedback(params: {
  specs: readonly FirstPartyDynamicToolSpec[];
  capability: OpencodeImageFeedbackCapability;
  emitUnsupported: (fields: DesktopModelImageFeedbackUnsupportedFields) => void;
}): FirstPartyDynamicToolSpec[] {
  const desktopSpecs = params.specs.filter((spec) => spec.namespace === "desktop");
  if (desktopSpecs.length === 0 || params.capability.supported) return [...params.specs];

  params.emitUnsupported({
    event: "desktop.model_image_feedback_unsupported",
    backend: "opencode",
    modelId: params.capability.modelId,
    reason: params.capability.reason,
    registrationBlocked: false,
  });
  return [...params.specs];
}

export function getApprovedOpencodeDesktopImageFeedbackModelIds(): string[] {
  const approved = [BasetenModel.KimiK27Code].filter((modelId) =>
    Boolean(getModelDesktopImageFeedbackConfig(modelId, OPENCODE_AGENT_RUNTIME_BACKEND)),
  );
  return approved;
}

function validateOpencodeMcpImageItemLimits(
  item: FirstPartyDynamicToolImageContentItem,
): OpencodeImageFeedbackUnsupportedReason | null {
  if (item.bytes > OPENCODE_IMAGE_INPUT_MAX_BYTES) return "image_too_large";
  return null;
}

async function readOpencodeMcpImageContentItem(
  item: FirstPartyDynamicToolImageContentItem,
): Promise<OpencodeMcpToolResultContentItem> {
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
