# Cost-Optimized Model Routing

> **Status: Removed.** This feature was implemented and later removed. Model selection is now explicit (UI picker or default_model setting) or falls back to the backend default.

**Date:** 2026-06-15
**Status:** Draft spec
**Author:** Codex

## Problem

Cycloid currently treats the primary session model as a single user/default
choice. Many sessions do not need the frontier model, but sending every task to
`gpt-5.5` pays the highest price even for tiny docs, copy, or bounded cleanup
tasks.

Official OpenAI pricing checked 2026-06-15:

- `gpt-5.5`: $5/M input, $0.50/M cached input, $30/M output.
- `gpt-5.4`: $2.50/M input, $0.25/M cached input, $15/M output.
- `gpt-5.4-mini`: $0.75/M input, $0.075/M cached input, $4.50/M output.

The `5.5` -> `5.4` delta is 2x, and `5.5` -> `5.4-mini` is about 6.7x, enough
to justify an opt-in easy/medium/hard router.

Sources:

- https://developers.openai.com/api/docs/pricing
- https://github.com/lm-sys/RouteLLM

## Goal

Add opt-in cost-optimized routing for Codex/OpenAI session starts:

- `easy` -> `gpt-5.4-mini`
- `medium` -> `gpt-5.4`
- `hard` -> `gpt-5.5`

Default behavior must remain unchanged: users who do not opt in continue to
start sessions on the current frontier/default model.

Routing is user-level in V0. The creating actor's setting controls automatic
routing for UI, API, Slack, and webhook-created sessions. If no settings row is
available, fail closed to `frontier_only`.

## Non-Goals

- No learned classifier in V0.
- No mid-session model switching.
- No automatic retry/escalation policy based on fuzzy success detection.
- No change to Claude Code model routing or harness behavior.
- No manual exposure of `gpt-5.4-mini` as a selectable session-start model.
- No LiteLLM/RouteLLM service dependency in V0.

## Existing Code Context

- `shared/constants/models.ts` is the model source of truth.
- `SESSION_START_MODEL_IDS_BY_BACKEND` currently exposes `gpt-5.5` and
  `gpt-5.4` for Codex session starts; `gpt-5.4-mini` exists in
  `MODEL_REGISTRY` but is intentionally internal-only.
- `apps/control-plane-worker/src/routes/sessions.ts` resolves the requested
  model/backend before calling `createSessionState`.
- `apps/control-plane-worker/src/settings/db.ts` owns `user_settings`.
- `apps/control-plane-worker/src/settings/service.ts` maps settings payloads.
- `apps/control-plane-worker/src/services/bootstrap.ts` sends settings to the UI.

## Design

### Setting

Add a user setting:

```ts
type ModelRoutingMode = "frontier_only" | "cost_optimized";
```

Persist it in `user_settings`:

```sql
ALTER TABLE user_settings
  ADD COLUMN model_routing_mode TEXT NOT NULL DEFAULT 'frontier_only';
```

Validation is fail-closed: unknown values are rejected on update and treated as
`frontier_only` when reading legacy/corrupt rows.

Expose it as `modelRoutingMode` from settings GET/PATCH and bootstrap.

### Routing Contract

Add a control-plane service, for example
`apps/control-plane-worker/src/services/model-routing.ts`:

```ts
export type ModelRoutingTier = "easy" | "medium" | "hard";
export type ModelRoutingMode = "frontier_only" | "cost_optimized";

export interface ModelRoutingInput {
  mode: ModelRoutingMode;
  prompt: string;
  repoOwner?: string | null;
  repoName?: string | null;
  source: "ui" | "api" | "slack" | "linear" | "jira" | "scheduled" | "unknown";
  agentRuntimeBackend: AgentRuntimeBackend;
  agentRole?: string | null;
  explicitModelRequested: boolean;
}

export interface ModelRoutingDecision {
  tier: ModelRoutingTier;
  model: string;
  reasons: string[];
  routerVersion: "rules-v0";
}
```

Behavior:

- If `mode === "frontier_only"`, return hard/`gpt-5.5`.
- If the user supplied an explicit model, do not route; preserve the explicit
  model. This avoids surprising users who intentionally chose `gpt-5.4`.
- If backend is not Codex/OpenAI, bypass routing and preserve existing backend
  model resolution. This is required to avoid changing Claude Code behavior.
- If the session is an incident investigation, verification agent, or
  review-loop agent session, return hard/`gpt-5.5`.
- Otherwise apply the rules below.

### V0 Rules

Hard triggers win first:

- auth, authorization, permissions, secrets, security
- database, D1, migration, schema, DAO correctness
- infra, deploy, Terraform, Datadog monitors, E2B template/runtime
- OAuth, webhook, Slack, Jira, GitHub app/integration behavior
- billing, quotas, API keys, credential resolution
- production incident/debugging, flaky production behavior
- incident investigation, verification agent work, review-loop work
- broad refactor, architecture, multi-service behavior
- explicit wording such as "hard", "complex", "debug", "investigate",
  "root cause", "race", "concurrency", "security", "migration"

Easy triggers apply only when no hard trigger matched:

- docs-only wording, typo, README, comments
- small title/summary/label generation
- simple repo Q&A or explanation with no requested code change
- obvious single-file text/config edit
- formatting/copy cleanup with narrow scope

Everything else is medium.

The easy bucket should be intentionally conservative. The product value is not
"mini handles most work"; it is "tiny work stops burning frontier output tokens."

### Session Creation Wiring

In `POST /api/sessions`:

1. Parse/validate repo and auth as today.
2. Parse requested model/backend as today.
3. Load the creating user's settings if not already available.
4. If no explicit model was supplied, call the model-routing service with the
   prompt, repo, backend, source, and agent role.
5. Use the returned model for `createSessionState`.

Do not add `gpt-5.4-mini` to `SESSION_START_MODEL_IDS_BY_BACKEND`; that list is
for user-selectable starts. The router may select any registry model runnable on
the Codex backend, so validate with `isModelAllowedForBackend`, not
`isSessionStartModelAllowedForBackend`, for routed selections.

### Durable Audit and Observability

At minimum, log:

- `model_routing.mode`
- `model_routing.tier`
- `model_routing.model`
- `model_routing.router_version`
- `model_routing.reasons`
- whether an explicit model bypassed routing

Persist the same decision metadata for auditability:

```sql
ALTER TABLE session_index ADD COLUMN model_routing_mode TEXT;
ALTER TABLE session_index ADD COLUMN model_routing_tier TEXT;
ALTER TABLE session_index ADD COLUMN model_routing_model TEXT;
ALTER TABLE session_index ADD COLUMN model_routing_router_version TEXT;
ALTER TABLE session_index ADD COLUMN model_routing_reasons_json TEXT;
ALTER TABLE session_index ADD COLUMN model_routing_bypassed_reason TEXT;
```

The selected model is already persisted on the session, but storing the routing
decision makes later cost, quality, and support audits possible without relying
on log retention. For bypasses, store `model_routing_bypassed_reason` values
such as `explicit_model`, `frontier_only`, `non_openai_backend`, or
`frontier_persona`.

## RouteLLM-Inspired Extension

RouteLLM's useful primitive is pairwise:

```text
score = P(stronger model beats weaker model for this prompt)
route strong if score >= threshold
```

For three Cycloid tiers, use two pairwise boundaries later:

```text
Boundary A: gpt-5.4-mini vs gpt-5.4
Boundary B: gpt-5.4      vs gpt-5.5
```

Future classifier flow:

```ts
if (miniVsStandard.score(input) < miniThreshold) return "easy";
if (standardVsFrontier.score(input) < frontierThreshold) return "medium";
return "hard";
```

Do not use RouteLLM's pretrained chat/router weights as production truth for
Cycloid. Coding-agent difficulty depends on repo scope, auth/integration
surface, verification requirements, ambiguity, and tool work.

Cycloid's classifier should be trained from Cycloid outcomes, not RouteLLM's
generic chat preference data:

1. V0 rule-based routing stores every decision and outcome label listed below.
2. Offline eval generation replays historical prompts across adjacent model
   pairs (`mini` vs `standard`, then `standard` vs `frontier`) using the same
   task harness where possible.
3. A small adjudicator labels whether the cheaper model was sufficient, using
   deterministic session evidence first: tests, verification result, PR review
   loop outcome, user follow-up, and manual override/rerun.
4. Train two binary pairwise classifiers on prompt metadata, repo/source
   signals, and deterministic rule features. A classifier answers "is the
   cheaper model sufficient for this task?" for one boundary.
5. Pick conservative thresholds from holdout data. Ambiguous predictions route
   to the stronger model.

Until that dataset exists, production routing stays `rules-v0`; the pairwise
classifier is a later router version, not an undeclared hidden dependency.

Useful future labels:

- selected model/tier
- prompt/source/repo metadata
- tokens/cost/runtime
- PR created
- verification passed/failed when required
- reviewer/user follow-up
- manual override or rerun

## UI

Settings UI should expose a simple opt-in:

- Off/default: "Always use best model"
- On: "Optimize model cost"

Avoid showing a complex router UI. The model picker remains for explicit
session starts; if a user chooses a model manually, that session bypasses
automatic routing.

## Testing

Unit tests:

- `frontier_only` always returns hard/`gpt-5.5`.
- explicit model bypasses routing.
- Claude/non-OpenAI backends bypass routing and preserve existing model
  resolution.
- incident investigation, verification agent, and review-loop agent sessions
  always route to hard/`gpt-5.5`.
- Codex cost-optimized easy fixtures route to `gpt-5.4-mini`.
- medium fixtures route to `gpt-5.4`.
- hard fixtures route to `gpt-5.5`.
- hard trigger wins over easy trigger.
- durable audit metadata is populated for routed and bypassed decisions.

Settings tests:

- migration default is `frontier_only`.
- settings GET/bootstrap expose default.
- PATCH accepts both valid modes.
- PATCH rejects unknown values.

Session-create tests:

- default settings still create `gpt-5.5`.
- opt-in docs/typo prompt creates `gpt-5.4-mini`.
- opt-in normal code prompt creates `gpt-5.4`.
- opt-in auth/migration/webhook prompt creates `gpt-5.5`.
- explicit `gpt-5.4` remains `gpt-5.4` even when routing is enabled.
- Claude session creation is unchanged when routing is enabled.
- Slack/webhook-created sessions honor the actor's user-level setting and
  default to `frontier_only` when no settings row exists.

Verification commands:

```bash
npx vitest run tests/test_cloudflare/settings-db.test.ts
npx vitest run tests/test_cloudflare/settings-routes.test.ts
npx vitest run tests/test_cloudflare/session-create-model-backend.test.ts
npm run lint:changed
```

## Rollout

No feature flag beyond the persisted setting is required. New and existing users
default to `frontier_only`, so rollout is inert until a user opts in.

## Resolved Decisions

1. Routing is user-level in V0.
2. Routing reasons are durable in V0 for auditability.
3. Slack and webhook-created sessions honor the actor's setting. If no settings
   row exists, default to `frontier_only`.
