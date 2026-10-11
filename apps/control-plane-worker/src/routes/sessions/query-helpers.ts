import { normalizeRequestedArtifactFilename } from "../../session/artifacts";
import type { SessionSearchOptions } from "../../session/db";
import { resolveReplayCursor } from "../../session/events";
import { parseSessionReplayQuery, parseStrictHandshakeAfterSequence } from "../../session/replay-contract";
import { jsonErrorResponse, parseNonNegativeInteger } from "../../utils";
import {
  getCsvQueryParam,
  getRequestSearchParams,
  getTrimmedQueryParam,
  paginateQueryFromRequest,
  type RouteParseResult,
} from "../shared";

type ParsedSessionReplayQuery = {
  promptId?: string;
  afterSequence: number;
  beforeSequence?: number;
  limit: number;
  hasExplicitAfterSequence?: boolean;
};

export function parseSessionListQuery(request: Request): {
  statusFilter: string | null;
  scope: string | null;
  pagination: { cursor: string | null; limit: number | undefined };
  search: SessionSearchOptions;
} {
  const searchParams = getRequestSearchParams(request);
  return {
    statusFilter: getTrimmedQueryParam(searchParams, "status"),
    scope: getTrimmedQueryParam(searchParams, "scope"),
    pagination: paginateQueryFromRequest(request),
    search: {
      query: getTrimmedQueryParam(searchParams, "q"),
      repo: getTrimmedQueryParam(searchParams, "repo"),
    },
  };
}

export function parseSessionEventsQuery(request: Request): { afterSequence: number; limit: number } {
  const searchParams = getRequestSearchParams(request);
  return {
    afterSequence: resolveReplayCursor(searchParams.get("afterSequence"), request.headers.get("last-event-id")),
    limit: Math.min(parseNonNegativeInteger(searchParams.get("limit"), 200) || 200, 1000),
  };
}

export function parseSessionReplayRequest(request: Request): RouteParseResult<ParsedSessionReplayQuery> {
  const parsed = parseSessionReplayQuery(getRequestSearchParams(request));
  if (!parsed.ok) {
    return { ok: false, response: jsonErrorResponse(parsed.error, 400) };
  }
  return { ok: true, value: parsed.value };
}

export function parseSessionWebSocketQuery(
  request: Request,
): RouteParseResult<{ isSandbox: boolean; sandboxId: string; afterSequence: number }> {
  const searchParams = getRequestSearchParams(request);
  const isSandbox = searchParams.get("type") === "sandbox";
  if (isSandbox) {
    return {
      ok: true,
      value: {
        isSandbox: true,
        sandboxId: searchParams.get("sandboxId") || "",
        afterSequence: 0,
      },
    };
  }

  const handshake = parseStrictHandshakeAfterSequence(
    searchParams.get("afterSequence"),
    request.headers.get("last-event-id"),
  );
  if (!handshake.ok) {
    return { ok: false, response: jsonErrorResponse(handshake.error, 400) };
  }

  return {
    ok: true,
    value: {
      isSandbox: false,
      sandboxId: "",
      afterSequence: handshake.value,
    },
  };
}

export function parseArtifactFilenameQuery(request: Request): RouteParseResult<string> {
  const filename = getTrimmedQueryParam(getRequestSearchParams(request), "filename");
  if (!filename) {
    return { ok: false, response: jsonErrorResponse("Missing filename query param", 400) };
  }
  const normalizedFilename = normalizeRequestedArtifactFilename(filename);
  if (!normalizedFilename) {
    return { ok: false, response: new Response("Not found", { status: 404 }) };
  }
  return { ok: true, value: normalizedFilename };
}

export function parseChildSessionIncludes(request: Request): Set<string> {
  return new Set(getCsvQueryParam(getRequestSearchParams(request), "include"));
}
