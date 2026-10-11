// Transport-specific replay caps. The three caps below are intentionally
// different — do not unify them.
//
// Why three caps:
// - HTTP `/api/sessions/:id/events/history` uses
//   `SESSION_REPLAY_MAX_LIMIT = 1000` (defined in
//   `apps/control-plane-worker/src/session/replay-contract.ts`). HTTP serves
//   non-UI consumers (MCP, memory service, CLI, background paging loops) where
//   throughput matters more than per-request latency.
// - WebSocket `request_replay_page` uses `REPLAY_PAGE_SIZE = 200`. This is the
//   interactive UI back-paging path; latency matters more than throughput.
// - WebSocket `subscribed.replay` bootstrap uses `REPLAY_WINDOW_SIZE = 500`.
//   This is the first-connect bootstrap. It is deliberately larger than
//   `REPLAY_PAGE_SIZE` (so a fresh tab gets enough context immediately) but
//   smaller than `SESSION_REPLAY_MAX_LIMIT` (so the initial connect stays
//   fast).
export const REPLAY_WINDOW_SIZE = 500;
export const REPLAY_PAGE_SIZE = 200;

// Hard limits for parent/child session orchestration (ARC-657). These are the
// only safety rail — there is no per-business feature flag — so the defaults
// are conservative. Dial via this file (no schema change required).
export const MAX_CHILD_SESSION_SPAWN_DEPTH = 1;
export const MAX_CHILD_SESSIONS_PER_PROMPT = 5;
export const MAX_TOTAL_CHILD_SESSIONS_PER_SESSION = 10;
export const MAX_CONCURRENT_CHILD_SESSIONS_PER_USER = 10;
export const SPAWN_CHILD_SESSION_MAX_PROMPT_LENGTH = 32_000;
export const SPAWN_CHILD_SESSION_MAX_TITLE_LENGTH = 256;
export const SPAWN_CHILD_SESSION_REPOSITORY_ID_PATTERN_SOURCE = "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$";
export const SPAWN_CHILD_SESSION_REPOSITORY_ID_PATTERN = new RegExp(SPAWN_CHILD_SESSION_REPOSITORY_ID_PATTERN_SOURCE);

// Per-business cap on concurrently non-terminal top-level sessions, enforced at
// `POST /api/sessions` admission. A cost/abuse guardrail, not a hard concurrency
// invariant: counted directly from `session_index` (the source of truth) so a
// session frees capacity as soon as it reaches a terminal phase
// (completed/stopped/failed/blocked/archived) or is closed, with no separate
// bookkeeping to drift or leak. Dial via this file (no schema change required).
export const MAX_ACTIVE_SESSIONS_PER_BUSINESS = 100;

// Hard byte cap on a `POST /api/sessions` request body. A create body carries
// only repo context, model, and agent overrides (kilobytes); this generous
// ceiling refuses oversized/abusive payloads before they are read and parsed.
export const MAX_SESSION_CREATE_BODY_BYTES = 256 * 1024;

// Per-business sliding-window rate limit on `POST /api/sessions` admission: at
// most N create attempts that reach admission per window. Catches bursts that
// the (eventually freed) active-session cap alone would let through transiently.
// Enforced atomically per business via SessionResumeRateLimiterDO.
export const SESSION_CREATE_RATE_LIMIT_MAX = 10;
export const SESSION_CREATE_RATE_LIMIT_WINDOW_SECONDS = 60;

// Structured `code` in the 403 body returned by the session DO's
// sandbox-token-minting guard when the session is no longer `active` or the
// sandbox is not `ready`/`reconnecting`. The bridge uses it to distinguish a
// session-lifecycle race from a real sandbox-auth rejection. The `error`
// string ("Sandbox not active") is load-bearing for older consumers — never
// change it; this code is the only field meant for programmatic matching.
export const SANDBOX_NOT_ACTIVE_ERROR_CODE = "sandbox_not_active";
