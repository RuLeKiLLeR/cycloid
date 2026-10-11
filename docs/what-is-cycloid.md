# What is Cycloid?

Cycloid is a background coding-agent platform. A user submits work from Slack, the web UI, or the API; Cycloid provisions an isolated sandbox, runs an agent with repo context and tools, streams progress to the control plane, and can open a PR with the changes.

Runtime boundaries:

| Component                    | Runtime                                   | Owns                                                                          |
| ---------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------- |
| `apps/control-plane-worker/` | Cloudflare Workers + D1 + Durable Objects | HTTP API, auth, session state, webhooks, projection writes                    |
| `apps/sandbox-e2b/`          | E2B template                              | Active sandbox image build and boot scripts                                   |
| `apps/sandbox-bridge/`       | Node inside the sandbox                   | Agent runtime (Codex or Claude Code), safety limits, git and PR orchestration |
| `apps/ui/`                   | React + Vite                              | Session UI, streaming transcript rendering, settings                          |
| `shared/`                    | TypeScript modules shared across apps     | Agent config, shared types, transcript projection                             |

## End-to-end flow

1. Task submitted via Slack, UI, or API.
2. Control-plane worker creates or resumes a session and provisions a sandbox.
3. `sandbox-bridge` drives the agent (Codex or Claude Code) in that sandbox.
4. Bridge events are translated into canonical `CycloidEvent` envelopes and sent to the session Durable Object.
5. The DO persists state, fans events out to UI and Slack, and coordinates follow-up prompts.
6. The session may commit changes and open a PR as the engineer's GitHub identity.

## Architecture invariants

- **The session Durable Object is the source of truth for the event log.** Mutable session state, prompt queueing, and durable event persistence route through `SessionDO`.
- **The lifecycle FSM is the source of truth for post-publish coordination state.** After a PR opens, where a session sits in its review/QA/merge-ready lifecycle lives in D1 `pr_coordination`, driven by the `applyEvent` reducer (`src/session/fsm/`); session status, PR labels, stage, and `cycloid_done` project from that record. Complements the DO (which still owns the event stream), not a contradiction. See [docs/fsm.md](fsm.md).
- **`sandbox-bridge` is the only event translator.** The control plane persists and broadcasts bridge events; it does not reinterpret raw Codex events.
- **The control plane owns security decisions.** Auth, repo authorization, integration gating, and credential resolution happen server-side.
- **The UI is a read/write client, not the authority.** It renders streamed events and calls API routes; no business logic.
- **PRs are attributed to the user.** Sessions prefer the engineer's GitHub token, falling back to installation tokens when user tokens fail.
- **Startup prefers existing state.** Reuse a paused runtime, then a configured prebaked repo snapshot (repo + deps baked into the image: E2B via E2B_REPO_SNAPSHOT_MAP_JSON, Freestyle via FREESTYLE_REPO_SNAPSHOT_MAP_JSON), then fresh clone.

## State and transport boundaries

- **HTTP routes** live in the control plane and dispatch `route -> service -> DAO`.
- **Durable event replay**: canonical incremental read path for live session history.
- **Session export**: canonical full-session snapshot path for transcript/export consumers.
- **WebSocket**: bridge-to-DO events (per-session) and browser-to-control-plane sidebar feed (per-business).
- **SSE**: browser-facing streaming transport.

Visual diagrams: [docs/diagram/](diagram/) holds the system-architecture diagram and the lifecycle FSM diagram (Excalidraw source + PNG/SVG exports).

File-level navigation: [docs/codebase-map.md](codebase-map.md). Repo-wide rules: [docs/conventions.md](conventions.md). New engineer setup: [docs/eng-onboarding.md](eng-onboarding.md). Prompt-to-PR execution map: [docs/lifecycle.md](lifecycle.md). Post-publish lifecycle FSM (the coordination spine): [docs/fsm.md](fsm.md).
