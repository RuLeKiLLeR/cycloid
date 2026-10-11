# Claude Verification / RLA Parity Plan

## Goal

Claude Code users should get verification and RLA behavior that matches Codex as closely as possible:

- same verifier session lifecycle
- same verification v2 phase pipeline
- same sequential prompt dispatch model
- same artifact, managed-comment, verdict, and RLA handoff flow
- backend-specific protocol differences hidden behind `AgentRuntimeAdapter`

The verifier should run on the same coding-agent backend as the implementation session whenever that parent backend/model is known and supported. Fallback to Codex should be explicit, visible, and limited to missing or unknown parent context.

## Verdict

Cost: medium. This touches verifier model routing, bridge naming, Claude runtime parity tests, scheduler tests, and docs, but it does not require a new harness abstraction or a verifier rewrite.

Do the backend-parity version: Claude parent sessions verify with Claude Code; Codex parent sessions verify with Codex. Keep verifier phases on one persistent backend session, matching the current Codex shape. `build-smaller`

## Non-Goals

- Do not change verification v2 semantics.
- Do not add Claude-only verifier phase isolation.
- Do not parse verifier phase names from prompt text inside Claude.
- Do not introduce a generic harness adapter until there is a second concrete harness beyond current agent runtime adapters.
- Do not weaken fail-closed credential behavior for `claude_code`.

## Current Evidence

- Session create already derives `agentRuntimeBackend` from the selected model when no explicit backend is passed.
- Sandbox spawn already threads `ARCANIST_AGENT_RUNTIME_BACKEND` / `AGENT_RUNTIME_BACKEND` into the sandbox.
- Claude spawn already fail-closes without `ANTHROPIC_API_KEY`.
- The bridge already drives Codex and Claude through `AgentRuntimeAdapter`.
- Verification phase dispatch already calls `this.runtime.sendPrompt(...)`, so the core phase runner is close to backend-neutral.
- The main blocker is control-plane policy: `resolveVerificationModel(...)` currently maps non-Codex parent models back to Codex.
- Shared bridge state and logs still use Codex names (`codexSessionId`, "Codex client not initialized") in backend-neutral code paths.

## Design

### Backend Routing

Change verification model resolution to preserve the parent backend when possible:

- Codex parent model -> Codex verifier on the parent model.
- Claude parent model -> Claude verifier on the parent model.
- Missing, retired, or unknown parent model -> Codex verifier on the default Codex session-start model.

This keeps the product invariant simple: the verifier runs on the same backend as the work it is verifying unless Cycloid cannot prove the parent backend/model.

### Verifier Session Continuity

Keep Claude verification on one long-lived SDK `query()`, the same way Codex verification uses one agent session.

This matters for parity:

- planner, checker, launcher, operator, and judge dispatch sequentially through one backend session;
- per-turn translator state resets, but model conversation state persists;
- no Claude-only hidden isolation behavior;
- no verifier-specific Claude prompt parsing;
- same terminal result path as Codex.

If phase isolation is later required, add it as a shared verifier runtime policy for both Codex and Claude, not as a Claude-only hardening fork.

### Adapter Boundary

The bridge should continue to know only:

- backend
- agent session id
- prompt request
- event stream
- event translation result
- abort / resume / persist hooks

Claude and Codex keep protocol-specific behavior inside their adapters.

### Data Model / Persistence

No schema change is intended.

- Reuse the existing `session.agent_runtime_backend` field.
- Reuse existing session creation and projection paths (`createSessionState`, enqueue/prompt state updates, `syncSessionProjection`).
- Do not add a new migration, table, column, compatibility shim, or duplicate backend field.
- Do not write `session_index` directly or add read-time projection repair. If a read sees stale backend metadata, fix the upstream mutation/projection path.
- Existing persisted verifier sessions keep their originally resolved backend/model. Claim recovery must not recompute and mutate a created verifier session's backend.

### API / Security

No new public route, auth mode, CORS behavior, or rate limit is introduced.

- Reuse existing `POST /api/sessions`, prompt queue, webhook, and internal SessionDO routes with their current auth modes.
- The control plane remains the authority for repo access, verification lock checks, session state transitions, and credential resolution.
- Claude verifier sessions must fail closed when Anthropic credentials cannot be proven at spawn time.
- Do not expose provider keys, gateway tokens, OAuth tokens, or platform-scoped fallback secrets to the UI or logs.

### Naming Hardening

Rename backend-neutral bridge state from Codex-specific names to agent-runtime names:

- `codexSessionId` -> `agentSessionId`
- `codexSessionAgent` -> `agentSessionAgent`
- `createCodexSessionForPrompt` call sites stay adapter-local; bridge calls should read as agent runtime session creation.
- shared error/log strings should say "agent runtime" unless they are inside Codex-specific adapter/service files.

This is not cosmetic. It prevents new verification/RLA code from accidentally treating Codex as the only valid backend.

## Implementation Plan

### 1. Control-Plane Verification Routing

Update `apps/control-plane-worker/src/services/session-model-routing.ts`:

- change `resolveVerificationModel(parentModel)` to return the parent model's own backend when `getAgentRuntimeBackendForModel(parentModelId)` resolves;
- keep Codex default fallback for null/unknown parent model;
- remove comments that state verification always runs on Codex.

Update callers if needed:

- `apps/control-plane-worker/src/session/verification-auto-scheduler.ts`
- GitHub comment-triggered verifier bootstrap paths that use `resolveVerificationModel(...)`

### 2. Scheduler Observability

Include resolved verifier backend/model in scheduling logs and schedule-failure telemetry where practical:

- `qa_tester.schedule.failed`
- scheduler create logs
- sandbox auth source logs already include backend; keep those aligned.

Failure behavior:

- missing Anthropic credential must fail closed before sandbox spawn;
- schedule/spawn failure should be visible as backend/model-specific, not a generic verifier stall.
- if a Claude verifier was already scheduled but cannot spawn or connect, existing abnormal verifier-stop handling must settle the verification run, release the per-PR verification lock, and surface the current terminal verification-stopped/manual-attention state rather than leaving RLA waiting forever.
- structured logs must include verifier backend/model and stable IDs such as session ID, verification session ID, PR URL, and head SHA; logs must not include credentials or raw provider responses.

### 3. Bridge Neutral Naming

Do a mechanical bridge cleanup:

- rename shared bridge `codexSessionId` state to `agentSessionId`;
- update `agent_session_created`, `agent_prompt_sent`, dispatch logs, and prompt-start timeout logs to use backend-neutral labels;
- keep Codex-specific names only inside Codex adapter/session/server code.

Avoid behavior changes in this step except where the rename exposes a real backend assumption.

### 4. Claude Runtime Parity

Keep current persistent Claude SDK query behavior for verification sessions.

Harden around parity:

- `ClaudeTurnState` resets per dispatch as it does today;
- the SDK query persists across verifier phases;
- model switching remains fail-closed through `parseClaudeModel`;
- unsupported reasoning variant is stripped/logged, not fatal;
- SDK stream death during verification becomes an existing prompt error / inconclusive terminal path, never a stuck verifier lock.

Do not add a Claude-only conversation isolation mode for verifier phases.

### 5. Capability Metadata

Review `shared/agent/backend-capabilities.ts`:

- keep event-level gaps for Claude (`patchEvents`, `retryStatusEvents`, etc.) unless implemented;
- do not let those cosmetic/event-shape gaps block verification v2 support if terminal verifier flow is proven;
- either remove/deprioritize `verificationChallenge` as a gating concern for verifier v2, or document that it is not part of the v2 phase pipeline path.

### 6. Docs

Update:

- `docs/api.md`
- `docs/agent-runtime-backends.md`
- `docs/bridge.md`
- `docs/prompt-agents.md` if needed

Docs should state:

- verification inherits the parent agent runtime backend when known and supported;
- Codex fallback is only for missing/unknown parent model/backend;
- verifier v2 phases are backend-neutral through `AgentRuntimeAdapter`;
- Claude verifier uses persistent SDK query continuity, matching Codex session continuity.

## Tests

### Control Plane

Update or add tests:

- `tests/test_cloudflare/verification-model.test.ts`
  - Codex parent -> Codex verifier on same model.
  - Claude Opus parent -> `claude_code` verifier on Opus.
  - Claude Sonnet parent -> `claude_code` verifier on Sonnet.
  - null/unknown parent -> Codex default.

- `tests/test_cloudflare/session/verification-auto-scheduler.test.ts`
  - Claude parent creates verifier session with `agentRuntimeBackend: "claude_code"`.
  - Codex parent behavior remains unchanged.
  - parent load failure still falls back to Codex default.

- spawn/auth tests
  - Claude verifier without Anthropic credential fails closed with clear error.
  - Codex verifier does not require Anthropic credential.

### Sandbox Bridge

Add or update bridge tests:

- verifier phase pipeline runs under `codex`;
- verifier phase pipeline runs under `claude_code`;
- both emit `verification_phase_artifact` for intermediate phases;
- both produce exactly one terminal verification result or skip;
- Claude verifier uses one SDK query across phases;
- Claude does not reopen/resume per verifier phase;
- Claude terminal result parsing feeds the same post-execution verification path as Codex;
- Claude SDK stream failure during verification settles through existing failure handling and does not leave the verifier stuck.

Required existing Claude guardrail suites:

- `tests/test_sandbox-bridge/claude-event-translator-golden.test.ts`
- `tests/test_sandbox-bridge/claude-session.test.ts`
- `tests/test_sandbox-bridge/claude-tool-safety.test.ts`
- `tests/test_sandbox-bridge/claude-rollout.test.ts`

Refresh Claude protocol fixtures only if this change intentionally changes the Claude event translation contract.

### Regression Guards

Add a lightweight source/behavior guard where useful:

- backend-neutral bridge code should not introduce new Codex-only field names;
- docs and tests should not claim auto-verification always runs on Codex.

## Local Verification

Minimum before handoff:

```bash
npx vitest run tests/test_cloudflare/verification-model.test.ts
npx vitest run tests/test_cloudflare/session/verification-auto-scheduler.test.ts
npx vitest run tests/test_sandbox-bridge/verification-phase-runner.test.ts
npx vitest run tests/test_sandbox-bridge/claude-event-translator-golden.test.ts
npx vitest run tests/test_sandbox-bridge/claude-session.test.ts
npx vitest run tests/test_sandbox-bridge/claude-tool-safety.test.ts
npx vitest run tests/test_sandbox-bridge/claude-rollout.test.ts
```

Then run focused bridge tests added for Claude verification parity.

For end-to-end confidence before merge, run one real local Cycloid verification path:

1. Start a Claude implementation session that opens a PR.
2. Trigger manual or auto verification for that PR.
3. Confirm the verifier session is `agentRuntimeBackend: "claude_code"`.
4. Confirm the managed verification comment is posted or updated.
5. Confirm final verdict updates the implementation session's verification state/result and RLA can consume `needs-work` if applicable.

## Risks

- Claude verifier now depends on Anthropic BYOK; missing credentials will surface verifier failures for Claude users. This is correct fail-closed behavior, but it needs clear telemetry.
- Claude event translator has known event-shape gaps. These should not block terminal verification unless the missing event is needed for verifier result parsing, artifact handling, tool safety, or prompt lifecycle.
- Bridge rename is broad and mechanical; keep it separate from routing changes if review size gets too large.

## Open Questions

None for this implementation. The default rollout shape is the three-PR split below; a single PR is acceptable only if the diff stays reviewable and preserves the same commit boundaries.

## Rollout Shape

Preferred PR split:

1. Backend-neutral bridge rename and no behavior change.
2. Verification model routing + control-plane tests/docs.
3. Claude verifier bridge parity tests + any adapter hardening required by failures.

If keeping one PR, keep commits grouped by those same boundaries.
