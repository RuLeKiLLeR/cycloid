# Sandbox architecture

E2B sandbox filesystem, processes, and data flow at runtime.

## Filesystem layout

### Image layer (baked at build time)

Template defined in `apps/sandbox-e2b/template.ts`, built by `scripts/e2b-template-build.sh`, registered with E2B.

Repo-sourced sandbox template overlays are documented in [sandbox-templates.md](sandbox-templates.md).

| Path                                     | Contents                                                                                                                        | Build step                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `/app/bridge/bundle.js`                  | Bundled TypeScript bridge                                                                                                       | Dockerfile `COPY`                                                     |
| `/app/scripts/`                          | Sandbox helper scripts (`repo-context.sh`, `cycloid-docker-preview`, etc.)                                                      | Dockerfile `COPY`                                                     |
| `/app/start-bridge.sh`                   | E2B startup script: egress, clone, workspace setup, bridge launch                                                               | E2B template `copy`                                                   |
| `/usr/local/sbin/cycloid-enforce-egress` | Root-owned firewall script for domain egress enforcement                                                                        | E2B template `copy`                                                   |
| `/usr/local/bin/curl`                    | Root-owned curl wrapper that logs blocked egress                                                                                | E2B template `copy`                                                   |
| `/usr/local/bin/git`                     | Root-owned wrapper that blocks mutating git commands (push, branch creation, worktree, etc.)                                    | E2B template `copy`                                                   |
| `/usr/local/bin/gh`                      | Root-owned wrapper that blocks mutating gh commands (pr create/merge/close, issue mutations, API writes, browse)                | E2B template `copy`                                                   |
| `/usr/local/lib/cycloid/real-bin/`       | Real git/gh binaries moved from /usr/bin; wrappers invoke these for allowed commands                                            | Dockerfile `mv`                                                       |
| `/workspace/`                            | Empty working directory                                                                                                         | Dockerfile `RUN mkdir -p /workspace`                                  |
| `/app/bridge/`                           | Directory for bridge bundle                                                                                                     | Dockerfile `RUN mkdir -p /app/bridge`                                 |
| System packages                          | git, curl, Node.js 22, Python 3.12, build-essential, iptables                                                                   | Dockerfile `apt-get install` + `RUN`                                  |
| Fonts                                    | Inter, Mia/OpenEvidence product fonts, Liberation, Noto Sans/Serif core, Noto Color Emoji, Fira Code, JetBrains Mono            | Dockerfile `apt-get install`, pinned font downloads, `fc-cache`       |
| Browser tooling                          | system Chromium plus Playwright-managed Chromium for the pinned global Playwright install                                       | Dockerfile `apt-get install chromium` + `playwright install chromium` |
| Python packages                          | black, httpx, mypy, pydantic, pytest, pytest-asyncio, pytest-cov, pytest-mock, pytest-timeout, Playwright, pre-commit, ruff, uv | Dockerfile `pip install`                                              |

Baked env vars: `HOME=/home/user`, `NODE_ENV=development`, `PYTHONPATH=/app`, `PATH=/app/scripts:...`.

**Rule:** If bridge guidance or runtime code tells the agent to invoke a sandbox helper script, either reference the absolute `/app/scripts/<name>` path or ensure `/app/scripts` is on `PATH` in the image. Do not rely on image-local helper mounts being implicitly discoverable.

**Login-shell PATH:** The agent runs every shell command as `bash -lc` (login shell). Debian's `/etc/profile` resets `PATH` from `/etc/login.defs` defaults, overriding Dockerfile `ENV PATH=...`. The template writes `/etc/profile.d/cycloid-path.sh` so login shells re-prepend `/app/scripts`; without it, `bash -lc 'cycloid-app start'` fails with "command not found" even though `/app/scripts/cycloid-app` exists.

**Base-image weight is shared cost; default to NOT adding.** Every package added to `template.ts` is downloaded on every sandbox cold-pull for every repo, forever. The base is a one-way ratchet: easy to grow, expensive to trim (each removal must also update `ready-check.sh`, the `template-dockerfile.test.ts` guardrail, and any `ENV`/`PATH` coupling - and `ready-check.sh` re-runs on every repo-layer build, so a half-done removal breaks unrelated repos' builds). Before adding to the base:

- The base is only for tooling **every** session needs (bridge runtime, git/gh, agent runtimes, egress enforcement, core shell utils). Repo-specific needs don't belong here.
- Repo-specific toolchains (language SDKs, IaC tools, DB servers, test frameworks) belong in the per-repo layer (`.cycloid/sandbox.layer.Dockerfile`). See [sandbox-templates.md](sandbox-templates.md).
- A "small" package is rarely small once its dependency closure and browser/runtime caches are counted. Measure with `docker history` before and after; pin + checksum-verify what you add.
- If you must add to the base, justify in the PR: which sessions need it, why a per-repo layer can't carry it, and the measured size delta.

### Runtime layer (ephemeral, writable)

| Path               | Contents                                       | Created by             |
| ------------------ | ---------------------------------------------- | ---------------------- |
| `/workspace/repo/` | Shallow clone of target GitHub repo (depth 20) | `/app/start-bridge.sh` |

E2B sandboxes preserve filesystem and memory across pause/resume. Running sandboxes use a live lease; paused sandboxes expire after the retention window (72h in production and QA) and are removed by the scheduled cleanup sweep. **Exception: FINAL-terminal sessions (`MERGED`/`CLOSED`/`SUPERSEDED`/`ARCHIVED`) bypass the 72h pause — the FSM's `terminate_runtime` side-effect reclaims the VM immediately instead of parking it.** Everything else dies when the sandbox is terminated or expires.

## Process tree

Two main processes per sandbox:

### E2B command: startup script

Command: `bash /app/start-bridge.sh` (workdir `/workspace/repo`)

Defined in `apps/sandbox-e2b/start-bridge.sh`. Six steps:

1. **enforce egress** -- applies domain allowlist firewall rules via `/usr/local/sbin/cycloid-enforce-egress` when `ARCANIST_SANDBOX_EGRESS_ALLOWLIST` is set and `ARCANIST_SANDBOX_EGRESS_ENFORCEMENT` is not disabled.
2. **boot workspace** -- shallow-clones or fetches the target repo into `/workspace/repo/`, checks out `CHECKOUT_BRANCH` or `BRANCH`, scrubs credential-bearing remotes.
3. **prepare agent state** -- creates isolated per-session agent home (`CODEX_HOME` for codex, `~/.claude/projects/` for claude_code), enables no-login startup, defers Codex auth resolution to the bridge (which derives auth from session-scoped sandbox credentials when absent and fails closed without credentials), marks dependency setup state for the bridge.
4. **start dependency setup** -- if the repo ships `.cycloid/setup.sh`, runs it in the background (repo owns setup end-to-end, replacing auto-detect); else runs `npm ci`/`pnpm`/`yarn` in the background when a root lockfile exists. The bridge uses `CYCLOID_WORKSPACE_SETUP_*` markers to delay prompt dispatch until setup completes. A setup script that exits non-zero or times out (hardcoded 540s, below the bridge's 10-minute wait) writes `ARCANIST_WORKSPACE_SETUP_FAILED_PATH` so the bridge surfaces the failure to the UI/transcript, but still marks ready so the agent keeps running. Cycloid-owned credentials the install never needs (`SANDBOX_AUTH_TOKEN`, `ARCANIST_TOKEN`, `CODEX_API_KEY`, `OPENAI_API_KEY`) are scrubbed from the script's environment; `GITHUB_CLONE_TOKEN` stays for private dependency installs. See [customer-repo-config.md](customer-repo-config.md).
5. **bootstrap Cycloid CLI auth** -- after dependency setup is spawned, mints a short-lived owner auth token via sandbox auth, writes `~/.cycloid/config.json`, exports `ARCANIST_TOKEN` with `ARCANIST_API_URL` for the bridge and agent process tree. When a repo-owned `.cycloid/setup.sh` exists, waits for it to complete so untrusted setup cannot read the CLI auth token.
6. **start bridge** -- records `bridge_exec` in `/tmp/cycloid-start-bridge.log`, starts `node /app/bridge/bundle.js`.

### Node bridge

Command: `node /app/bridge/bundle.js` (cwd `/workspace/repo`)

Defined in `apps/sandbox-bridge/src/bridge.ts`. Responsibilities:

1. Resolves working directory: `/workspace/repo` if it exists, else `/workspace`.
2. Starts the agent runtime via `createCodex({ cwd })` (codex), the Claude Agent SDK (claude_code), or opencode serve mode (opencode).
3. Connects to the control plane via WebSocket.
4. Relays prompts from the control plane to the agent; streams events (tokens, tool calls, completion) back.

#### Connection error handling

The ws library (v8) emits `"Unexpected server response: <code>"` on failed WebSocket upgrades, NOT `"HTTP <code>"`. Code classifying errors by HTTP status must match both formats.

**Startup grace period**: 404 on the WS endpoint means "session not found" in the DO. During the first 30s of bridge startup this is non-fatal (race: bridge may connect before the DO has persisted session state). After the grace period, 404 is fatal.

**Fatal vs retriable errors**: 401/403/409/410 are always fatal (immediate exit). 404 is fatal only after the grace period. All other errors (ECONNREFUSED, timeouts, etc.) are retriable with exponential backoff (2s base, 60s max).

### Agent runtime

Spawned by the bridge. Codex backend: `codex app-server` with cwd `/workspace/repo`. claude_code backend: a persistent Claude Agent SDK `query()` session. opencode backend: an opencode server subprocess started from the bridge with a sanitized agent-child env. See [docs/bridge.md](bridge.md#agent-runtime-backends) for the per-backend comparison.

All agent file operations -- reads, writes, shell commands, tool calls -- happen inside `/workspace/repo/`.

The bridge and agent runtime run as the same Unix user today.
Protected-path and command guards are defense-in-depth around the supported tool paths, not a kernel-enforced read-deny boundary between bridge files and agent commands.
Agent child envs are minimized by `buildAgentChildEnv`: bridge-only tokens and full sandbox-auth-token file pointers are withheld, provider keys needed by the selected runtime remain reachable, trusted integration credentials are preserved only for referenced higher-trust MCP paths, and the `gh` shim receives only a derived `/session/github-token` mint-token file pointer.

## Where file changes live

Agent file changes live in `/workspace/repo/` and survive stop/resume within the retention window. The durable way changes survive outside the sandbox is to **commit and push to GitHub**. After each prompt completes, the bridge reads the current branch and commit SHA via `git rev-parse` and reports them to the control plane in the `execution_complete` event, also used to capture latest session snapshot metadata.

## App Runtime Profiles

Runtime preview configuration is contract-driven. The control plane resolves **App Runtime Profiles** into a structured preview contract, diagnostics, and provenance so sessions don't fabricate browser evidence.

- Docker Compose repos must declare an explicit Docker App Runtime Profile in `.cycloid.json`.
- Only Docker App Runtime Profiles are supported for runtime preview contracts.
- Invalid or degraded profiles surface as structured runtime-profile diagnostics in session runtime provenance.
- Browser/runtime evidence is user-directed for non-UI changes; UI-touching diffs prefer static screenshots when they strongly evidence the changed visible state, else use targeted tests, browser automation, runtime logs, or requested WebM walkthroughs.
- No profile available: verification falls back to code review, static checks, and tests.
- Runtime onboarding smoke tests and manual checks may use `/app/scripts/cycloid-docker-preview` to start the configured runtime and write the preview contract.
- End-to-end runs use `/app/scripts/cycloid-app <start|auth|run|stop|reset|seed>`. `start` is idempotent and prints the host:port; `auth` runs the repo-owned `appRuntime.auth.command` and writes Playwright storage state under `/tmp/cycloid-auth/`; `run <cmd>` exec's a command against the live app (e.g. `cycloid-app run npm run test:e2e`) with declared runtime credential env vars present; evidence (traces, WebM videos, reports) lands under `/tmp/cycloid-evidence/e2e-<timestamp>/` and is uploaded as PR artifacts. Video evidence is WebM-only (`video/webm`), capped at 50 MB, linked from PR bodies. E2E guidance is injected when `appRuntime.e2e.testCommand` is declared; for App Runtime Profiles without e2e, managed boot guidance is injected instead.
- The E2B template pre-bakes Chromium for the pinned global Playwright version. Customer `testCommand` still owns project dependency installation and must install any non-Chromium browsers or Playwright versions that don't use the shared browser cache.
- Runtime onboarding smoke tests may pass a validated proposed profile to the SessionDO before `.cycloid.json` is merged. Onboarding also scans `package.json` for `test:e2e` / `db:seed` / `db:reset` scripts and pre-fills the proposed `e2e` block.

Example Docker App Runtime Profile:

```json
{
  "appRuntime": {
    "kind": "web",
    "runner": "docker",
    "entry": {
      "type": "compose",
      "files": ["docker-compose.yml"],
      "service": "web"
    },
    "url": {
      "hostPort": 3000,
      "path": "/"
    },
    "additionalPorts": [{ "service": "api", "hostPort": 3001, "containerPort": 3001 }],
    "ready": {
      "path": "/"
    },
    "open": {
      "path": "/"
    }
  }
}
```

Fields:

- `kind`: `"web"` only.
- `runner`: `"docker"` only.
- `entry.type`: `"compose"` only.
- `entry.files`: array of repo-relative Compose files; defaults to a root Compose file when one is obvious.
- `entry.service`: Compose service key; set when multiple services or ambiguous.
- `url.hostPort`: port exposed by the container; Cycloid probes `127.0.0.1:<hostPort>`.
- `additionalPorts`: optional extra browser-reachable service ports, for apps whose frontend calls a separate API port. Each entry supports `service` (defaults to `entry.service`), `hostPort`, and optional `containerPort`.
- `url.path`: optional URL path; defaults to `/`.
- `ready.path`: readiness path; defaults to `/`.
- `ready.timeoutSeconds`: optional readiness timeout in seconds. Defaults to **900 (15 min)** — long enough for a cold `docker compose build` cascade on a customer's first session. Override smaller for fast-starting apps that should fail loudly when broken (e.g. `30` for a Vite dev server).
- `open.path`: browser open path; defaults to `/`.
- `auth` (optional): repo-owned auth setup for protected-route visual evidence.
  - `command`: shell command run after the app is healthy. Receives `ARCANIST_BASE_URL`, `ARCANIST_AUTH_VALIDATE_URL`, `ARCANIST_AUTH_STATE_PATH`, and declared `auth.credentials[]` env vars. Must write Playwright storage state JSON to `ARCANIST_AUTH_STATE_PATH`.
  - `validatePath`: optional app-relative protected route used to prove the storage state works. Defaults to `open.path`, then `url.path`, then `/`.
  - `credentials`: optional array of `{ name, envVar, source? }` declarations, resolved through the same test-credential path as `e2e.credentials[]`. `source` may be `business_openai_key`, `business_anthropic_key`, or `business_neon_branch`: OpenAI and Anthropic resolve from the business BYOK provider key when no explicit value is stored, while Neon provisions a per-session branch and injects its connection URI.
- `composeEnv`: optional static environment variables passed to Docker Compose.
- `generatedComposeEnv` (optional): environment variables Cycloid generates at runtime. Each key maps to `{ type: "hex", bytes: N }` where `bytes` is 1-128; Cycloid generates a random hex string of `2*N` characters. Useful for session tokens or other secrets that should not be committed. Keys must not overlap with `composeEnv`; overlap is rejected at session start.
- `env`: optional environment variables passed directly to the container.
- `e2e` (optional): the end-to-end runtime contract used by `cycloid-app`.
  - `testCommand` (required when block present): shell command to run the suite (e.g. `npm run test:e2e`).
  - `seedCommand`, `resetCommand`: optional commands invoked by `cycloid-app seed` and `cycloid-app reset`.
  - `credentials`: optional array of `{ name, envVar, source? }` declarations for explicit fail-closed test secrets. The control plane resolves each `name` against `business_test_credentials`; if no row exists, the stored repo `.env` can satisfy the declaration by `envVar`. `source` may be `business_openai_key`, `business_anthropic_key`, or `business_neon_branch`: OpenAI and Anthropic resolve from the business BYOK provider key when no explicit value is stored, and Neon provisions one writable branch per session. Missing declared values fail closed at session start.

Repo `.env` values saved in **Settings → Repository secrets** are encrypted/write-only and merged into Docker `composeEnv` at session start. They override checked-in `.cycloid.json` `composeEnv` and personal secrets on key collision; resolved `auth.credentials[]` and `e2e.credentials[]` values override both. Personal secrets (per-user environment variables from **Settings → Personal secrets**) are merged first and overridden by repo secrets when keys collide.

## E2B sandbox lifecycle

Managed by the control plane (SessionDO) via `E2BSandboxClient`:

1. **Create** -- `E2BSandboxClient.createSandbox()` provisions a sandbox from the configured template; the bridge starts via an E2B command after creation.
   - Optional public-repo prebuilds: `E2B_REPO_SNAPSHOT_MAP_JSON`, keys like `owner/repo` or `owner/repo@branch`, values E2B snapshot IDs. The control plane ignores the map unless repo visibility is known public.
2. **Running** -- live lease (`runtimeLiveLeaseExpiresAt`) refreshed by the SessionDO; provider TTL also refreshed on a throttled cadence.
3. **Pause** -- verifier user stops pause via `E2BSandboxClient.pauseSandbox()` (retention expiry `runtimeStateExpiresAt` set, default 72h). Non-verifier user stops keep the sandbox live-idle (no pause, socket open) so the next prompt dispatches to the live agent. **FINAL-terminal sessions (merged/closed/superseded/archived) do not pause — the FSM `terminate_runtime` side-effect terminates the VM immediately.**
4. **Resume** -- next prompt resumes via `E2BSandboxClient.connectSandbox()`; filesystem and memory preserved.
5. **Terminate** — expired sandboxes are terminated by the scheduled retention cleanup sweep (`cleanupExpiredE2BRuntimes`). Orphaned sandboxes (no D1 reference in `session_index`) are reaped by the scheduled orphan reaper (`runE2BOrphanSandboxReaper`). **FINAL-terminal sessions** (merged/closed/superseded/archived) have their VMs reclaimed immediately via the FSM's `terminate_runtime` side-effect (reason `session_terminal`), reusing the same DO cleanup-run workflow (`runE2BRuntimeCleanupViaSessionDO`) — a third, event-driven termination path distinct from cron sweeps.

## Identifier taxonomy

- `session_id` is the session primary key, Durable Object name, and WebSocket path identifier. Session creation normally mints it, but the HTTP API may accept a caller-supplied value.
- `sandboxId` is the control-plane bootstrap identity stored in DO-local `sandbox_state.sandbox_id` and echoed through `SANDBOX_ID`, bridge events, and `X-Sandbox-ID`. For cold-created runtimes it equals the control-plane spawn attempt id; resumed runtimes retain the value already baked into their environment, and pre-cutover runtimes retain their original independently minted value. It scopes the sandbox auth exchange, stale-spawn checks, and platform LLM capabilities, but does not authenticate a sandbox without `SANDBOX_AUTH_TOKEN`.
- The control-plane `spawnAttemptId` identifies one sandbox spawn attempt and scopes its durable workflow steps. Sandbox lifecycle events expose it as `startupAttemptId`. Separately, the bridge mints a per-prompt `startupAttemptId`; the shared field name is a naming collision, not a shared lifetime.
- `runtime_sandbox_id` is the active provider-assigned runtime id: an E2B sandbox id or Freestyle VM id. It is persisted in DO sandbox state and D1 `session_index`, and it is the only identifier valid for provider connect, pause, terminate, and reaper operations. Start debugging provider state from `session_index.runtime_sandbox_id`.
- `modal_object_id` is legacy provider metadata that remains as a provider-object-id fallback for historical rows.

## Legacy: pre-E2B sandbox sessions

Sessions created before the E2B migration used the previous sandbox provider. The old provider runtime is removed; `modal_object_id` remains as historical metadata and a provider-object-id fallback.

## Key file references

| File                                                      | Role                                                     |
| --------------------------------------------------------- | -------------------------------------------------------- |
| `apps/sandbox-e2b/scripts/cycloid-app`                    | Active E2B runtime helper for preview/E2E flows          |
| `apps/sandbox-e2b/scripts/cycloid-docker-preview`         | Active preview compatibility wrapper                     |
| `apps/sandbox-e2b/scripts/repo-context.sh`                | Active repo context helper                               |
| `apps/sandbox-e2b/scripts/start-dockerd.sh`               | Active Docker bootstrap helper                           |
| `apps/sandbox-e2b/start-bridge.sh`                        | Active E2B startup script                                |
| `apps/sandbox-bridge/src/bridge.ts`                       | WebSocket bridge between control plane and agent runtime |
| `apps/control-plane-worker/src/sandbox/e2b-client.ts`     | E2B sandbox client (create, pause, resume, kill)         |
| `apps/control-plane-worker/src/session/durable-object.ts` | Session authority and sandbox lifecycle                  |
| `scripts/e2b-template-build.sh`                           | E2B template build script                                |

For outbound network dependencies and the enforcement design, see
[`docs/reference/sandbox-egress.md`](reference/sandbox-egress.md).
