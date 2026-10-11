# Onboarding Session (Phase 1) — Design

Agent-driven repo onboarding: a special-purpose Cycloid session that authors a customer repo's `.cycloid.json`, `.cycloid/` runtime, and `CYCLOID.md`, proves what it can inside its own sandbox, and publishes the setup PR.

## Problem

Repo onboarding is the bottleneck of customer onboarding and is fully manual. The hand-built reference (`trycycloid/mia-copy-2` PR #2) took days of expert work; its content splits ~25% Cycloid boilerplate, ~35% mechanical extraction from the repo, ~40% judgment that required iterating against a live boot.

Phase-0 evidence (prod session `6103951f-d094-4715-9ee7-d4f522cbf4cb` → mia-copy-2 PR #13, minimal prompt, no platform changes):

- The agent searched for the config contract (agent-profiles, workspace examples, `cycloid` CLI, memory) and, finding nothing, **hallucinated a plausible but non-functional schema** — no `appRuntime`, no `verify.test`, so no platform feature would activate.
- **Docker works in a docker-disabled session** (`docker info` succeeded with no `.cycloid.json` on the branch). Compose-up was not exercised.
- The agent **declined the live boot** unless required ("intentionally long-running … leaving that unexecuted").
- Unaided tier-2 extraction was strong (verify commands from CI + Justfile, placeholder env from `env.example`, path-scoped verification reinvented); `CYCLOID.md` ignored all 33 `.cursor/rules`.

The measured gap is exactly three things the platform can supply in a prompt layer: the config contract, a boot-proof requirement, and the CYCLOID.md recipe. No sandbox capability is missing.

## Decision

Dogfood the normal session → PR loop with a third builtin agent, `onboard`, following the `verify` precedent end to end. No new sandbox capabilities, no UI, no `sessionKind`.

### Components

1. **Agent metadata** — `shared/agent/constants.ts`: add `onboard` to `BUILTIN_AGENTS`; `resolveAgentRuntimeMetadata` maps it to `agentProfile: "onboard"`, `agentRole: "implementation"`, `runtimeStartupProfile: "implementation_default"`. Flows through the existing `ARCANIST_AGENT_PROFILE` path (prompt-queue → SessionDO env → bridge fallback chain).
2. **Trigger** — `routes/sessions.ts`: an `onboarding: true` create-payload flag (mirrors `verify`), valid only for `sessionKind: "repo"`. Available via API and CLI (`sessions create --onboarding`). Same authz as any session create; team-use by convention, undocumented externally in phase 1.
3. **Playbook prompt layer** — `apps/sandbox-bridge/src/constants/bridge.ts`: a session-static guidance section gated on `agentProfile === "onboard"` (same mechanism as verify guidance; survives compaction). Content:
   - Deliverables: `.cycloid.json`, `.cycloid/docker-compose.yml` + supporting scripts/shims under `.cycloid/`, `.cycloid/setup.sh`, auth script, `CYCLOID.md`. Additive files only; minimal product-file edits.
   - The `.cycloid.json` authoring contract: `appRuntime` (`kind`/`runner`/`entry`/`url`/`portMapping`/`additionalPorts`/`ready`/`open`/`auth`) and `verify.test.rules`, with semantics (path-scoped rules vs changed files, ≤5 matched commands, no tracked-file mutation; `auth.command` writes Playwright storageState to `ARCANIST_AUTH_STATE_PATH` against `ARCANIST_BASE_URL`).
   - Boot-proof requirement: run `docker compose up` and iterate until the ready path responds and auth validates; measure cold boot and size `ready.timeoutSeconds` from it. If boot is impossible, fall back to static validation and say so prominently.
   - CYCLOID.md recipe: always-on essentials + an index of existing rule files with scopes taken from their own frontmatter; 32 KiB hard ceiling, ≤8 KB target; distill, don't dump.
   - Simulation-report PR body: what was detected, what booted vs was statically validated, every verify command with result and duration, and an ordered "before merge" checklist for the customer (env vars, `test-creds set`, 2FA-off blessing). This deliberately overrides the default "don't author PR descriptions" stance — for onboarding PRs the report is the deliverable.
   - Sequencing traps: install deps before publish (the session's own publish gate executes the verify rules it just wrote); do not declare `auth.credentials[]`/`e2e.credentials[]` in phase 1 (merged declarations fail the next session closed until credentials are stored) — prefer seeded non-2FA users and call credential setup out in the PR body instead.
4. **Publish** — opens a ready-for-review PR while retaining an internal manual-review signal in phase 1: the control plane clamps onboarding verification to manual review, and pins the profile against per-prompt agent overrides. Existing draft-state columns remain compatibility metadata only.

### Out of scope (phase 2/3)

UI trigger button; wiring the dormant `runtimePreviewContract`/`"onboarding"` SessionDO override to a route; post-merge automatic smoke session; funnel telemetry; `cycloid init`-style local wizard (niche: IP-sensitive pre-access customers); Renovate-style auto-regeneration semantics beyond the existing review loop.

## Verification

- Unit tests in the same PR: agent resolution metadata, route flag validation (incl. verify mutual exclusion), prompt-queue profile threading and per-prompt-override pinning, playbook content invariants pinned to parser field names plus a parser round-trip, the onboarding manual-review gate fold, and the verification ready-promotion hold. Bridge section _injection_ is covered by E2E (the `onboarding_agent_profile` section name in the session export), not unit tests.
- E2E (per [docs/testing.md](../../testing.md)): an onboarding session on prod against `trycycloid/mia-copy-2`. Pass bar, judged against hand-built PR #2:
  - `resolveAppRuntimeProfile` accepts the authored `.cycloid.json` with zero error diagnostics.
  - Live boot attempted with transcript evidence (compose up, ready poll, auth validate) or an explicit, accurate fallback report.
  - Authored `verify.test.rules` pass on the session's own publish gate.
  - `CYCLOID.md` ≤8 KB with a frontmatter-accurate rule index.

## Risks

- **Compose-up inside a session is unproven** (only `dockerd` liveness is). First E2E run resolves it; the static-validation fallback keeps failure non-fatal (draft PR + honest report).
- **Session length/timeouts**: mia-grade cold boot is ~20 min; boot iteration multiplies that. Existing setup/verify timeouts apply; if the E2E run hits ceilings, sizing them is a follow-up, not a blocker for simpler repos.
- **Known friction for the agent**: protected-path guard false-positives on env-pattern searches (ARC-1169); branch-name inference can ingest injected memory text (observed on session `6103951f`, separate fix).
