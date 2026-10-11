# App Conventions

Compact repo-wide contract for common coding tasks. Read the routed docs before changing specialized areas.

## Route deeper

- Auth, routes, webhooks, secrets, file-path safety, bearer-token allowlists: [docs/security.md](security.md)
- DB, DAO, D1, and migrations: [docs/database.md](database.md)
- Tests, check commands, mocks, and runtime testing: [docs/testing.md](testing.md)
- Agent runtime/model support: [docs/agent-runtime-backends.md](agent-runtime-backends.md)
- Session replay and exports: [docs/bridge.md](bridge.md)
- Projection write ownership and `SessionDO` side-effect idempotency: [apps/control-plane-worker/README.md](../apps/control-plane-worker/README.md)
- Post-publish PR/review lifecycle state and `project()` projections: [docs/fsm.md](fsm.md)
- Authenticated UI and app design: [DESIGN.md](../DESIGN.md)

## Core principles

- Least code that solves the problem. Fix root causes; do not ship temporary patches.
- No backward-compatibility shims unless a specific deploy constraint requires one; when removing a path, update all call sites and delete the old export.
- Apply YAGNI. Do not add speculative features, config, abstractions, schema/API surface, flags, TODO scaffolding, or hooks for likely future work.
- Read the relevant source of truth before broad exploration. Never modify a file you have not read in the current prompt.
- Shorten feedback loops: prove the riskiest assumption with the fastest local test, script, harness, fixture, or instrumentation. Do not force destructive, customer-visible, production-load, or cost-amplifying conditions without approval.
- Verify facts and commands before relying on them. Check repo code/docs first, then current provider docs or local dependency source.
- Decisions ride on evidence, not speculation. See [docs/workflow.md](workflow.md#evidence-backed-decisions).
- Never patch symptoms downstream when data is lost upstream. Trace the value to the first bad handoff and fix it there.
- Keep docs token-efficient: short rules, no repeated rationale, examples only when needed.

## Ownership

- Code is organized by app under `apps/`; shared cross-app code belongs in `shared/`.
- Routes call services; services call DAOs. Routes must not call DAO functions directly.
- `utils/` is for pure helpers only. Side effects, orchestration, logging, and external I/O belong in `services/`.
- Constants belong in app-local `constants/` files. Enums and `as const` discriminants belong in dedicated `enums/` files.
- If multiple apps need the same type, selector, or constant, move it to `shared/`. Do not mirror exports.
- Prefer existing abstractions and registries over duplicating domain knowledge. When a parsing or normalization helper exists, every call site handling that input type must use it.
- Control plane owns authorization, validation, state transitions, aggregation, and credentials. UI owns ephemeral view state and display formatting.

For team ownership expectations (owning the outcome, not the task), see [docs/ownership.md](ownership.md).

## Reuse before writing helpers

Before adding a helper, search this canonical index and import the existing primitive when it fits:

- Error stringify: `shared/utils/errors.ts`.
- D1 row changed: `apps/control-plane-worker/src/db/errors.ts`.
- D1 upsert: `apps/control-plane-worker/src/db-helpers.ts`.
- Sleep: `shared/utils/timing.ts`.
- Backoff formulas: app-local `utils/backoff.ts`.
- Type guards: `shared/utils/type-guards.ts`.
- Dynamic-tool input helpers: `apps/sandbox-bridge/src/utils/dynamic-tool-helpers.ts`.
- Dynamic-tool errors/results: `apps/sandbox-bridge/src/services/dynamic-tool-results.ts`.
- Dynamic-tool image validation: `apps/sandbox-bridge/src/services/dynamic-tool-image-results.ts`.
- GitHub request errors: `apps/control-plane-worker/src/github/errors.ts`.
- OAuth integration token row reads: `apps/control-plane-worker/src/integrations/db.ts` (`readOAuthTokenRow`).
- Business auth-scoped loads: `apps/control-plane-worker/src/business/service.ts` (`loadBusinessForAuth`).
- Sandbox layer smoke results: `apps/control-plane-worker/src/sandbox/layer-smoke-result.ts`.
- Admin route gates: `apps/control-plane-worker/src/routes/shared.ts`.
- Webhook drop/skip lifecycle helpers: `apps/control-plane-worker/src/webhooks/shared.ts`.
- UI copy state: `apps/ui/src/hooks/useCopyToClipboard.ts`.
- UI timestamps: `apps/ui/src/utils/time.ts`.

New shared primitives go in the listed home for that domain. Do not inline a new copy next to a caller unless the existing helper has the wrong contract and the divergence is documented in code or tests.

## Security

- Never commit secrets, tokens, webhook signing keys, or environment files.
- Webhook routes use signature verification, not user auth tokens.
- Use prepared statements for D1 queries. Do not interpolate SQL or shell commands from untrusted input.
- For repo-relative paths, use `path.relative(repoRoot, filePath)`, reject empty/`..`/`..${sep}`/absolute results, and run commands with `cwd: repoRoot`.
- Treat uploaded files, third-party text, and prompt attachments as untrusted input. Validate or sanitize before execution or rendering.
- Do not expose stack traces, raw DB errors, or filesystem details in API responses.
- For internal-only feature gates, use the canonical helpers and exception rules in [docs/feature-gating.md](feature-gating.md).

## Routes and auth

The router (`apps/control-plane-worker/src/router.ts`) enforces auth before dispatch: browser session cookies for `authenticated`, bearer tokens for API token routes, HMAC for webhooks, and explicit public surfaces for health checks and OAuth callbacks.

Bearer-token routes are gated by handler capability and the router allowlist. `canAccessAllSessions` routes must declare `adminTokenOnly: true` and appear in `ADMIN_TOKEN_ROUTE_ALLOWLIST`; `tests/test_cloudflare/admin-token-route-allowlist.test.ts` enforces this. Update admin, CI, or CLI allowlists with the route change.

Any authenticated route that accepts a repo owner/name must verify repo access with `verifyUserRepoAccess(...)` unless the caller uses an allow-all automation token.

## Testing

- New or changed functions and endpoints need tests for reachable success, empty/missing input, invalid input, fallback, permission failure, and distinct error paths.
- Default to the fastest local proof that exercises the behavior. Use `npm run verify:changed` for small local diffs when its changed-path heuristic covers the risk; escalate to focused suites, runtime testing, or QA only when needed. Details live in [docs/testing.md](testing.md).
- When you change a literal, constant, default, user-facing message/label, or wire/event/DB shape, grep the test tree for the old value and run the affected suite (`npm run verify:changed`) before declaring done. Do not rely on CI to surface assertion mismatches you can catch locally in seconds.
- Automated tests must not call live third-party or production HTTP services. Mock external I/O and fail tests on non-local network egress.
- Changes to control flow, concurrency, defaults, or error handling must update tests in the same PR.
- If a test fails on your branch and also fails on `main`, fix it instead of marking it pre-existing.

## TypeScript and formatting

- Apps with their own `tsconfig.json` must be excluded from the root `tsconfig.json`.
- Prefer `unknown` over `any`; do not use non-null assertions on API responses.
- Required is the default; optional (`?:`) is a last resort. Every field is required unless you can name the caller that legitimately omits it AND the runtime behavior that absence triggers. "It might not always be set" is not a reason - make the caller pass it. "Convenient for now" is not a reason. If you reach for `?:`, that is a signal to stop and justify it in the diff, not a default. Prefer a required field, a required union (`string | null` where null is a real state the code branches on), or splitting into two explicit types over one type with optional members.
  - The ONLY blanket exceptions (no per-field justification needed): wire/event/DB row shapes, external API response types, and deliberate test seams such as `now?` or `logger?`. Everything else - domain models, function args, service/DAO params, internal DTOs - is required by default.
  - Do not add `?:` to make a type satisfy a partially-populated object; populate the object or model the absent case as an explicit `null` the consumer must handle.
- Derive SDK client types from SDK return types instead of inventing local wrappers.
- Keep functions focused. Extract helpers when a function grows beyond one job.
- Prettier is the canonical formatter. Keep formatter config centralized in `.prettierrc.json`.

## Model and API rules

- `MODEL_REGISTRY` in `shared/constants/models.ts` is the single source of truth for supported models.
- Verify current external facts before encoding pricing, rate limits, API behavior, SDK signatures, model capabilities, or provider limits.
- OpenAI calls that expect structured data back must use structured outputs rather than regex or ad hoc text parsing. Production code uses `queryPlatformStructuredOutput` (`services/platform-structured-output.ts`); `tests/test_shared/structured-output.test.ts` guards direct wrapper bypasses.

Session replay, export, projection writes, and `SessionDO` side-effect idempotency have stricter subsystem contracts. Read [docs/bridge.md](bridge.md) and [apps/control-plane-worker/README.md](../apps/control-plane-worker/README.md) before editing those paths.

## UI contracts

- Do not call `useEffect` directly in UI components. Use the named hooks in `apps/ui/src/hooks/useEffects.ts`.
- Do not use raw `fetch()` in UI code. Add typed functions to `apps/ui/src/api/` using `requestJson` from `api/client.ts`.
- Do not use `new WebSocket()` directly in UI code. Use `useSessionWebSocket` (`apps/ui/src/hooks/useSessionWebSocket.ts`) for per-session channels or `useSessionFeed` (`apps/ui/src/hooks/useSessionFeed.ts`) for the business-scoped sidebar feed.
- Do not cast `request.json()` directly in control-plane routes. For owned JSON object bodies, use `parseBody` from `apps/control-plane-worker/src/routes/shared.ts` with a co-located zod schema. Reserve `parseJsonBody` in `apps/control-plane-worker/src/utils.ts` for specialized parsers that cannot use `parseBody`.
- Every top-level route component needs an error boundary.
- Product copy uses sentence case: first word plus proper nouns and acronyms only; see [DESIGN.md](../DESIGN.md).
- SSE payloads do not carry a `type` field in `e.data`; attach the event type before sending them into downstream transcript logic.
- Session transcript authority is single-source, not merged. Replay is a transport/bootstrap surface; prompt history is the canonical transcript for completed prompts, and active prompts only accept prompt history when it is not older than live durable events.

## CLI entry points

- Top-level CLI scripts must catch errors and print actionable output.
- Do not hide expensive or destructive behavior behind silent default arguments.
- Before adding or changing CLI command surface, follow [docs/cli.md#adding-cli-commands](cli.md#adding-cli-commands). The CLI is agent-driven: stable JSON shapes, accurate help text, and explicit async follow/result contracts are part of the API.

## Instruction placement

Use the narrowest layer that matches the rule's scope: base prompt for cross-repo identity, repo docs for repo/domain policy, generated instruction files for runtime-derived session-static policy, per-prompt system context for prompt-local reminders, user content for task material only, and code/constants for hard enforcement.

Root repo instruction files (`AGENTS.md`, `CLAUDE.md`, `agents.md`) are shared with local Codex sessions. Keep them repo-specific and environment-agnostic. Put Cycloid-only publish flow, blocked git/gh behavior, sandbox constraints, and bridge/control-plane ownership in bridge-owned prompt layers, generated Cycloid instruction files, or [docs/workflow.md](workflow.md).

Repo skill files consumed by agent runtimes must be regular files, not symlinks. Every repo skill must exist in both `.claude/skills/<name>/SKILL.md` and `.agents/skills/<name>/SKILL.md`; update paired skills semantically in the same PR. Byte-identical content is required only for pairs or assets explicitly asserted in `tests/test_shared/skill-dual-path-sync.test.ts`.

If a rule must hold even when the model ignores instructions, enforce it in code.
