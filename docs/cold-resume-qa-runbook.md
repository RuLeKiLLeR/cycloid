# Cold-Resume QA Runbook

Verify durable Codex rollout persistence (PR #3907) on QA by forcing a **cold** resume instead of waiting out the 72h warm-resume window.

## Why this is needed

A resume is **warm** (paused E2B VM reconnected, `$CODEX_HOME` intact) whenever `runtimeStateExpiresAt > now`; warm resume never runs the 3907 restore path. Retention is `pausedAt + E2B_RUNTIME_RETENTION_HOURS` (default 72h), so the restore path is otherwise untestable for 72h after a pause.

Resume classification (`routes/sessions.ts:394`, mirrored in `durable-object.ts:9692`):

- paused + `runtimeStateExpiresAt > now` → `live` (warm)
- paused + `runtimeStateExpiresAt <= now` → `expired` (cold)
- not paused / sandbox killed or missing → `cold`

## The knob

`parsePositiveHoursEnv` floors its input (`durable-object.ts:550`), so **`E2B_RUNTIME_RETENTION_HOURS=0.01` → `0` → retention `0ms`** → `runtimeStateExpiresAt = pausedAt` → every paused session is instantly `expired` → next send cold-starts. No 72h wait, no E2B API calls.

> Affects **all** QA sessions while set. Use a short window and revert after.

## Setup (QA control-plane worker)

Set, deploy/restart so env applies:

- `E2B_RUNTIME_RETENTION_HOURS=0.01` — forces every resume cold (required)
- `E2B_RUNTIME_LIVE_LEASE_MS=60000` — optional; shrinks idle→pause from ~10min (default `600000`, `durable-object.ts:756`) to ~1–6min (cleanup cron is 5-min granular, `wrangler.toml:81`)

## Run

1. Start a fresh QA session (sessions always start from a fresh sandbox). Send a real prompt; let it complete. → Confirms upload: S3 object `sessions/{sessionId}/codex-rollout.tar.gz` exists (`services/archive.ts:255`). Upload is silent on success; the S3 object is the authoritative check.
2. Leave the session idle. The cleanup sweep pauses it (`runtimeState=paused`, `runtimeStateExpiresAt` already in the past).
3. Send a follow-up prompt that depends on prior work ("continue", "what did you change in X"). Triggers resume → classified `expired` → cold start → `session_resumed_cold`.
4. Cold boot runs `restoreCodexRollout` **before** the app-server spawns, gated on `!client && restorableSessionId && !codexSessionId` (`bridge.ts:2337`): GET `/api/sessions/:sessionId/rollout` → extract into `$CODEX_HOME` → `session.get(restorableSessionId)` → `thread/resume` loads full history.

## Pass criteria

Control-plane logs via `wrangler tail` on the QA worker (DO `this.log` is **not** searchable in Datadog):

- `"E2B paused runtime expired; creating fresh sandbox"` (`durable-object.ts:9727`)
- `session_resumed_cold` event emitted
- new `runtimeSandboxId` ≠ the paused one
- rollout PUT/GET return 2xx

Bridge:

- `codex_rollout.restored` logged (`codex-rollout.ts:157`)
- on resume, `codexSessionId == restorableSessionId` (reused, not brand-new) — the crisp signal that history actually loaded
- **no** `codex_rollout.restore_missing` / `restore_failed` / `restore_error`

Agent:

- follow-up answer references real prior context
- does **not** say "no prior work is visible in this conversation"

## Negative control (mandatory — proves the test is real)

Repeat steps 1–3, but **delete the S3 rollout object before the follow-up**. Expect the original failure: brand-new `codexSessionId`, `codex_rollout.restore_missing`, "no prior work is visible". Proves the context came from 3907's restore — not the git-branch fallback or an accidental warm resume.

## Cleanup

Revert `E2B_RUNTIME_RETENTION_HOURS` (and `E2B_RUNTIME_LIVE_LEASE_MS` if set) on QA and redeploy.

## Notes

- With retention `0`, the 5-min cleanup sweep may **kill** the paused sandbox before you resume. Fine — S3 is independent of the sandbox, the resume is still cold, and it also exercises the `missing_sandbox` resume branch.
- Rejected alternatives: kill-the-sandbox via E2B API (more faithful to the reap but adds a sandbox-ID lookup + sweep race; the `expired` branch exercises the identical restore path); direct DO/D1 state mutation (bypasses real lifecycle).

## Evidence — first verified run (2026-06-03, QA)

Session `3f03237f-c4d4-48fd-9a7a-e5a375e5ff95` against `trycycloid/dummy-docker-app`:

- **Turn 1** told the agent two facts ("favorite number 73", "codename Wallaby") and to write nothing → `post_execution: hasChanges=false, no_diff`, so the facts existed only in the Codex conversation rollout, never in git.
- Idle auto-pause, then the recall prompt produced a **cold** resume:
  - `session_resumed_cold` event (`reason: "prompt"`, `lostSnapshotImageId: null`)
  - fresh sandbox: Turn 1 on `iiyr44vle9hsys0ym9qbq`, Turn 2 on `i12w0esnxge88bwjgpuuq`
  - transcript marker `[sandbox cold-restarted; in-sandbox state was lost]`
- Despite the cold restart the agent answered **"Your favorite number is 73, and your project codename is Wallaby."** — recoverable only from the S3-restored rollout (#3907), not git.
