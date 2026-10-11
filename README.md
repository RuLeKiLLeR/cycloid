# Cycloid ✨

AI-powered background coding agent for enterprise teams. Describe a task in natural language; Cycloid runs an agent (Codex or Claude Code) in an isolated cloud sandbox against a real GitHub repository and opens a pull request. Trigger tasks via the web UI, Slack, or Linear.

## Quick start

```bash
git clone https://github.com/trycycloid/cycloid.git
cd cycloid
npm install
npm install --prefix apps/ui
brew install just  # task runner; other platforms: https://github.com/casey/just#installation
```

Copy `apps/control-plane-worker/.dev.vars.example` to `apps/control-plane-worker/.dev.vars` and fill in your keys.

```bash
just --list       # discover every common command
just dev          # full dev stack: migrations, seed, tunnel, API + UI
just dev-api      # API only (wrangler, http://localhost:3000)
just dev-ui       # UI only  (vite,     http://localhost:5173)
just test         # vitest
just typecheck    # type-check all workspaces
```

Recipes wrap the underlying `npm run …` and `scripts/…` entries, so existing commands keep working.

## Project structure

```
apps/
  control-plane-worker/  Cloudflare Workers API (Durable Objects, D1, KV)
  ui/                    React dashboard (Vite + Tailwind)
  sandbox-e2b/           Active E2B sandbox template and startup scripts
  sandbox-bridge/        Node bridge between control plane and agent runtime (runs inside E2B)
  cli/                   Node CLI (auth and session commands)
  slack/                 Slack integration (webhook validator, client)
  linear/                Linear issue automation (webhooks, OAuth)
shared/          Cross-app TypeScript modules (agent, events, transcript)
infra/           Terraform (Cloudflare Pages/DNS, AWS: S3, SSM, IAM)
tests/           Test suites (vitest)
docs/            Architecture, conventions, and research docs
scripts/         Dev tooling, deploy helpers, migration scripts
```

## How it works

1. **Task submitted** via web UI, Slack DM, or Linear issue
2. **Session created** -- control plane (Cloudflare Durable Object) provisions an E2B sandbox with a full dev environment
3. **Agent runs** -- Codex or Claude Code in the sandbox, auto-approving tool calls (file edits, bash, web fetch)
4. **Events streamed** -- WebSocket delivers real-time tool calls and text to the UI and Slack thread
5. **PR created** -- diffs committed and pushed, PR opened with the engineer's GitHub token (attributed to the user, not the bot)

## Architecture

**Control plane**: Cloudflare Workers with Durable Objects for stateful session management, D1 (SQLite) for persistence, and KV for caching.

**Sandbox**: Each normal repo session runs in an isolated E2B VM. The E2B startup script prepares the workspace, then runs the Node bridge and agent runtime. Shared runtime helper scripts live under `apps/sandbox-e2b/scripts/`. See [sandbox architecture](docs/sandbox-architecture.md).

**UI**: React + Vite + Tailwind. Served from Cloudflare Pages with a `_worker.js` for API proxying (`/api/*`, `/auth/*` to the control-plane worker) and SPA fallback. Auth is client-side GitHub OAuth. Talks to the API via REST + SSE.

**Infra**: Terraform Cloud manages Cloudflare resources (Pages project, DNS, zone) and AWS resources (S3 for session data, SSM for secrets, IAM for CI/CD OIDC). Deploys auto-apply on merge to `main`.

## Docs

- [What is Cycloid](docs/what-is-cycloid.md) -- system overview and motivation
- [Engineer onboarding](docs/eng-onboarding.md) -- new-hire setup
- [Conventions](docs/conventions.md) -- project structure, layer discipline, TypeScript
- [Database](docs/database.md) -- D1 schema, raw SQL DAO layer, migrations
- [Deployments](docs/deployments.md) -- UI, control plane, sandbox, and infra deploy flows
- [Sandbox architecture](docs/sandbox-architecture.md) -- filesystem layout, process tree, image builds
- [Infrastructure](docs/infrastructure.md) -- Terraform, SSM, TFC conventions
- [Security](docs/security.md) -- secrets, auth, webhook verification
- [Testing](docs/testing.md) -- test organization, mocks, patterns
- [Production](docs/production.md) -- deploys, env vars, troubleshooting
