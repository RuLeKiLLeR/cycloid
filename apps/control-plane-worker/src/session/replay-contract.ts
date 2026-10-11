import { z } from "zod";

import type {
  SessionReplayEvent,
  SessionReplayPage,
  SessionReplayResponse,
} from "../../../../shared/types/session-replay.js";
import { parseEventSequence } from "../utils";

// Replay/backfill contract: this module is the single source of truth for the
// session replay page shape (`SessionReplayPage`) and its HTTP envelope
// (`SessionReplayResponse`). Both HTTP `/api/sessions/:id/events/history` and
// the WebSocket `replay_page` frame expose the same semantic fields. The
// transport envelopes differ; the page meaning does not.
//
// Pagination intentionally uses numeric sequence cursors (`afterSequence` /
// `beforeSequence`) rather than the generic `{ data, nextCursor }` shape used
// elsewhere in the codebase. Sequence cursors are semantically meaningful for
// reconnect continuity and event-stream backfill, so we deliberately keep them
// as a typed exception to the generic cursor convention. See
// `docs/conventions.md` for the rationale.
const SESSION_REPLAY_DEFAULT_LIMIT = 50;
// Cap for HTTP `/events/history`. Higher than the WS caps because non-UI
// consumers (MCP, memory service, CLI, background paging loops) trade latency
// for throughput. See `shared/constants/session.ts` for the WS caps.
export const SESSION_REPLAY_MAX_LIMIT = 1000;

const nonNegativeIntegerParam = z
  .string()
  .regex(/^\d+$/)
  .transform((value) => Number(value));
const positiveIntegerParam = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform((value) => Number(value));
const nonEmptyStringParam = z.string().trim().min(1);

const sessionReplayQuerySchema = z
  .object({
    prompt_id: nonEmptyStringParam.optional(),
    after_sequence: nonNegativeIntegerParam.optional(),
    before_sequence: nonNegativeIntegerParam.optional(),
    limit: positiveIntegerParam.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.limit !== undefined && value.limit > SESSION_REPLAY_MAX_LIMIT) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        inclusive: true,
        maximum: SESSION_REPLAY_MAX_LIMIT,
        message: `limit must be less than or equal to ${SESSION_REPLAY_MAX_LIMIT}`,
        origin: "number",
        path: ["limit"],
      });
    }
    if (value.before_sequence !== undefined && value.prompt_id !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "prompt_id cannot be combined with before_sequence",
        path: ["before_sequence"],
      });
    }
    if (value.before_sequence !== undefined && value.after_sequence !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "after_sequence cannot be combined with before_sequence",
        path: ["before_sequence"],
      });
    }
  });

type SessionReplayQuery = {
  promptId?: string;
  afterSequence: number;
  beforeSequence?: number;
  limit: number;
  hasExplicitAfterSequence?: boolean;
};

export function parseSessionReplayQuery(
  searchParams: URLSearchParams,
): { ok: true; value: SessionReplayQuery } | { ok: false; error: string } {
  const parsed = sessionReplayQuerySchema.safeParse({
    prompt_id: searchParams.get("prompt_id") ?? undefined,
    after_sequence: searchParams.get("after_sequence") ?? undefined,
    before_sequence: searchParams.get("before_sequence") ?? undefined,
    limit: searchParams.get("limit") ?? undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid replay parameters" };
  }

  return {
    ok: true,
    value: {
      promptId: parsed.data.prompt_id,
      afterSequence: parsed.data.after_sequence ?? 0,
      beforeSequence: parsed.data.before_sequence,
      limit: parsed.data.limit ?? SESSION_REPLAY_DEFAULT_LIMIT,
      hasExplicitAfterSequence: parsed.data.after_sequence !== undefined,
    },
  };
}

export function buildSessionReplayPage(
  events: SessionReplayEvent[],
  params: { afterSequence: number; beforeSequence?: number | null; hasMore: boolean; droppedCount?: number },
): SessionReplayPage {
  return {
    afterSequence: params.afterSequence,
    beforeSequence: params.beforeSequence ?? null,
    events,
    hasMore: params.hasMore,
    droppedCount: params.droppedCount ?? 0,
    firstSequence: events[0]?.sequence ?? null,
    lastSequence: events[events.length - 1]?.sequence ?? null,
  };
}

export function okSessionReplayResponse(page: SessionReplayPage): SessionReplayResponse {
  return { ok: true, ...page };
}

export function buildSessionReplaySearchParams(query: {
  promptId?: string;
  afterSequence?: number;
  beforeSequence?: number;
  limit?: number;
}): URLSearchParams {
  const params = new URLSearchParams();
  if (query.promptId) params.set("prompt_id", query.promptId);
  if (query.afterSequence !== undefined) params.set("after_sequence", String(query.afterSequence));
  if (query.beforeSequence !== undefined) params.set("before_sequence", String(query.beforeSequence));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  return params;
}

/**
 * Strict non-negative integer parser. Returns `null` for any value that is not
 * a non-negative integer (or a string that cleanly parses to one). Used by
 * transports that need to fail visibly on malformed input rather than silently
 * normalizing it to a fallback. Distinct from
 * `apps/control-plane-worker/src/utils.ts#parseNonNegativeInteger`, which
 * intentionally returns a fallback for invalid input.
 */
function parseStrictNonNegativeInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "" || !/^\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

/**
 * Strict handshake validator for the WebSocket `?afterSequence=` query
 * parameter. Used by the WS upgrade route to fail fast on garbage cursors
 * (e.g. `?afterSequence=oops`) instead of silently normalizing to 0 and then
 * delivering a stale replay window. The header fall-back (`last-event-id`)
 * stays lenient because legacy SSE clients may attach `event-N` formatted
 * values; that path is unchanged.
 */
export function parseStrictHandshakeAfterSequence(
  queryCursorRaw: unknown,
  headerCursorRaw: unknown,
): { ok: true; value: number } | { ok: false; error: string } {
  if (queryCursorRaw !== null && queryCursorRaw !== undefined) {
    const parsed = parseStrictNonNegativeInteger(queryCursorRaw);
    if (parsed === null) {
      return { ok: false, error: "afterSequence must be a non-negative integer" };
    }
    return { ok: true, value: parsed };
  }
  if (headerCursorRaw !== null && headerCursorRaw !== undefined && headerCursorRaw !== "") {
    const parsed = parseEventSequence(headerCursorRaw);
    return { ok: true, value: parsed ?? 0 };
  }
  return { ok: true, value: 0 };
}

type ValidatedReplayPageRequest = {
  afterSequence?: number;
  beforeSequence?: number;
  limit?: number;
};

/**
 * Validate a `request_replay_page` WebSocket payload. Unlike HTTP, the WS
 * transport does not pre-parse via Zod; this enforces the same fail-visibly
 * semantics so callers cannot accidentally normalize bad input. `maxLimit` is
 * caller-supplied because HTTP uses `SESSION_REPLAY_MAX_LIMIT` while WS uses
 * `REPLAY_PAGE_SIZE` (see `shared/constants/session.ts`).
 */
export function validateReplayPageRequest(
  payload: { afterSequence?: unknown; beforeSequence?: unknown; limit?: unknown },
  maxLimit: number,
): { ok: true; value: ValidatedReplayPageRequest } | { ok: false; error: string; param: string } {
  const result: ValidatedReplayPageRequest = {};

  if (payload.afterSequence !== undefined) {
    const parsed = parseStrictNonNegativeInteger(payload.afterSequence);
    if (parsed === null) {
      return { ok: false, error: "afterSequence must be a non-negative integer", param: "afterSequence" };
    }
    result.afterSequence = parsed;
  }

  if (payload.beforeSequence !== undefined) {
    const parsed = parseStrictNonNegativeInteger(payload.beforeSequence);
    if (parsed === null) {
      return { ok: false, error: "beforeSequence must be a non-negative integer", param: "beforeSequence" };
    }
    result.beforeSequence = parsed;
  }

  if (result.afterSequence !== undefined && result.beforeSequence !== undefined) {
    return {
      ok: false,
      error: "afterSequence cannot be combined with beforeSequence",
      param: "beforeSequence",
    };
  }

  if (payload.limit !== undefined) {
    const parsed = parseStrictNonNegativeInteger(payload.limit);
    if (parsed === null || parsed === 0) {
      return { ok: false, error: "limit must be a positive integer", param: "limit" };
    }
    if (parsed > maxLimit) {
      return { ok: false, error: `limit must be less than or equal to ${maxLimit}`, param: "limit" };
    }
    result.limit = parsed;
  }

  return { ok: true, value: result };
}
