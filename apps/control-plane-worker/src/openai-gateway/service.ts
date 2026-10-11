import * as Sentry from "@sentry/cloudflare";

import { HTTP_HEADER_NAMES } from "../../../../shared/constants/http-headers.js";
import { OpenAIServiceTier } from "../../../../shared/enums/openai-service-tier.js";
import { isTransientProviderError, withProviderRetry } from "../../../../shared/llm/retry.mjs";
import { getBusinessApiKey, getUserApiKey } from "../integrations/db";
import { createLogger } from "../logger";
import { tracedFetch } from "../observability/wrappers";
import type { Env } from "../types";
import { jsonErrorResponse, parseBearerToken } from "../utils";
import {
  computeOpenAIResponsesCostUsdMicros,
  estimateOpenAIResponsesCostUsdMicros,
  OpenAIGatewayPricingError,
  type OpenAIResponsesUsage,
} from "./cost";
import {
  getOpenAIGatewaySessionTokenBySecret,
  getVirtualKeyBySecret,
  insertGatewayLedgerRow,
  type OpenAIGatewayCredentialSource,
  type OpenAIGatewaySettlementSource,
  releaseGatewayLedgerRow,
  settleGatewayLedgerRow,
} from "./db";

type SettlementCandidate = {
  responseId: string | null;
  usage: OpenAIResponsesUsage | null;
  source: OpenAIGatewaySettlementSource;
};

type GatewayContext = {
  budgetKeyId: string;
  monthlyLimitUsdMicros: number;
  virtualKeyId: string | null;
  ownerUserId: string;
  businessId: string | null;
  sessionId: string | null;
  credentialSource: OpenAIGatewayCredentialSource;
  upstreamCredentialRef: string | null;
  upstreamApiKey: string;
  ledgerId: string;
  requestId: string;
  model: string;
  reservedUsdMicros: number;
  reservedAt: number;
  reservedMonth: string;
};

type GatewayAuthContext = Omit<
  GatewayContext,
  "ledgerId" | "requestId" | "model" | "reservedUsdMicros" | "reservedAt" | "reservedMonth"
>;
type GatewayAuthResult = GatewayAuthContext | "upstream_key_unavailable" | null;

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENAI_RESPONSES_COMPACT_URL = "https://api.openai.com/v1/responses/compact";
const MAX_RETRIEVE_ATTEMPTS = 3;
const BYOK_REPORTING_MONTHLY_LIMIT_USD_MICROS = Number.MAX_SAFE_INTEGER;
const OPENAI_UPSTREAM_KEY_UNAVAILABLE_MESSAGE = "OpenAI gateway upstream key unavailable";
const OPENAI_AUTOMATION_SERVICE_TIER = OpenAIServiceTier.Flex;
const gatewayLog = createLogger({ bindings: { component: "openai-gateway" } });

class OpenAIResponseRetrieveError extends Error {
  readonly status?: number;
  readonly headers?: Headers;
  readonly missingUsage: boolean;

  constructor(message: string, fields: { status?: number; headers?: Headers; missingUsage?: boolean } = {}) {
    super(message);
    this.name = "OpenAIResponseRetrieveError";
    this.status = fields.status;
    this.headers = fields.headers;
    this.missingUsage = fields.missingUsage ?? false;
  }
}

function monthKey(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function extractUsage(value: Record<string, unknown>): OpenAIResponsesUsage | null {
  const usage = asObject(value.usage);
  return usage ? (usage as OpenAIResponsesUsage) : null;
}

async function isAutomationGatewaySession(env: Env, sessionId: string | null | undefined): Promise<boolean> {
  const normalizedSessionId = sessionId?.trim();
  if (!normalizedSessionId) return false;
  try {
    const row = await env.DB.prepare("SELECT initiation_mode FROM session_index WHERE session_id = ? LIMIT 1")
      .bind(normalizedSessionId)
      .first<{ initiation_mode?: string | null }>();
    return row?.initiation_mode === "automation";
  } catch (err) {
    gatewayLog.warn(
      { sessionId: normalizedSessionId, error: String(err) },
      "OpenAI gateway automation tier lookup failed",
    );
    return false;
  }
}

async function applyAutomationServiceTier(
  env: Env,
  payload: Record<string, unknown>,
  sessionId: string | null | undefined,
): Promise<Record<string, unknown>> {
  if (!(await isAutomationGatewaySession(env, sessionId))) return payload;
  return { ...payload, service_tier: OPENAI_AUTOMATION_SERVICE_TIER };
}

function extractTerminalCandidate(event: Record<string, unknown>): SettlementCandidate | null {
  const type = typeof event.type === "string" ? event.type : "";
  if (type !== "response.completed" && type !== "response.incomplete") return null;
  const response = asObject(event.response);
  if (!response) return null;
  const responseId = typeof response.id === "string" ? response.id : null;
  const usage = extractUsage(response);
  return {
    responseId,
    usage,
    source: type === "response.completed" ? "response_completed" : "response_incomplete",
  };
}

function observeOpenAISseChunk(
  state: { buffer: string; responseId: string | null; terminal: SettlementCandidate | null },
  chunk: string,
): void {
  state.buffer += chunk;
  let boundary = state.buffer.indexOf("\n\n");
  while (boundary !== -1) {
    const frame = state.buffer.slice(0, boundary);
    state.buffer = state.buffer.slice(boundary + 2);
    observeOpenAISseFrame(state, frame);
    boundary = state.buffer.indexOf("\n\n");
  }
}

function observeOpenAISseFrame(
  state: { responseId: string | null; terminal: SettlementCandidate | null },
  frame: string,
): void {
  const dataLines = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) return;
  const data = dataLines.join("\n");
  if (data === "[DONE]") return;

  observeOpenAIResponseJson(state, data);
}

export function observeOpenAIResponseJson(
  state: { responseId: string | null; terminal: SettlementCandidate | null },
  data: string,
): void {
  try {
    const parsed = asObject(JSON.parse(data));
    if (!parsed) return;
    const response = asObject(parsed.response);
    const responseId =
      typeof response?.id === "string"
        ? response.id
        : typeof parsed.response_id === "string"
          ? parsed.response_id
          : null;
    if (responseId) state.responseId = responseId;
    const terminal = extractTerminalCandidate(parsed);
    if (terminal) state.terminal = terminal;
  } catch {
    return;
  }
}

type GatewayVariant = "responses" | "compact";

export async function handleOpenAIResponses(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
  variant: GatewayVariant = "responses",
): Promise<Response> {
  if (request.method === "GET" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return handleOpenAIResponsesWebSocket(request, env, ctx);
  }
  if (request.method !== "POST") return jsonErrorResponse("Not found", 404);
  if (!env.OPENAI_GATEWAY_BUDGET) return jsonErrorResponse("OpenAI gateway budget binding unavailable", 503);

  const auth = await authenticateGateway(request, env);
  if (auth === "upstream_key_unavailable") return jsonErrorResponse(OPENAI_UPSTREAM_KEY_UNAVAILABLE_MESSAGE, 503);
  if (!auth) return jsonErrorResponse("Invalid OpenAI gateway key", 401);

  const payload = await parsePayload(request);
  if (!payload) return jsonErrorResponse("Invalid OpenAI Responses payload", 400);
  const effectivePayload = await applyAutomationServiceTier(
    env,
    payload,
    auth.sessionId ?? request.headers.get("x-cycloid-session-id"),
  );
  const model = typeof effectivePayload.model === "string" ? effectivePayload.model : "";

  let estimateUsdMicros: number;
  try {
    estimateUsdMicros = estimateOpenAIResponsesCostUsdMicros(effectivePayload);
  } catch (err) {
    if (err instanceof OpenAIGatewayPricingError) return jsonErrorResponse(err.message, 400);
    throw err;
  }

  const reservedAt = Date.now();
  const reservedUsdMicros = await reserveBudget(env, auth, estimateUsdMicros, reservedAt);
  if (reservedUsdMicros === null) {
    return jsonErrorResponse("Cycloid OpenAI budget exhausted", 429, { code: "cycloid_openai_budget_exhausted" });
  }

  const gatewayContext: GatewayContext = {
    ...auth,
    ledgerId: crypto.randomUUID(),
    requestId: request.headers.get(HTTP_HEADER_NAMES.REQUEST_ID) ?? crypto.randomUUID(),
    model,
    reservedUsdMicros,
    reservedAt,
    reservedMonth: monthKey(reservedAt),
  };
  try {
    await insertGatewayLedgerRow(env.DB, {
      id: gatewayContext.ledgerId,
      virtualKeyId: auth.virtualKeyId,
      ownerUserId: auth.ownerUserId,
      businessId: auth.businessId,
      sessionId: auth.sessionId ?? request.headers.get("x-cycloid-session-id"),
      promptId: request.headers.get("x-cycloid-prompt-id"),
      requestId: gatewayContext.requestId,
      model,
      credentialSource: auth.credentialSource,
      upstreamCredentialRef: auth.upstreamCredentialRef,
      estimatedCostUsdMicros: estimateUsdMicros,
      reservedCostUsdMicros: reservedUsdMicros,
      now: reservedAt,
    });
  } catch (err) {
    await releaseBudgetReservation(env, gatewayContext);
    throw err;
  }

  let upstream: Response;
  try {
    upstream = await tracedFetch(
      variant === "compact" ? OPENAI_RESPONSES_COMPACT_URL : OPENAI_RESPONSES_URL,
      {
        method: "POST",
        headers: buildUpstreamHeaders(request.headers, auth.upstreamApiKey),
        body: JSON.stringify(effectivePayload),
      },
      variant === "compact" ? "openai.gateway.responses.compact" : "openai.gateway.responses.create",
    );
  } catch (err) {
    await releaseReservation(env, gatewayContext, "upstream_fetch_failed");
    throw err;
  }

  if (!upstream.ok) {
    await releaseReservation(env, gatewayContext, "upstream_rejected");
    return upstream;
  }

  if (variant === "compact") {
    return handleCompactResponse(upstream, env, gatewayContext, ctx);
  }

  const contentType = upstream.headers.get(HTTP_HEADER_NAMES.CONTENT_TYPE) ?? "";
  if (!effectivePayload.stream || !upstream.body || !contentType.includes("text/event-stream")) {
    return handleNonStreamingResponse(upstream, env, gatewayContext);
  }

  const settlement = streamAndObserveSse(upstream, env, gatewayContext);
  if (ctx) ctx.waitUntil(settlement.completion);
  return new Response(settlement.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

async function authenticateGateway(request: Request, env: Env): Promise<GatewayAuthResult> {
  const token = parseBearerToken(request);
  if (!token) return null;
  if (token.startsWith("arc-vk-")) {
    if (!env.ARCANIST_OPENAI_API_KEY) return "upstream_key_unavailable";
    const key = await getVirtualKeyBySecret(env.DB, token);
    if (!key) return null;
    return {
      budgetKeyId: key.id,
      monthlyLimitUsdMicros: key.monthly_limit_usd_micros,
      virtualKeyId: key.id,
      ownerUserId: key.owner_user_id,
      businessId: key.business_id,
      sessionId: request.headers.get("x-cycloid-session-id"),
      credentialSource: "managed_virtual_key",
      upstreamCredentialRef: key.id,
      upstreamApiKey: env.ARCANIST_OPENAI_API_KEY,
    };
  }
  if (!token.startsWith("arc-gw-")) return null;

  const sessionToken = await getOpenAIGatewaySessionTokenBySecret(env.DB, token);
  if (!sessionToken) return null;
  const upstream =
    sessionToken.credential_source === "business_byok"
      ? await getBusinessApiKey(env.DB, sessionToken.credential_owner_id, "openai", env.TOKEN_ENCRYPTION_KEY)
      : await getUserApiKey(env.DB, String(sessionToken.owner_user_id), "openai", env.TOKEN_ENCRYPTION_KEY);
  if (!upstream?.apiKey) return "upstream_key_unavailable";

  return {
    budgetKeyId: `${sessionToken.credential_source}:${sessionToken.credential_owner_id}`,
    monthlyLimitUsdMicros: BYOK_REPORTING_MONTHLY_LIMIT_USD_MICROS,
    virtualKeyId: null,
    ownerUserId: String(sessionToken.owner_user_id),
    businessId: sessionToken.business_id,
    sessionId: sessionToken.session_id,
    credentialSource: sessionToken.credential_source,
    upstreamCredentialRef: `${sessionToken.credential_source === "business_byok" ? "business" : "user"}:${sessionToken.credential_owner_id}:openai`,
    upstreamApiKey: upstream.apiKey,
  };
}

async function parsePayload(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return asObject(await request.json());
  } catch {
    return null;
  }
}

function buildUpstreamHeaders(headers: Headers, apiKey: string): Headers {
  const next = new Headers();
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase();
    if (["authorization", "host", "content-length", "cf-connecting-ip", "x-forwarded-for"].includes(lower)) continue;
    next.set(key, value);
  }
  next.set("authorization", `Bearer ${apiKey}`);
  next.set(HTTP_HEADER_NAMES.CONTENT_TYPE, "application/json");
  return next;
}

async function reserveBudget(
  env: Env,
  context: Pick<GatewayContext, "budgetKeyId" | "monthlyLimitUsdMicros">,
  estimateUsdMicros: number,
  now: number,
): Promise<number | null> {
  const id = env.OPENAI_GATEWAY_BUDGET!.idFromName(context.budgetKeyId);
  const response = await env.OPENAI_GATEWAY_BUDGET!.get(id).fetch("https://internal/budget/reserve", {
    method: "POST",
    body: JSON.stringify({
      estimateUsdMicros,
      monthlyLimitUsdMicros: context.monthlyLimitUsdMicros,
      now,
    }),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { reservedUsdMicros?: unknown };
  return typeof body.reservedUsdMicros === "number" ? body.reservedUsdMicros : null;
}

async function releaseBudgetReservation(env: Env, context: GatewayContext): Promise<void> {
  const id = env.OPENAI_GATEWAY_BUDGET!.idFromName(context.budgetKeyId);
  const response = await env.OPENAI_GATEWAY_BUDGET!.get(id).fetch("https://internal/budget/release", {
    method: "POST",
    body: JSON.stringify({
      ledgerId: context.ledgerId,
      reservedUsdMicros: context.reservedUsdMicros,
      month: context.reservedMonth,
      now: context.reservedAt,
    }),
  });
  logBudgetDoFailure(response, context, "release");
}

async function settleReservation(env: Env, context: GatewayContext, candidate: SettlementCandidate): Promise<void> {
  if (!candidate.usage) {
    await retrieveOrMarkUnresolved(env, context, candidate.responseId, "terminal_usage_missing");
    return;
  }
  const { costUsdMicros, normalized } = computeOpenAIResponsesCostUsdMicros({
    model: context.model,
    usage: candidate.usage,
    peakContextTokens: normalizedPeak(candidate.usage),
  });
  const id = env.OPENAI_GATEWAY_BUDGET!.idFromName(context.budgetKeyId);
  const response = await env.OPENAI_GATEWAY_BUDGET!.get(id).fetch("https://internal/budget/settle", {
    method: "POST",
    body: JSON.stringify({
      ledgerId: context.ledgerId,
      reservedUsdMicros: context.reservedUsdMicros,
      actualUsdMicros: costUsdMicros,
      month: context.reservedMonth,
      now: context.reservedAt,
    }),
  });
  logBudgetDoFailure(response, context, "settle");
  await settleGatewayLedgerRow(env.DB, {
    ledgerId: context.ledgerId,
    openaiResponseId: candidate.responseId,
    actualCostUsdMicros: costUsdMicros,
    inputTokens: normalized.inputTokens,
    cachedInputTokens: normalized.cachedInputTokens,
    outputTokens: normalized.outputTokens,
    reasoningOutputTokens: normalized.reasoningOutputTokens,
    settlementSource: candidate.source,
    rawUsageJson: JSON.stringify(candidate.usage),
    now: Date.now(),
  });
}

function logBudgetDoFailure(response: Response, context: GatewayContext, operation: "release" | "settle"): void {
  if (response.ok) return;
  // Budget DO failures are observable, but callers still preserve their primary
  // recovery path: release paths update the ledger as released, and settle paths
  // record the local ledger settlement for cost reconciliation visibility.
  gatewayLog.error(
    {
      budgetKeyId: context.budgetKeyId,
      ledgerId: context.ledgerId,
      operation,
      status: response.status,
    },
    "OpenAI gateway budget DO call failed",
  );
}

function normalizedPeak(usage: OpenAIResponsesUsage): number | undefined {
  return typeof usage.input_tokens === "number" ? usage.input_tokens : usage.prompt_tokens;
}

async function releaseReservation(env: Env, context: GatewayContext, reason: string): Promise<void> {
  await releaseBudgetReservation(env, context);
  await releaseGatewayLedgerRow(env.DB, {
    ledgerId: context.ledgerId,
    status: "released",
    unresolvedReason: reason,
    now: Date.now(),
  });
}

async function markSettlementUnresolved(
  env: Env,
  context: GatewayContext,
  responseId: string | null,
  reason: string,
): Promise<void> {
  await releaseBudgetReservation(env, context);
  await releaseGatewayLedgerRow(env.DB, {
    ledgerId: context.ledgerId,
    status: "settlement_unresolved",
    openaiResponseId: responseId,
    unresolvedReason: reason,
    now: Date.now(),
  });
  const logger = createLogger({ bindings: { component: "openai-gateway" } });
  logger.error(
    { ledgerId: context.ledgerId, responseId, credentialSource: context.credentialSource, reason },
    "OpenAI gateway settlement unresolved",
  );
  Sentry.captureMessage("OpenAI gateway settlement unresolved", {
    level: "error",
    tags: { component: "openai-gateway", reason },
    extra: { ledgerId: context.ledgerId, responseId, credentialSource: context.credentialSource },
  });
}

async function handleNonStreamingResponse(upstream: Response, env: Env, context: GatewayContext): Promise<Response> {
  const text = await upstream.text();
  let candidate: SettlementCandidate | null = null;
  try {
    const parsed = asObject(JSON.parse(text));
    if (parsed) {
      const responseId = typeof parsed.id === "string" ? parsed.id : null;
      candidate = { responseId, usage: extractUsage(parsed), source: "response_completed" };
    }
  } catch {
    candidate = null;
  }

  if (candidate?.usage) {
    await settleReservation(env, context, candidate);
  } else {
    await retrieveOrMarkUnresolved(env, context, candidate?.responseId ?? null, "non_streaming_usage_missing");
  }

  return new Response(text, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

async function handleCompactResponse(
  upstream: Response,
  env: Env,
  context: GatewayContext,
  ctx?: ExecutionContext,
): Promise<Response> {
  const text = await upstream.text();
  // Accounting failures after a successful upstream compact must not fail the
  // Codex turn; the compact body is returned regardless.
  const accounting = settleCompactAccounting(env, context, text).catch((err) => {
    const logger = createLogger({ bindings: { component: "openai-gateway" } });
    logger.error(
      { ledgerId: context.ledgerId, credentialSource: context.credentialSource, err },
      "OpenAI gateway compact accounting failed",
    );
  });
  if (ctx) ctx.waitUntil(accounting);
  else await accounting;

  return new Response(text, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

async function settleCompactAccounting(env: Env, context: GatewayContext, text: string): Promise<void> {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = asObject(JSON.parse(text));
  } catch {
    parsed = null;
  }
  if (!parsed) {
    await markSettlementUnresolved(env, context, null, "compact_response_malformed");
    return;
  }

  const responseId = typeof parsed.id === "string" ? parsed.id : null;
  const usage = extractUsage(parsed);
  if (usage) {
    await settleReservation(env, context, { responseId, usage, source: "response_completed" });
    return;
  }

  // The compact contract only guarantees `output`; a missing `usage` is
  // routine, not an error, and compact response IDs are not retrievable via
  // /v1/responses/:id. Settle at the reserved estimate rather than releasing:
  // compaction consumed real upstream tokens, so a zero-cost release would
  // let capped keys bypass the budget and skew costs-API reconciliation.
  const id = env.OPENAI_GATEWAY_BUDGET!.idFromName(context.budgetKeyId);
  const response = await env.OPENAI_GATEWAY_BUDGET!.get(id).fetch("https://internal/budget/settle", {
    method: "POST",
    body: JSON.stringify({
      ledgerId: context.ledgerId,
      reservedUsdMicros: context.reservedUsdMicros,
      actualUsdMicros: context.reservedUsdMicros,
      month: context.reservedMonth,
      now: context.reservedAt,
    }),
  });
  logBudgetDoFailure(response, context, "settle");
  await settleGatewayLedgerRow(env.DB, {
    ledgerId: context.ledgerId,
    openaiResponseId: responseId,
    actualCostUsdMicros: context.reservedUsdMicros,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    settlementSource: "compact_estimate",
    rawUsageJson: JSON.stringify({ estimated: true, reason: "compact_usage_missing" }),
    now: Date.now(),
  });
}

function streamAndObserveSse(
  upstream: Response,
  env: Env,
  context: GatewayContext,
): { body: ReadableStream<Uint8Array>; completion: Promise<void> } {
  const decoder = new TextDecoder();
  const state = { buffer: "", responseId: null as string | null, terminal: null as SettlementCandidate | null };
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();

  const completion = (async () => {
    const reader = upstream.body!.getReader();
    const writer = writable.getWriter();
    let writerOpen = true;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          observeOpenAISseChunk(state, decoder.decode(value, { stream: true }));
          if (writerOpen) {
            try {
              await writer.write(value);
            } catch {
              writerOpen = false;
            }
          }
        }
      }
      const tail = decoder.decode();
      if (tail) observeOpenAISseChunk(state, tail);
      if (state.buffer.trim()) observeOpenAISseFrame(state, state.buffer);
      if (writerOpen) await writer.close();
    } catch (err) {
      if (writerOpen) await writer.abort(err);
      throw err;
    } finally {
      if (state.terminal?.usage) {
        await settleReservation(env, context, state.terminal);
      } else if (state.responseId || state.terminal?.responseId) {
        await retrieveOrMarkUnresolved(
          env,
          context,
          state.terminal?.responseId ?? state.responseId,
          "stream_usage_missing",
        );
      } else {
        await markSettlementUnresolved(env, context, null, "stream_response_id_missing");
      }
    }
  })();

  return { body: readable, completion };
}

async function retrieveOrMarkUnresolved(
  env: Env,
  context: GatewayContext,
  responseId: string | null,
  reason: string,
): Promise<void> {
  if (!responseId) {
    await markSettlementUnresolved(env, context, null, reason);
    return;
  }

  let retrievedUsage: OpenAIResponsesUsage | null = null;
  try {
    const result = await withProviderRetry({
      maxAttempts: MAX_RETRIEVE_ATTEMPTS,
      op: async () => {
        const response = await tracedFetch(
          `${OPENAI_RESPONSES_URL}/${encodeURIComponent(responseId)}`,
          {
            headers: { authorization: `Bearer ${context.upstreamApiKey}` },
          },
          "openai.gateway.responses.retrieve",
        );
        if (!response.ok) {
          throw new OpenAIResponseRetrieveError(`OpenAI response retrieve failed: ${response.status}`, {
            status: response.status,
            headers: response.headers,
          });
        }
        const body = asObject(await response.json());
        const usage = body ? extractUsage(body) : null;
        if (!usage) {
          throw new OpenAIResponseRetrieveError("OpenAI response retrieve returned no usage", { missingUsage: true });
        }
        return usage;
      },
      isTransient: (error) =>
        error instanceof OpenAIResponseRetrieveError && error.missingUsage ? true : isTransientProviderError(error),
    });
    retrievedUsage = result.value;
  } catch {
    // Fall through to the existing unresolved-settlement path after retry exhaustion
    // or a non-retryable retrieve failure.
  }

  if (retrievedUsage) {
    await settleReservation(env, context, { responseId, usage: retrievedUsage, source: "response_retrieve" });
    return;
  }

  await markSettlementUnresolved(env, context, responseId, reason);
}

async function handleOpenAIResponsesWebSocket(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  if (!env.OPENAI_GATEWAY_BUDGET) return jsonErrorResponse("OpenAI gateway budget binding unavailable", 503);
  const auth = await authenticateGateway(request, env);
  if (auth === "upstream_key_unavailable") return jsonErrorResponse(OPENAI_UPSTREAM_KEY_UNAVAILABLE_MESSAGE, 503);
  if (!auth) return jsonErrorResponse("Invalid OpenAI gateway key", 401);

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
  server.accept();

  const proxyTask = proxyOpenAIResponsesWebSocket(request, env, auth, server);
  if (ctx) ctx.waitUntil(proxyTask);

  return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
}

async function proxyOpenAIResponsesWebSocket(
  request: Request,
  env: Env,
  auth: GatewayAuthContext,
  clientSocket: WebSocket,
): Promise<void> {
  let upstreamSocket: WebSocket | null = null;
  let gatewayContext: GatewayContext | null = null;
  let gatewayContextPromise: Promise<{ context: GatewayContext; upstreamData: string } | null> | null = null;
  let responseId: string | null = null;
  let terminal = null as SettlementCandidate | null;
  const pendingClientMessages: Array<string | ArrayBuffer> = [];
  let drainingClientMessages = false;
  const settlementTasks: Promise<void>[] = [];

  try {
    const ensureGatewayContext = async (
      data: string,
    ): Promise<{ context: GatewayContext; upstreamData: string } | null> => {
      if (gatewayContext) return { context: gatewayContext, upstreamData: data };
      if (gatewayContextPromise) return gatewayContextPromise;
      gatewayContextPromise = (async () => {
        let payload: Record<string, unknown> | null = null;
        try {
          payload = asObject(JSON.parse(data));
        } catch {
          payload = null;
        }
        if (!payload) {
          clientSocket.close(1008, "Invalid OpenAI Responses payload");
          return null;
        }
        const effectivePayload = await applyAutomationServiceTier(
          env,
          payload,
          auth.sessionId ?? request.headers.get("x-cycloid-session-id"),
        );
        const model = typeof effectivePayload.model === "string" ? effectivePayload.model : "";
        let estimateUsdMicros: number;
        try {
          estimateUsdMicros = estimateOpenAIResponsesCostUsdMicros(effectivePayload);
        } catch {
          clientSocket.close(1008, "Unknown OpenAI model pricing");
          return null;
        }
        const reservedAt = Date.now();
        const reservedUsdMicros = await reserveBudget(env, auth, estimateUsdMicros, reservedAt);
        if (reservedUsdMicros === null) {
          clientSocket.close(1008, "Cycloid OpenAI budget exhausted");
          return null;
        }
        const context: GatewayContext = {
          ...auth,
          ledgerId: crypto.randomUUID(),
          requestId: request.headers.get(HTTP_HEADER_NAMES.REQUEST_ID) ?? crypto.randomUUID(),
          model,
          reservedUsdMicros,
          reservedAt,
          reservedMonth: monthKey(reservedAt),
        };
        try {
          await insertGatewayLedgerRow(env.DB, {
            id: context.ledgerId,
            virtualKeyId: auth.virtualKeyId,
            ownerUserId: auth.ownerUserId,
            businessId: auth.businessId,
            sessionId: auth.sessionId ?? request.headers.get("x-cycloid-session-id"),
            promptId: request.headers.get("x-cycloid-prompt-id"),
            requestId: context.requestId,
            model,
            credentialSource: auth.credentialSource,
            upstreamCredentialRef: auth.upstreamCredentialRef,
            estimatedCostUsdMicros: estimateUsdMicros,
            reservedCostUsdMicros: reservedUsdMicros,
            now: reservedAt,
          });
        } catch (err) {
          await releaseBudgetReservation(env, context);
          throw err;
        }
        gatewayContext = context;
        return {
          context,
          upstreamData: effectivePayload === payload ? data : JSON.stringify(effectivePayload),
        };
      })();
      try {
        return await gatewayContextPromise;
      } catch (err) {
        gatewayContextPromise = null;
        throw err;
      }
    };

    const drainClientMessages = async (): Promise<void> => {
      if (drainingClientMessages || !upstreamSocket) return;
      drainingClientMessages = true;
      try {
        while (upstreamSocket && pendingClientMessages.length > 0) {
          const data = pendingClientMessages.shift();
          if (data === undefined) continue;
          let upstreamData = data;
          if (typeof data === "string" && !gatewayContext) {
            const prepared = await ensureGatewayContext(data);
            if (!prepared) continue;
            upstreamData = prepared.upstreamData;
          }
          upstreamSocket.send(upstreamData);
        }
      } finally {
        drainingClientMessages = false;
      }
    };

    clientSocket.addEventListener("message", (event) => {
      pendingClientMessages.push(event.data);
      void drainClientMessages();
    });

    const beginSettlement = (candidate: SettlementCandidate): void => {
      if (!gatewayContext) return;
      const context = gatewayContext;
      gatewayContext = null;
      gatewayContextPromise = null;
      responseId = null;
      terminal = null;
      const settleCandidate = async (): Promise<void> => {
        if (candidate.usage) {
          await settleReservation(env, context, candidate);
        } else {
          await retrieveOrMarkUnresolved(env, context, candidate.responseId, "websocket_usage_missing");
        }
      };
      const settlementTask = settleCandidate().catch(async (err) => {
        const logger = createLogger({ bindings: { component: "openai-gateway" } });
        logger.error(
          { ledgerId: context.ledgerId, credentialSource: context.credentialSource, err },
          "OpenAI gateway WebSocket settlement failed",
        );
        try {
          await settleCandidate();
        } catch (retryErr) {
          logger.error(
            { ledgerId: context.ledgerId, credentialSource: context.credentialSource, err: retryErr },
            "OpenAI gateway WebSocket settlement retry failed",
          );
        }
      });
      settlementTasks.push(settlementTask);
    };

    const upstream = await tracedFetch(
      OPENAI_RESPONSES_URL,
      {
        headers: buildWebSocketUpstreamHeaders(request.headers, auth.upstreamApiKey),
      },
      "openai.gateway.responses.websocket",
    );
    upstreamSocket = (upstream as Response & { webSocket?: WebSocket }).webSocket ?? null;
    if (!upstreamSocket) {
      clientSocket.close(1011, "OpenAI WebSocket unavailable");
      return;
    }
    upstreamSocket.accept();
    await drainClientMessages();

    upstreamSocket.addEventListener("message", (event) => {
      const data = event.data;
      if (typeof data === "string") {
        const state = { responseId, terminal };
        observeOpenAIResponseJson(state, data);
        responseId = state.responseId;
        terminal = state.terminal;
        if (terminal) beginSettlement(terminal);
      }
      clientSocket.send(data);
    });

    const closePromise = new Promise<void>((resolve) => {
      const close = () => resolve();
      clientSocket.addEventListener("close", close);
      upstreamSocket?.addEventListener("close", close);
      clientSocket.addEventListener("error", close);
      upstreamSocket?.addEventListener("error", close);
    });
    await closePromise;
  } catch (err) {
    if (gatewayContext) {
      const failedContext = gatewayContext;
      gatewayContext = null;
      await releaseReservation(env, failedContext, "websocket_proxy_failed");
    }
    throw err;
  } finally {
    if (settlementTasks.length > 0) await Promise.all(settlementTasks);
    if (gatewayContext) {
      if (terminal?.usage) {
        await settleReservation(env, gatewayContext, terminal);
      } else {
        await retrieveOrMarkUnresolved(
          env,
          gatewayContext,
          terminal?.responseId ?? responseId,
          "websocket_usage_missing",
        );
      }
    }
    try {
      upstreamSocket?.close();
    } catch {
      // Already closed.
    }
    try {
      clientSocket.close();
    } catch {
      // Already closed.
    }
  }
}

function buildWebSocketUpstreamHeaders(headers: Headers, apiKey: string): Headers {
  const next = buildUpstreamHeaders(headers, apiKey);
  next.set("upgrade", "websocket");
  return next;
}
