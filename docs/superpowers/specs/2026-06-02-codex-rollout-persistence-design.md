# Durable Codex Rollout Persistence

**Date:** 2026-06-02
**Status:** Approved design, pending implementation plan
**Author:** Jagrit Chaitanya (with Claude)

## Problem

Cold-resumed Cycloid sessions start with an empty conversation thread — the
agent has no memory of prior work and says so ("no prior work is visible in this
conversation"). Diagnosed across six real sessions (5 failing, 1 lucky): every
cold resume gets a brand-new `codexSessionId` because the prior Codex
conversation history is lost.

### Root cause

The Codex app-server persists each thread as rollout JSONL files under
`$CODEX_HOME` (`/tmp/codex-home-${SESSION_ID}`, `codex-server.ts:679-685`).
`session.get` → `thread/read` (`codex-server.ts:1280`) and `thread/resume`
(`codex-server.ts:1324`) load a thread **by id from those on-disk files**.

On cold resume the new sandbox has a fresh, empty `$CODEX_HOME`, so
`thread/read(restorableSessionId)` fails → the restore branch at
`bridge.ts:2305-2344` falls into its catch and creates a fresh session with zero
history. `/tmp` is per-sandbox and ephemeral, so the rollout written by the
original sandbox is gone once that sandbox is reaped. No sandbox snapshot is
taken for these sessions (`snapshotImageId` is null), so warm resume never
applies either.

The agent's only fallback is reconstructing context by reading the git
branch/PR, which is unreliable and non-deterministic — hence "works once."

## Goal

Persist the Codex rollout durably (independent of the sandbox) and restore it
into a cold-resumed sandbox so the existing restore path
(`session.get` → `thread/read`/`thread/resume`) succeeds with full conversation
history. No Codex SDK changes; no manual turn replay.

Non-goals: snapshotting fix, incremental rollout deltas, git-fallback hardening.

## Approach

Ship the on-disk rollout files to S3 after each completed prompt; restore them
into `$CODEX_HOME` on cold resume before the Codex app-server boots. Reuse the
existing bridge→control-plane→S3 artifact upload pattern (the bridge already
POSTs screenshot artifacts this way; no S3 credentials live in the sandbox).

### Decisions (aligned with user)

- **Upload cadence:** after every completed prompt (overwrites a single S3
  object). Survives ungraceful death (idle-reap / `sandbox_disconnected`), which
  is how the failing sessions actually ended.
- **Transport:** reuse the control-plane upload route. Bridge POSTs gzipped tar
  with `Authorization: Bearer <sandboxToken>`; control-plane writes S3. No S3
  creds in the sandbox.
- **Restore point:** bridge setup phase, cold-resume only, **before the
  app-server is spawned** (`ensureClientInitializedForPrompt`) so there is no
  risk of the app-server caching a stale session index at boot.
- **Retention:** keep forever, no TTL — matches every other session archive
  (the bucket has no lifecycle policy and nothing deletes archives today).
- **Verification:** build + unit tests + PR (no real-infra E2E this pass).

## Components

### 1. Bridge — `apps/sandbox-bridge/src/services/codex-rollout.ts` (new)

- `packRollout(codexHome): Uint8Array | null`
  Tar+gzip **only the rollout subtree** of `$CODEX_HOME`. **Whitelist** the
  rollout directory (`sessions/`, and any sibling rollout/history files codex
  writes); **never include `auth.json` or any credential file** (secrets stay
  server-side). Returns null when there is nothing to pack.
- `uploadRollout(port, bytes): Promise<void>`
  POST bytes to the control-plane rollout route with the sandbox bearer token.
  Fire-and-forget, timeout-bounded; failures log a warning and never fail the
  prompt (mirrors `artifact-collector.ts`).
- `restoreRollout(port, codexHome): Promise<boolean>`
  GET the tar from the control-plane rollout route and extract into
  `$CODEX_HOME`. On 404 / network / extract error: log and return false (caller
  continues; falls back to current behavior).

### 2. Bridge — wiring

- **Upload:** invoke after each completed prompt in the post-execution path
  (alongside artifact upload, `post-execution-runner.ts`), only when
  `codexSessionId` is set.
- **Restore:** invoke in the setup phase, gated to cold resume
  (`restorableSessionId` set, `codexSessionId` null), **before**
  `ensureClientInitializedForPrompt` spawns the app-server. After extract, the
  existing `session.get(restorableSessionId)` restore (`bridge.ts:2305`)
  succeeds unchanged.

### 3. Control-plane — rollout routes (sandbox-callback auth group)

Same auth as artifact upload (`resolveSandboxCallbackSecret`, `auth.sessionId`).

- `PUT  /api/sessions/:sessionId/rollout` → authenticate, then `writeRollout` →
  S3 `sessions/{sessionId}/codex-rollout.tar.gz`.
- `GET  /api/sessions/:sessionId/rollout` → authenticate, stream the object back
  or 404.

New `writeRollout` / `readRollout` helpers in
`apps/control-plane-worker/src/services/archive.ts`, beside `writeArtifact`,
reusing `getS3Config` / `putObject` / object-get.

### 4. S3 layout

`sessions/{sessionId}/codex-rollout.tar.gz` — single object, overwritten each
prompt (idempotent; a session contributes exactly one tar regardless of length).

## Data flow

**Steady state:** prompt completes → bridge packs `$CODEX_HOME` rollout subtree →
POST → control-plane → S3 (overwrite).

**Cold resume:** fresh sandbox → bridge setup → GET rollout tar → extract into
`$CODEX_HOME` (before app-server boot) → app-server starts →
`session.get(restorableSessionId)` → `thread/read`/`thread/resume` load full
history → agent answers with real prior context.

## Error handling & safety

- Never pack `auth.json` or secrets — pack a whitelist of the rollout subtree.
- Upload and restore are best-effort and timeout-bounded; any failure falls back
  to today's git-based behavior. **No new hot-path failure class.**
- Restore gated to cold resume so warm / first-run paths are untouched.
- Size: whole-rollout overwrite per prompt; gzipped JSONL even for ~250k-token
  sessions is a few MB. Incremental deltas = YAGNI.

## Testing (unit only)

- `packRollout`: excludes `auth.json`, includes rollout files; pack → extract
  round-trips.
- `uploadRollout`: POSTs to the correct URL with bearer; swallows failures.
- `restoreRollout`: extracts into `$CODEX_HOME`; 404 / error → no throw, returns
  false.
- Control-plane routes: require sandbox-callback auth; PUT writes the S3 key, GET
  returns it / 404 (extend `archive` and `sandbox-callback-auth` test patterns).
- Bridge ordering: with a restorable id + a present rollout object, restore runs
  before app-server init.

## Risk resolved during implementation

Exact on-disk rollout layout under `$CODEX_HOME` (codex writes
`sessions/YYYY/MM/DD/rollout-*.jsonl`). Confirm against a live sandbox / local
codex run; the design isolates this to `packRollout`'s include-list, the single
place to adjust.
