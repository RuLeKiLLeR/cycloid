import { createTimeoutAwareSignal } from "../utils/abort-signal.js";
import { isCancellationError } from "./cancellation.js";
import { normalizeControlPlaneUrl } from "./dynamic-tool-http.js";
import {
  createDynamicToolFailure as failure,
  DYNAMIC_TOOL_ERROR_CODES,
  type DynamicToolErrorCode,
} from "./dynamic-tool-results.js";
import type {
  FirstPartyDynamicToolCallResult,
  FirstPartyDynamicToolExecuteContext,
} from "./first-party-dynamic-tools.js";

type LimitConfig<Input> = {
  measure: (input: Input) => number;
  max: number;
  message: string;
};

type ControlPlaneReviewToolConfig<Input, Body> = {
  normalizeInput: (args: unknown) => Input | null;
  invalidInputMessage: string;
  limit?: LimitConfig<Input>;
  path: string;
  timeoutMs: number;
  notConnectedMessage: string;
  cancelledMessage: string;
  failurePrefix: string;
  parseResponse: (response: Response) => Promise<Body>;
  isSuccess: (response: Response, body: Body) => boolean;
  renderSuccess: (body: Body, context: FirstPartyDynamicToolExecuteContext) => FirstPartyDynamicToolCallResult;
  mapError: (response: Response, body: Body) => { errorCode: DynamicToolErrorCode; text: string };
};

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  return createTimeoutAwareSignal(signal, timeoutMs);
}

export async function callControlPlaneSessionEndpoint(
  context: FirstPartyDynamicToolExecuteContext,
  options: { path: string; body: unknown; timeoutMs: number },
): Promise<Response | null> {
  const controlPlaneUrl = normalizeControlPlaneUrl(context.env["CONTROL_PLANE_URL"] ?? context.env["ARCANIST_API_URL"]);
  const sessionId = context.env["SESSION_ID"]?.trim();
  const sandboxAuthToken = context.env["SANDBOX_AUTH_TOKEN"]?.trim();
  if (!controlPlaneUrl || !sessionId || !sandboxAuthToken) return null;

  return (context.fetchImpl ?? fetch)(
    `${controlPlaneUrl}/api/sessions/${encodeURIComponent(sessionId)}${options.path}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${sandboxAuthToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(options.body),
      signal: requestSignal(context.signal, options.timeoutMs),
    },
  );
}

export function buildControlPlaneReviewTool<Input, Body>(config: ControlPlaneReviewToolConfig<Input, Body>) {
  return async (
    args: unknown,
    context: FirstPartyDynamicToolExecuteContext,
  ): Promise<FirstPartyDynamicToolCallResult> => {
    const input = config.normalizeInput(args);
    if (!input) return failure(DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT, config.invalidInputMessage);

    if (config.limit && config.limit.measure(input) > config.limit.max) {
      return failure(DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT, config.limit.message);
    }

    try {
      const response = await callControlPlaneSessionEndpoint(context, {
        path: config.path,
        body: input,
        timeoutMs: config.timeoutMs,
      });
      if (!response) return failure(DYNAMIC_TOOL_ERROR_CODES.NOT_CONNECTED, config.notConnectedMessage);

      const body = await config.parseResponse(response);
      if (!config.isSuccess(response, body)) {
        const mapped = config.mapError(response, body);
        return failure(mapped.errorCode, mapped.text);
      }
      return config.renderSuccess(body, context);
    } catch (error) {
      if (isCancellationError(error)) return failure(DYNAMIC_TOOL_ERROR_CODES.CANCELLED, config.cancelledMessage);
      return failure(DYNAMIC_TOOL_ERROR_CODES.UPSTREAM_ERROR, `${config.failurePrefix}: ${String(error)}`);
    }
  };
}
