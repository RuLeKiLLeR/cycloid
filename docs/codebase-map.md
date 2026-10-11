# Codebase map

Navigation, ownership, and "where should I edit X?" lookups across the repo.

## Apps

| App                     | Runtime                 | Key entry points                                                        | What it owns                                          |
| ----------------------- | ----------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------- |
| `control-plane-worker/` | Cloudflare Workers + D1 | `src/index.ts`, `src/router.ts`                                         | API routes, auth, SessionDO, projections, webhooks    |
| `sandbox-bridge/`       | Node in E2B sandbox     | `src/index.ts`, `src/bridge.ts`                                         | Agent event loop, safety guards, git/PR orchestration |
| `ui/`                   | React + Vite            | `src/main.tsx`, `src/api/client.ts`, `src/api/cache.ts`                 | Session UI, SSE consumption, settings                 |
| `sandbox-e2b/`          | E2B template            | `template.ts`, `start-bridge.sh`                                        | Production E2B sandbox image for Cycloid sessions     |
| `cli/`                  | Node                    | `src/index.ts`                                                          | CLI auth and session commands                         |
| `shared/`               | TypeScript modules      | `shared/agent`, `shared/constants`, `shared/types`, `shared/transcript` | Cross-app source of truth                             |

## Where to find things

| I need to...                                                 | Start here                                                                                                                                                                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add or change an API route                                   | `apps/control-plane-worker/src/routes/`, then the matching service and DAO                                                                                                                                 |
| Change route auth or repo authorization                      | `apps/control-plane-worker/src/router.ts`, `src/auth/`, `src/auth/repo-authorization.ts`                                                                                                                   |
| Add or change a migration                                    | `apps/control-plane-worker/migrations/`, then the matching DAO in `src/**/db.ts`                                                                                                                           |
| Change session state transitions or event persistence        | `apps/control-plane-worker/src/session/lifecycle/` (DO storage-state reducer + types), `src/session/durable-object.ts`, `src/session/events.ts`, `src/services/session-projection.ts`                      |
| Change post-publish PR/review lifecycle (the ARC-1330 FSM)   | `apps/control-plane-worker/src/session/fsm/` (`applyEvent` reducer + `project()`), `src/services/review-loop-sweep.ts`; source of truth for post-publish lifecycle state — see [fsm.md](fsm.md)            |
| Change replay/export behavior                                | `apps/control-plane-worker/src/routes/sessions.ts`, `src/session/state.ts`, `shared/transcript/projector.ts`                                                                                               |
| Add webhook behavior                                         | `apps/control-plane-worker/src/routes/webhooks.ts`, `src/webhooks/handlers.ts`, `src/webhooks/verify.ts`                                                                                                   |
| Change integration availability or credential resolution     | `apps/control-plane-worker/src/integrations/service.ts`, `src/integrations/runtime.ts`, `shared/constants/integrations.ts`                                                                                 |
| Change UI API calls                                          | `apps/ui/src/api/` (modules: `cache.ts`, `client.ts`, `sessions.ts`, `repos.ts`, etc.)                                                                                                                     |
| Change UI rendering                                          | `apps/ui/src/pages/`, `apps/ui/src/components/`, `apps/ui/src/utils/`                                                                                                                                      |
| Change transcript projection or prompt bucketing             | `shared/transcript/projector.ts`                                                                                                                                                                           |
| Change agent identity or built-in configs                    | `shared/agent/constants.ts`, `shared/agent/schema.ts`                                                                                                                                                      |
| Change bridge limits or protection rules                     | `apps/sandbox-bridge/src/constants/bridge.ts`, `src/utils/protection.ts`, `src/utils/bash-parser.ts`                                                                                                       |
| Change E2B template or sandbox boot                          | `scripts/e2b-template-build.sh`, `apps/control-plane-worker/src/sandbox/e2b-client.ts`                                                                                                                     |
| Debug or change sandbox reaping / orphan + retention cleanup | `apps/control-plane-worker/src/sandbox/e2b-orphan-reaper.ts`, `src/session/cleanup.ts`, `src/session/durable-object.ts` (`runE2BOwnerGuard`); debugging: [docs/debugging-runbook.md](debugging-runbook.md) |
| Change changelog glossary terms                              | `docs/changelog-glossary.md`                                                                                                                                                                               |
| Change infra or deploy behavior                              | `infra/`, `.github/workflows/`, [docs/deployments.md](deployments.md)                                                                                                                                      |
| Add tests                                                    | `tests/` with the suite that matches the touched app or contract                                                                                                                                           |

## Cross-app flow

```text
UI / Slack / API
  -> control-plane-worker routes
  -> services / DAO / SessionDO
  -> E2B sandbox
  -> sandbox-bridge
  -> Durable Object via WebSocket
  -> SSE / Slack / export readers
```

## Shared source-of-truth files

| File                                  | Purpose                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| `shared/agent/constants.ts`           | Built-in agent definitions and base prompt data                                  |
| `shared/agent/schema.ts`              | Agent config types                                                               |
| `shared/command-classification.ts`    | Command classification (check vs exploratory) for optimistic publish verdict     |
| `shared/constants/models.ts`          | Supported model registry                                                         |
| `shared/constants/integrations.ts`    | Integration registry and tool metadata                                           |
| `shared/post-execution.ts`            | Publish-mode precedence, gate folding, authoritative publish decision            |
| `shared/publish-decision.ts`          | Optimistic publish verdict resolution from block/warn/manual-review signals      |
| `shared/types/sandbox.ts`             | Canonical sandbox event and command types                                        |
| `shared/transcript/projector.ts`      | Canonical durable-event projection                                               |
| `shared/transcript/prompt-display.ts` | Prompt display-text derivation (strips Slack/agent scaffolding before UI render) |

## High-signal entry points by app

### `control-plane-worker`

- `src/router.ts` - auth tier enforcement and dispatch
- `src/routes/` - HTTP handlers by feature
- `src/services/session-projection.ts` - only write path for `session_index` and replay metadata
- `src/session/durable-object.ts` - session authority; `finalizeSandboxStopped()` is the canonical helper for stop/close sandbox-state transitions (single sandbox patch + rich-status sync + broadcast)
- `src/session/lifecycle/` - pure reducer + decision pipeline driving DO storage state and deadlines
- `src/session/fsm/` - the ARC-1330 lifecycle FSM: the `pr_coordination` reducer (`applyEvent`), event producers, and `project()` projections — the source of truth for post-publish PR/review lifecycle state (distinct from `session/lifecycle/` above); see [fsm.md](fsm.md)
- `src/webhooks/` - webhook verification, dispatch, and idempotency

### `sandbox-bridge`

- `src/bridge.ts` - core event loop
- `src/utils/protection.ts` - protected paths and write guards
- `src/utils/bash-parser.ts` - blocked/destructive shell command handling
- `src/services/hook-bootstrap.ts` - repo-declared git hook manager detection and bootstrap
- `src/services/pr.ts` - commit/push orchestration

### `ui`

- `src/api/` - all API and SSE access (split across `cache.ts`, `client.ts`, `sessions.ts`, etc.)
- `src/pages/SessionPage.tsx` - session route entry
- `src/components/SessionDetail.tsx` - session route component; coordinates `useSession*` hooks
- `src/utils/transcript.ts` - client-side transcript shaping

### `sandbox-e2b` helper scripts

- `apps/sandbox-e2b/scripts/cycloid-app` - runtime preview/E2E verb wrapper
- `apps/sandbox-e2b/scripts/cycloid-docker-preview` - compatibility shim for preview startup
- `apps/sandbox-e2b/scripts/repo-context.sh` - repository summary helper used at session start
- `apps/sandbox-e2b/scripts/start-dockerd.sh` - privileged Docker bootstrap helper

For repo-wide coding rules, open [docs/conventions.md](conventions.md). For migration and DAO rules, open [docs/database.md](database.md).
