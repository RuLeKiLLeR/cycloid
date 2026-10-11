# Repository Breakdown Log

Running inventory of which parts of the repo we have already explained and which parts still need review.

## Status legend

- `done` - we have already broken this area down at a useful high level
- `in_progress` - currently being reviewed
- `todo` - not broken down yet

## Current map

| Area                         | Status        | What it appears to own                                                                 | Notes                                                                                                                           |
| ---------------------------- | ------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Repo-wide architecture       | `done`        | Overall product shape, app boundaries, core flow                                       | Initial pass completed on 2026-05-20 using `AGENTS.md`, `docs/codebase-map.md`, `docs/conventions.md`, and root `package.json`. |
| `apps/` overview             | `done`        | App package boundaries, entry points, and prompt-to-PR flow across app packages        | Overview pass completed on 2026-06-05; individual large app packages still need deeper file-by-file breakdowns.                 |
| `apps/control-plane-worker/` | `todo`        | Cloudflare Worker API, auth, Session Durable Object, webhooks, D1-backed control plane | Central backend. Likely the most important area to study first.                                                                 |
| `apps/sandbox-bridge/`       | `todo`        | In-sandbox agent loop, protections, git/PR orchestration                               | Core runtime inside E2B sessions.                                                                                               |
| `apps/ui/`                   | `todo`        | React frontend, session detail UI, API/SSE client                                      | Main product surface for users.                                                                                                 |
| `apps/cli/`                  | `todo`        | Local CLI entrypoints and auth/session commands                                        | Useful for understanding non-UI entrypoints.                                                                                    |
| `apps/sandbox-e2b/`          | `todo`        | Production sandbox template and boot scripts                                           | Infrastructure/runtime image definition.                                                                                        |
| `shared/`                    | `todo`        | Cross-app constants, types, transcript logic, agent config                             | Shared source of truth across the monorepo.                                                                                     |
| `tests/`                     | `todo`        | App- and contract-level verification suites                                            | Best understood after core app areas.                                                                                           |
| `scripts/`                   | `todo`        | Local dev, build, verification, maintenance scripts                                    | Operational glue for developers and CI.                                                                                         |
| `infra/`                     | `todo`        | Terraform and deploy infrastructure                                                    | Higher blast radius; defer until product/runtime path is clear.                                                                 |
| `docs/`                      | `in_progress` | Architecture, conventions, workflows, operational reference                            | We have used docs for orientation, but have not cataloged them in detail.                                                       |
| GitHub / root config         | `todo`        | CI, formatting, workspace config, repo automation                                      | Includes `.github/`, root `tsconfig`, root vitest config, workspace scripts.                                                    |

## Breakdown history

### 2026-05-20

#### Repo-wide architecture

Status: `done`

What we established:

- This is a monorepo with app packages under `apps/`, shared TypeScript modules under `shared/`, tests under `tests/`, infra under `infra/`, and operational scripts under `scripts/`.
- The main product path is:

```text
UI / Slack / API
  -> control-plane-worker
  -> services / DAO / SessionDO
  -> E2B sandbox
  -> sandbox-bridge
  -> Durable Object via WebSocket
  -> SSE / Slack / export readers
```

- `apps/control-plane-worker/` is the control plane and system authority.
- `apps/sandbox-bridge/` is the runtime that actually drives the coding agent in the sandbox.
- `apps/ui/` is the user-facing React app.
- `shared/` holds cross-app source-of-truth code like model registries, transcript projection, sandbox event types, and agent definitions.

Open questions for later breakdowns:

- How session lifecycle state actually moves through the control plane.
- How the bridge enforces safety and command restrictions.
- How the UI reconstructs and renders live session state.
- Which integration packages are production-critical versus auxiliary.

### 2026-06-05

#### `apps/` overview

Status: `done`

What we established:

- Current real workspace app packages are `apps/control-plane-worker/`, `apps/sandbox-bridge/`, `apps/sandbox-e2b/`, `apps/ui/`, and `apps/cli/`.
- `apps/control-plane-worker/` owns the Cloudflare Worker API, route authentication, D1 access, the per-session Durable Object, sandbox spawning, replay/export, webhooks, and projection writes.
- `apps/sandbox-bridge/` runs inside the E2B sandbox, receives prompt commands over WebSocket, drives the agent runtime (Codex or Claude Code), translates agent/tool events, applies bridge-side safety, and handles post-execution git/PR orchestration.
- `apps/sandbox-e2b/` owns the active E2B template, boot scripts, repo checkout, dependency setup, egress enforcement, and bridge startup.
- `apps/ui/` is the React/Vite browser client; it creates sessions, sends prompts, opens the session WebSocket, ingests replay events, and renders transcript/session state.
- `apps/cli/` is a published Node CLI over the same control-plane API; it does not own session state.
- `apps/slack/`, `apps/linear/`, and `apps/notion/` have no tracked files; they are removed/empty stubs, not active workspace packages.

Important entry points:

- `apps/control-plane-worker/src/index.ts`, `apps/control-plane-worker/src/router.ts`, `apps/control-plane-worker/src/routes/sessions.ts`, `apps/control-plane-worker/src/session/state.ts`, `apps/control-plane-worker/src/session/durable-object.ts`
- `apps/sandbox-bridge/src/index.ts`, `apps/sandbox-bridge/src/bridge.ts`, `apps/sandbox-bridge/src/events/translate.ts`
- `apps/sandbox-e2b/template.ts`, `apps/sandbox-e2b/start-bridge.sh`
- `apps/ui/src/main.tsx`, `apps/ui/src/authenticated-app.tsx`, `apps/ui/src/components/SessionDetail.tsx`, `apps/ui/src/hooks/useSessionReplay.ts`, `apps/ui/src/hooks/useSessionWebSocket.ts`, `apps/ui/src/api/sessions.ts`
- `apps/cli/src/index.ts`, `apps/cli/src/commands/create.ts`, `apps/cli/src/commands/watch.ts`, `apps/cli/src/api.ts`

Open questions for later breakdowns:

- Detailed session lifecycle reducer flow inside `apps/control-plane-worker/src/session/lifecycle/`.
- Exact bridge post-execution pipeline under `apps/sandbox-bridge/src/services/post-execution/`.
- UI transcript reducer and replay merge behavior under `apps/ui/src/hooks/session-state/`.

## Suggested next order

1. `apps/control-plane-worker/`
2. `apps/sandbox-bridge/`
3. `apps/ui/`
4. `shared/`
5. `tests/`
6. `scripts/`
7. Remaining integration and infra packages
