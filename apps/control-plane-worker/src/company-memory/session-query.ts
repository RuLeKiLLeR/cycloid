import { isCompanyMemoryDisabledForBusiness } from "../constants/company-memory";
import { recordMemoryUsageEvents } from "../memory/db";
import type { CallbackContext, Env } from "../types";
import { jsonErrorResponse, jsonResponse, parseJsonBody } from "../utils";
import { resolveCompanyMemoryBootstrapScope } from "./bootstrap-scope";
import { getCompanyMemoryReasoningChain } from "./retrieve";
import { getCompanyMemorySessionScopeRow } from "./session-query-db";

const COMPANY_MEMORY_ID_MAX_CHARS = 200;

export interface CompanyMemorySessionScope {
  businessId: string;
  repoOwner: string | null;
  repoName: string | null;
  callbackContext: CallbackContext | null;
}

function parseOptionalBoundedString(value: unknown, maxChars: number): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= maxChars ? trimmed : null;
}

export function parseCallbackContext(raw: string | null): CallbackContext | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CallbackContext>;
    if (
      parsed.source === "slack" &&
      typeof parsed.channel === "string" &&
      typeof parsed.threadTs === "string" &&
      typeof parsed.slackTeamId === "string"
    ) {
      return parsed as CallbackContext;
    }
  } catch {
    return null;
  }
  return null;
}

export async function getCompanyMemorySessionScope(
  db: D1Database,
  sessionId: string,
): Promise<CompanyMemorySessionScope | null> {
  const row = await getCompanyMemorySessionScopeRow(db, sessionId);
  if (!row?.business_id) return null;
  return {
    businessId: row.business_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    callbackContext: parseCallbackContext(row.callback_context_json),
  };
}

export async function handleCompanyMemoryReasoningChainForSession(
  request: Request,
  env: Env,
  db: D1Database,
  sessionId: string,
  scope: CompanyMemorySessionScope,
): Promise<Response> {
  if (isCompanyMemoryDisabledForBusiness(env, scope.businessId)) {
    return jsonErrorResponse("Company memory is temporarily disabled", 403);
  }
  const body = await parseJsonBody(request);
  if (!body) return jsonErrorResponse("Invalid JSON body", 400);
  const memoryId = parseOptionalBoundedString(body.memoryId, COMPANY_MEMORY_ID_MAX_CHARS);
  if (!memoryId) {
    return jsonErrorResponse(`memoryId is required and must be at most ${COMPANY_MEMORY_ID_MAX_CHARS} characters`, 400);
  }
  const retrieveScope = await resolveCompanyMemoryBootstrapScope(env, {
    businessId: scope.businessId,
    repoOwner: scope.repoOwner,
    repoName: scope.repoName,
    callbackContext: scope.callbackContext,
  });
  const result = await getCompanyMemoryReasoningChain(db, scope.businessId, memoryId, retrieveScope);
  if (!result.memory) return jsonErrorResponse("Memory not found", 404);
  await recordMemoryUsageEvents(db, [
    {
      repoOwner: scope.repoOwner,
      repoName: scope.repoName,
      sessionId,
      promptId: "company-memory-reasoning-chain",
      memoryId,
      source: "company_reasoning_chain",
    },
  ]);
  return jsonResponse({ ok: true, ...result });
}
