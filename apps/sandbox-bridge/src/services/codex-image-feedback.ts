import type {
  FirstPartyDynamicToolCallResult,
  FirstPartyDynamicToolContentItem,
  FirstPartyDynamicToolImageContentItem,
  FirstPartyDynamicToolSpec,
  FirstPartyDynamicToolTextContentItem,
} from "./first-party-dynamic-tools.js";

export const CODEX_IMAGE_FEEDBACK_NATIVE_TOOL_RESULT_IMAGES = false;
export const CODEX_IMAGE_FEEDBACK_SYNTHETIC_IMAGE_CONTEXT = true;
export const CODEX_IMAGE_FEEDBACK_JSON_CONTENT_ITEMS = true;
export const CODEX_IMAGE_FEEDBACK_FIXTURE_NAME = "known_image_fixture";
export const CODEX_SYNTHETIC_IMAGE_CONTEXT_DELIVERY_PATH = "synthetic_image_context";

export type CodexImageFeedbackDeliveryConfig = {
  nativeToolResultImages: boolean;
  syntheticImageContext: boolean;
  jsonSerializedContentItems: boolean;
};

export type CodexImageFeedbackUnsupportedReason =
  "json_only_content_items_not_model_visible" | "no_delivery_path_available";

export type CodexImageFeedbackCapability =
  | {
      supported: true;
      deliveryPath: "native_tool_result_image" | "synthetic_image_context";
      fixture: string;
    }
  | {
      supported: false;
      reason: CodexImageFeedbackUnsupportedReason;
      fixture: string;
    };

export type CodexSyntheticImageFeedback = {
  path: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  label: string;
  detail: "high" | "low";
  width: number;
  height: number;
  bytes: number;
};

export type DesktopModelImageFeedbackUnsupportedFields = {
  event: "desktop.model_image_feedback_unsupported";
  backend: "codex";
  modelId: string | null;
  reason: CodexImageFeedbackUnsupportedReason;
  registrationBlocked: boolean;
};

export const DEFAULT_CODEX_IMAGE_FEEDBACK_DELIVERY_CONFIG: CodexImageFeedbackDeliveryConfig = {
  nativeToolResultImages: CODEX_IMAGE_FEEDBACK_NATIVE_TOOL_RESULT_IMAGES,
  syntheticImageContext: CODEX_IMAGE_FEEDBACK_SYNTHETIC_IMAGE_CONTEXT,
  jsonSerializedContentItems: CODEX_IMAGE_FEEDBACK_JSON_CONTENT_ITEMS,
};

export function resolveCodexImageFeedbackCapability(
  config: CodexImageFeedbackDeliveryConfig,
): CodexImageFeedbackCapability {
  if (config.nativeToolResultImages) {
    return { supported: true, deliveryPath: "native_tool_result_image", fixture: CODEX_IMAGE_FEEDBACK_FIXTURE_NAME };
  }
  if (config.syntheticImageContext) {
    return {
      supported: true,
      deliveryPath: CODEX_SYNTHETIC_IMAGE_CONTEXT_DELIVERY_PATH,
      fixture: CODEX_IMAGE_FEEDBACK_FIXTURE_NAME,
    };
  }
  return {
    supported: false,
    reason: config.jsonSerializedContentItems
      ? "json_only_content_items_not_model_visible"
      : "no_delivery_path_available",
    fixture: CODEX_IMAGE_FEEDBACK_FIXTURE_NAME,
  };
}

export function defaultCodexImageFeedbackCapability(): CodexImageFeedbackCapability {
  return resolveCodexImageFeedbackCapability(DEFAULT_CODEX_IMAGE_FEEDBACK_DELIVERY_CONFIG);
}

export function adaptCodexDynamicToolResultForImageFeedback(params: {
  result: FirstPartyDynamicToolCallResult;
  capability: CodexImageFeedbackCapability;
}): {
  result: FirstPartyDynamicToolCallResult;
  syntheticImageFeedback: CodexSyntheticImageFeedback[];
  unsupportedReason: DesktopModelImageFeedbackUnsupportedFields["reason"] | null;
} {
  const imageItems = params.result.contentItems.filter(isFirstPartyDynamicToolImageContentItem);
  if (imageItems.length === 0) {
    return { result: params.result, syntheticImageFeedback: [], unsupportedReason: null };
  }

  if (params.capability.supported && params.capability.deliveryPath === "native_tool_result_image") {
    return { result: params.result, syntheticImageFeedback: [], unsupportedReason: null };
  }

  const result = {
    ...params.result,
    contentItems: textOnlyContentItems(params.result),
  };

  if (!params.capability.supported) {
    return {
      result,
      syntheticImageFeedback: [],
      unsupportedReason: params.capability.reason,
    };
  }

  return {
    result,
    syntheticImageFeedback: imageItems.map((item) => ({
      path: item.path,
      mimeType: item.mimeType,
      label: item.label,
      detail: item.detail,
      width: item.width,
      height: item.height,
      bytes: item.bytes,
    })),
    unsupportedReason: null,
  };
}

export function buildCodexSyntheticImageFeedbackInput(
  feedback: readonly CodexSyntheticImageFeedback[],
): Array<Record<string, unknown>> {
  if (feedback.length === 0) return [];
  return [
    {
      type: "text",
      text: [
        "# Desktop Image Feedback",
        "The previous first-party dynamic tool returned model-visible image feedback.",
        "Inspect the attached image before deciding any next desktop or CUA action.",
        JSON.stringify({
          images: feedback.map((item) => ({
            label: item.label,
            mimeType: item.mimeType,
            detail: item.detail,
            width: item.width,
            height: item.height,
            bytes: item.bytes,
          })),
        }),
      ].join("\n"),
      text_elements: [],
    },
    ...feedback.map((item) => ({ type: "localImage", path: item.path })),
  ];
}

export function filterCodexDesktopDynamicToolSpecsForImageFeedback(params: {
  specs: readonly FirstPartyDynamicToolSpec[];
  capability: CodexImageFeedbackCapability;
  modelId: string | null;
  emitUnsupported: (fields: DesktopModelImageFeedbackUnsupportedFields) => void;
}): FirstPartyDynamicToolSpec[] {
  const desktopSpecs = params.specs.filter((spec) => spec.namespace === "desktop");
  if (desktopSpecs.length === 0 || params.capability.supported) return [...params.specs];

  params.emitUnsupported({
    event: "desktop.model_image_feedback_unsupported",
    backend: "codex",
    modelId: params.modelId,
    reason: params.capability.reason,
    registrationBlocked: false,
  });
  return [...params.specs];
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
