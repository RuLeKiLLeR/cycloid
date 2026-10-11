# Agent Runtime Backends

Two independent runtime axes:

- `runtime_backend` / `ARCANIST_RUNTIME_BACKEND`: sandbox provider. Only `e2b_cloud` exists today.
- `agentRuntimeBackend` / `ARCANIST_AGENT_RUNTIME_BACKEND`: coding-agent backend (`codex`, `claude_code`, or `opencode`).

`codex`, `claude_code`, and `opencode` are the production backends.
`opencode` runs Baseten Kimi K2.7 Code, the sole vision-capable opencode model.
The "Bridge Runtime", "Event Translation", and "Prompts And Guidance" sections describe all three production backends.

This doc covers the coding-agent axis. Source-verified against `shared/agent/agent-runtime-backend.ts`, `shared/constants/models.ts`, `apps/control-plane-worker/src/services/session-model-routing.ts`, `apps/control-plane-worker/src/integrations/runtime.ts`, `apps/control-plane-worker/src/session/durable-object.ts`, and `apps/sandbox-bridge/src/agent/*`.

## Feature Support Matrix

Source-verified support per backend. Legend: **yes** = full; **partial** = works with the noted caveat; **no** = not supported (`gap ARC-####` = tracked Linear ticket to close it; otherwise unimplemented or blocked); **intentional** = deliberately unsupported.

| Feature                                     | codex                                                                                                                                       | claude_code                                                                       | opencode                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------- |
| Selectable start models                     | yes (OpenAI: `gpt-5.4`, `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4-mini`, `gpt-5.3-codex-spark` [BYOS]) | yes (`claude-opus-4-8`, `claude-sonnet-4-6`, `claude-sonnet-5`, `claude-fable-5`) | yes (Baseten `kimi-k2.7-code`)          |
| System prompt / behavioral guidance         | yes                                                                                                                                         | yes                                                                               | yes                                     |
| File-edit + bash tools                      | yes                                                                                                                                         | yes                                                                               | yes                                     |
| Tool-safety gates                           | yes                                                                                                                                         | yes                                                                               | yes                                     |
| Memory recall context + telemetry           | yes                                                                                                                                         | yes                                                                               | yes                                     |
| Cycloid MCP + first-party dynamic tools     | yes                                                                                                                                         | yes (repo `.mcp.json` + first-party dynamic tools)                                | yes                                     |
| Skills (prompt-injected, no native surface) | yes                                                                                                                                         | yes                                                                               | yes                                     |
| Verification v2 pipeline                    | yes                                                                                                                                         | yes (works, unexercised in prod)                                                  | yes                                     |
| PR creation / publishing                    | yes                                                                                                                                         | yes                                                                               | yes                                     |
| Followup / continuation                     | yes                                                                                                                                         | yes                                                                               | yes                                     |
| Cross-sandbox resume / restore              | yes                                                                                                                                         | yes                                                                               | yes                                     |
| Question replies (human-in-the-loop)        | yes                                                                                                                                         | yes                                                                               | partial (permission approve/reject)     |
| Token / usage tracking                      | yes                                                                                                                                         | yes                                                                               | yes                                     |
| Reasoning-effort variant                    | yes                                                                                                                                         | yes                                                                               | intentional (OSS provider, no variants) |
| Reasoning / thinking output                 | yes                                                                                                                                         | yes                                                                               | yes                                     |
| Image / multimodal input                    | yes                                                                                                                                         | yes                                                                               | yes                                     |
| Review loop                                 | yes                                                                                                                                         | yes                                                                               | yes                                     |
| `patch` events                              | yes                                                                                                                                         | yes                                                                               | yes                                     |
| `retry_status` events                       | yes                                                                                                                                         | yes                                                                               | yes                                     |
| `todo_update` events                        | yes                                                                                                                                         | intentional (native TodoWrite)                                                    | yes                                     |
| Prod selectability                          | yes (all users)                                                                                                                             | yes (BYOK Anthropic key required)                                                 | yes (BYOK Baseten key required)         |

### OpenCode

`opencode` is a production `agentRuntimeBackend` backed by user-scoped Baseten BYOK credentials.
The remaining `partial`/`intentional` cells are backend limitations:

- Baseten Model API model (`kimi-k2.7-code`) with registry pricing and opencode usage events wired (`shared/constants/models.ts`, `apps/sandbox-bridge/src/services/opencode-event-translator.ts`);
- stock opencode `edit`/`bash`/`webfetch` tools plus Cycloid MCP first-party dynamic tools; built-in tool permissions are auto-answered through the shared bridge safety gate, including protected-path, blocked publish-command, and review-loop worktree checks;
- review-loop and verification v2 run for opencode like the prod backends; the `opencode_probe_session` exemption was removed from `shared/agent/constants.ts` (Phase 8/9), so `autoVerify` is honored, review-loop re-engagement admits opencode sessions, the bridge registers an opencode `verify` agent for phase prompts, and opencode tool safety receives the same review-loop worktree context as Claude Code;
- cross-sandbox resume + followup continuation are wired: the opencode data dir (`~/.local/share/opencode`, minus `auth.json`/bloat) rolls out through the shared `state-rollout` transport and followups reuse the prior opencode session id. First-party memory tools receive the bridge memory pool through a temp-file context and return `memory_recall_usage` through a bridge-read JSONL side channel, not stdout. Question replies cover opencode permission approve/reject only, because the SDK has no free-form answer primitive (`apps/sandbox-bridge/src/agent/opencode-runtime-adapter.ts`, `apps/sandbox-bridge/src/services/opencode-event-translator.ts`).

## Backend And Model Binding

`shared/agent/agent-runtime-backend.ts` defines the valid values:

- `codex`: OpenAI-backed Codex runtime.
- `claude_code`: Anthropic-backed Claude Code runtime.
- `opencode`: Baseten-backed OSS-model runtime.

Unset or empty backend input resolves to `codex`; unknown non-empty values throw. This fail-closed behavior is used by both control plane and sandbox bridge.

`shared/constants/models.ts` binds each model to exactly one backend today:

| Backend       | Provider  | Selectable start models                                                                                                       | Default           |
| ------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `codex`       | OpenAI    | `gpt-5.4`, `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4-mini`, `gpt-5.3-codex-spark` (BYOS) | `gpt-5.4`         |
| `claude_code` | Anthropic | `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-sonnet-5`, `claude-fable-5`                                                   | `claude-opus-4-8` |
| `opencode`    | Baseten   | `kimi-k2.7-code`                                                                                                              | `kimi-k2.7-code`  |

The selectable lists above are derived from `MODEL_REGISTRY` and
`SESSION_START_MODEL_IDS_BY_BACKEND`.
`gpt-5.3-codex-spark` requires Codex subscription auth (BYOS) and is an
internal probe model.
Other registry models, such as `gpt-5.4-nano`, remain backend-scoped but are
not directly selectable as primary session-start models.
`gpt-5.4-mini` is directly selectable and is also used by sidecar paths such as
memory context selection.

Before changing model support, verify model ID, provider, context window, pricing, and reasoning/adaptive-thinking support against current provider docs. Do not infer support from model family, SDK defaults, or announcements. Add reasoning config only when provider docs explicitly confirm support; if docs are unclear, classify the model as no-reasoning, cite the source in the PR or nearby test/comment, and cover UI/API rejection plus sandbox-bridge Codex option handling.

## Control Plane Selection

Session create accepts `agentRuntimeBackend`, but the UI does not send it. `apps/ui/src/api/sessions.ts` sends only the model; `apps/control-plane-worker/src/routes/sessions.ts` derives the backend from the requested model with `getAgentRuntimeBackendForModel(...)`. With no model requested, the backend stays `codex`.

The route validates:

- explicit backend values against `isAgentRuntimeBackend(...)`;
- requested start models against `isSessionStartModelAllowedForBackend(...)`;
- the resolved model against `isModelAllowedForBackend(...)`;
- reasoning effort only when the selected model exposes reasoning config.
  For Claude Code, `none` omits the SDK `effort` option.
  Opus 4.8 accepts `low`/`medium`/`high`/`xhigh`/`max`.
  Sonnet 4.6 accepts `low`/`medium`/`high`/`max`.
  Fable 5 accepts `low`/`medium`/`high`/`xhigh`/`max`; Cycloid intentionally excludes `none` so Fable sessions choose an explicit effort.

Webhook starts use `resolveBaseModelForAutomaticRouting` in `apps/control-plane-worker/src/services/session-model-routing.ts`: derive the backend from the saved default model when present, else `codex`. Slack channel automation uses the automation owner's default model via `resolveAutomationOwnerDefaultModel` in `slack-channel-service.ts`. Scheduled automations use the backend default.

## Model Selection

No prompt-based or cost-optimized routing.
Model selection is the explicit model (UI picker, `--model`, or the user's `default_model`) when provided, else the backend default (`gpt-5.4` for codex, `claude-opus-4-8` for claude_code).
Adding Fable 5 does not change the Claude Code default.
This applies identically to both backends and to interactive and webhook starts.
Automation starts vary: Slack channel automations use the automation owner's default model; scheduled automations use the backend default.

Automatic Zeus PR reviews cross-route known Codex authors to the Claude Code
session-start default when a runnable Anthropic credential is available, and
known Claude Code authors to the Codex default. External or otherwise unknown
PR authors retain the Codex fallback.

Child sessions inherit the parent session's `agent_runtime_backend` (null legacy rows resolve to `codex` via `resolveAgentRuntimeBackend`). Verification sessions inherit the parent implementation session's backend/model only when the parent backend/model pair is known and valid and the verifier owner can start that backend. Codex parents verify on Codex, Claude parents verify on Claude Code, and OpenCode parents verify on OpenCode; missing/unknown/invalid parent context or unavailable credentials fall back to the Codex default.

## Credentials, BYOK, and BYOS

The selected model determines the required provider credential during sandbox spawn:

- `codex` requires OpenAI auth.
- `claude_code` requires Anthropic auth.
- `opencode` requires Baseten auth.

Credential resolution lives in `apps/control-plane-worker/src/integrations/runtime.ts`; sandbox env assembly and fail-closed checks live in `apps/control-plane-worker/src/session/durable-object.ts`.

OpenAI has two gateway-backed paths:

- customer BYOK resolves to an `arc-gw-*` OpenAI gateway session token, with `ARCANIST_OPENAI_GATEWAY_ENABLED=1` and `ARCANIST_OPENAI_GATEWAY_CREDENTIAL_SOURCE`;
- managed Cycloid virtual keys resolve to `arc-vk-*`, also with `ARCANIST_OPENAI_GATEWAY_ENABLED=1`.

The Codex bridge turns those into `openai_base_url = <CONTROL_PLANE_URL>/openai` in its runtime config. Gateway traffic is metered through `apps/control-plane-worker/src/openai-gateway/*`.

Automation sessions (`initiation_mode: "automation"`) use the OpenAI `flex` service tier for lower-cost background processing; the gateway applies `service_tier: "flex"` automatically.

Anthropic uses a raw `ANTHROPIC_API_KEY` in the sandbox child environment.
No Anthropic gateway or Cycloid-managed virtual-key metering path.
The Claude event translator uses the Anthropic SDK result's `total_cost_usd` for per-prompt usage when available.
Claude Fable 5 requires Anthropic's 30-day data-retention path and is unavailable for zero-data-retention Anthropic organizations.

Local development fallbacks differ:

- OpenAI local fallback can use `OPENAI_API_KEY`, `OPENAI_API_KEY_INTERNAL_REVIEW`, or `ARCANIST_OPENAI_API_KEY`.
- Anthropic local fallback can use `ARCANIST_ANTHROPIC_API_KEY`, but production `claude_code` does not fall back to the platform key.

Hard-fail behavior:

- platform-scoped `ARCANIST_OPENAI_API_KEY`, `OPENAI_API_KEY_INTERNAL_REVIEW`, and `ARCANIST_ANTHROPIC_API_KEY` are rejected if they reach sandbox env assembly;
- `claude_code` spawn throws `sandbox_auth_failure: no Anthropic credential for claude_code backend` when no `ANTHROPIC_API_KEY` is present after credential resolution;
- Codex bridge startup throws `No OpenAI API key configured for Codex runtime` when neither an OpenAI key nor stored Codex auth exists.

Customer-facing exposure also differs. OpenAI remains visible as the default provider even without a direct API key; when Codex subscription auth is enabled with a valid credential, the OpenAI provider group reports `hasApiKey: true`. Anthropic is an API-key integration, but `shared/constants/integrations.ts` marks it `customerFacing: false`; bootstrap only exposes non-default providers when a key resolves. Baseten is user-scoped BYOK only; no business-scoped Baseten key is resolved for opencode.

## Bridge Runtime

All three backends implement `AgentRuntimeAdapter` in `apps/sandbox-bridge/src/agent/agent-runtime-adapter.ts`; `apps/sandbox-bridge/src/agent/agent-runtime-registry.ts` selects the adapter from `ARCANIST_AGENT_RUNTIME_BACKEND`.
Each `PromptRequest` carries a required neutral `turnMode: "plan" | "execute"` intent derived from the agent profile.
Adapters map that intent to backend-native enforcement; bridge code must not thread harness-specific policy vocabulary above the adapter boundary.

Codex runtime:

- starts `codex app-server` through `apps/sandbox-bridge/src/services/codex-server.ts`;
- uses the Codex app-server protocol (`thread/start`, `thread/resume`, `turn/start`, event subscribe, abort);
- maps `PromptRequest.turnMode` to `turn/start.sandboxPolicy` inside the Codex adapter: plan turns use read-only/no-network, execute turns send `dangerFullAccess` to reset Codex's sticky per-turn policy;
- still declares `planTurnReadOnly` as a gap until first-party MCP dynamic tools have a pre-execution plan-mode gate;
- writes managed runtime config under `$CODEX_HOME`;
- syncs `$CODEX_HOME/sessions/` through the shared rollout transport;
- supports bridge-registered first-party dynamic tools.

Claude Code runtime:

- uses `@anthropic-ai/claude-agent-sdk` in streaming-input mode through `apps/sandbox-bridge/src/services/claude-session.ts`;
- opens one persistent SDK `query()` per session and demultiplexes messages per turn;
- enforces plan-turn read-only through the SDK `canUseTool` gate and fails closed in the adapter if `PromptRequest.turnMode` diverges from the agent profile that gate reads;
- runs verification v2 phases as sequential prompts through that same persistent query, matching Codex session continuity;
- pins or resumes the SDK session id;
- syncs `~/.claude/projects` transcripts through the same rollout transport;
- exposes bridge-registered first-party dynamic tools through the SDK MCP server `cycloid_first_party_dynamic_tools`.

OpenCode runtime:

- starts the SDK server through `apps/sandbox-bridge/src/services/opencode-session.ts`;
- sets the built-in plan agent's config-level `edit` permission to `deny` while non-plan agents keep headless `ask` permissions;
- continues to auto-answer `bash` and `webfetch` permission prompts through the bridge safety gate for plan and execute turns.

Tool safety is backend-specific but contract-equivalent:

- Codex tool calls are mediated through the Codex app-server event path and bridge safety handling.
- Claude Code uses the SDK `canUseTool` gate in-process, including the same review-loop worktree boundary.
- OpenCode denies plan-agent edits at config load and routes remaining permission prompts through the same safety gate.
- Plan-turn read-only support is tracked in `BACKEND_CAPABILITIES.planTurnReadOnly`; unsupported backends must declare the gap explicitly.

MCP handling differs:

- Codex projects bridge MCP config into Codex `mcp_servers` TOML and preserves only referenced trusted integration env vars.
- Claude Code loads the repo's committed `.mcp.json` plus the bridge-registered `cycloid_first_party_dynamic_tools` SDK MCP server, rejects platform-secret env references, and runs every MCP tool through `canUseTool`.

Prompt-start timeout is adapter-owned. Codex and opencode use the normal timeout; Claude Code uses a longer timeout as a fallback in case warmup did not complete.

## Event Translation

The bridge emits the same durable event contract to the control plane for both backends: `token`, `reasoning`, `tool_call`, `tool_update`, `question`, `usage`, `error`, `session_idle`, `prompt_result`, `estimated_input_composition`, `raw_agent_runtime`, and related session/progress events.

Codex event input:

- native event names include `message.part.updated`, `message.updated`, `session.status`, `session.idle`, `session.error`, `question.asked`, and `memory.recall.telemetry`;
- tool ids come from Codex part ids / call ids and are canonicalized in the Codex translator;
- usage is accumulated from Codex message updates and normalized by the shared prompt-usage pipeline;
- unknown event or part shapes are emitted as `raw_agent_runtime` and logged under Codex-specific raw-fallback fields.

Claude Code event input:

- SDK messages include `system`, `stream_event`, `assistant`, `user`, and `result`;
- text and thinking deltas come from `stream_event`;
- tool calls are emitted from assembled `assistant` snapshots because they carry complete input;
- tool results arrive on `user` messages;
- terminal `result` messages emit usage and prompt completion/error;
- unknown message or block shapes are emitted as `raw_agent_runtime` and logged under Claude-specific raw-fallback fields.

Claude usage mapping is intentionally different from Codex. Anthropic `input_tokens` already excludes cached tokens, cache read/write tokens are emitted separately, and `total_cost_usd` from the SDK is authoritative when present.

## Prompts And Guidance

Codex receives Cycloid behavioral guidance through managed session-static instructions written under `$CODEX_HOME` and loaded by Codex as global instructions. When first-party dynamic tools are available, Codex guidance includes a dynamic-tool section and the available tool names.

Claude Code receives the same durable guidance through the SDK `systemPrompt` append on the `claude_code` preset. Repo instructions are appended from the effective project doc. Per-turn volatile Cycloid context is delivered inside the user message as an `<cycloid-system-context>` block because the SDK system prompt is fixed when the query opens.

Claude Code intentionally calls `buildSessionStaticBehavioralGuidance()` without dynamic-tool names in the session-static system prompt. The backend exposes Cycloid first-party dynamic tools through `cycloid_first_party_dynamic_tools`, and the matching dynamic-tool guidance is appended to each prompt's per-turn user context so Claude's cached system prefix stays stable.

## Identical Across Backends

Shared regardless of backend (all three implement the adapter):

- session ownership, repo authorization, GitHub installation gating, clone token generation, and repo checkout;
- sandbox provider selection and lifecycle (`ARCANIST_RUNTIME_BACKEND`);
- session Durable Object(s) state machine, prompt queueing, WebSocket/SSE projection, replay/export, and terminal status handling;
- `SESSION_CONFIG`, model/provider env metadata, repo/runtime env injection, telemetry broker env, and sandbox auth token flow;
- repo instructions and agent profile selection rules;
- state-rollout upload/download transport, with backend-specific state subdirectories;
- verification v2 phase orchestration, artifacts, terminal verdict parsing, managed-comment updates, and review-loop handoff;
- post-execution commit/publish orchestration outside the model protocol;
- prompt usage persistence once a backend emits normalized `usage`;
- raw-fallback observability for unhandled backend events.
