import {
  isPlatformLlmCallType,
  isPlatformLlmPhase,
  type PlatformLlmBrokerRequest,
  type PlatformLlmFailureCategory,
  type PlatformLlmPhase,
  type PlatformLlmResponse,
} from "../../../../../shared/llm/platform-llm-contract.js";
import { PLATFORM_LLM_CALL_CONFIG, PLATFORM_LLM_MAX_REQUEST_BYTES } from "../../constants/platform-llm";
import { jsonErrorResponse, jsonResponse } from "../../utils";
import type { RouteParseResult } from "../shared";

export function platformLlmFailureResponse(
  category: PlatformLlmFailureCategory,
  status: number,
  toolName: string,
  model?: string,
): Response {
  const body: PlatformLlmResponse<never> = {
    ok: false,
    category,
    attempts: 0,
    durationMs: 0,
    ...(model ? { model } : {}),
    toolName,
  };
  return jsonResponse(body, status);
}

function countPlatformLlmInputItems(input: unknown): number {
  if (!input || typeof input !== "object" || Array.isArray(input)) return 0;
  let total = 0;
  for (const value of Object.values(input as Record<string, unknown>)) {
    if (Array.isArray(value)) total += value.length;
  }
  return total;
}

export function hasOversizedPlatformLlmContentLength(request: Request): boolean {
  const raw = request.headers.get("content-length");
  if (!raw) return false;
  const contentLength = Number.parseInt(raw, 10);
  return Number.isFinite(contentLength) && contentLength > PLATFORM_LLM_MAX_REQUEST_BYTES;
}

export async function parsePlatformLlmBrokerBody(
  request: Request,
  requestedPhase: PlatformLlmPhase,
): Promise<RouteParseResult<{ body: PlatformLlmBrokerRequest; bytes: number }>> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > PLATFORM_LLM_MAX_REQUEST_BYTES) {
    return {
      ok: false,
      response: platformLlmFailureResponse("input_too_large", 413, "platform_llm"),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, response: jsonErrorResponse("Malformed platform LLM request body", 400) };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, response: jsonErrorResponse("Malformed platform LLM request body", 400) };
  }

  const body = parsed as Record<string, unknown>;
  if (!isPlatformLlmCallType(body.callType) || !isPlatformLlmPhase(body.phase) || body.phase !== requestedPhase) {
    return { ok: false, response: jsonErrorResponse("Invalid platform LLM call type or phase", 400) };
  }

  const config = PLATFORM_LLM_CALL_CONFIG[body.callType];
  if (config.phase !== requestedPhase) {
    return { ok: false, response: jsonErrorResponse("Platform LLM call type is not allowed in this phase", 400) };
  }
  if (bytes.length > config.maxInputBytes) {
    return {
      ok: false,
      response: platformLlmFailureResponse("input_too_large", 413, config.toolName, config.model),
    };
  }

  const itemCount = countPlatformLlmInputItems(body.input);
  if (config.maxItems !== null && itemCount > config.maxItems) {
    return {
      ok: false,
      response: platformLlmFailureResponse("input_too_large", 413, config.toolName, config.model),
    };
  }

  return {
    ok: true,
    value: {
      body: {
        callType: body.callType,
        phase: body.phase,
        input: body.input,
      },
      bytes: bytes.length,
    },
  };
}
