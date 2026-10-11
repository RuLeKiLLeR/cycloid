# Onboarding Agent Authors Custom Sandbox Layers (ARC-1286) — Design

Extend the onboarding agent so that, in addition to authoring `.cycloid.json` / `.cycloid/` runtime / `CYCLOID.md`, it also authors and validates a repo-local sandbox-layer template (`.cycloid/sandbox.yaml` + `.cycloid/sandbox.layer.Dockerfile`) **when, and only when, the repo's stack needs a toolchain the base sandbox lacks** — and hands off the post-merge build to a human admin in its PR report.

## Problem

A customer whose repo needs Go/Swift/Rust/etc. cannot be onboarded end-to-end today. The base E2B sandbox template (`apps/sandbox-e2b/template.ts`) ships Node 22, Python 3.12, Postgres 15, Docker, `gh`, bun, and Python/JS tooling — but not Go, Swift, Rust, Java, .NET, and other language toolchains. Injecting every language into the base image bloats startup for all sessions, so per-repo sandbox layers exist (`docs/sandbox-templates.md`): `cycloid sandbox init` scaffolds the two files, an author adds `RUN`/`ENV` installs, `cycloid sandbox validate` statically checks them, and after the files reach `main` an admin runs `cycloid sandbox build` to bake + promote the template.

The onboarding agent ([2026-06-09 design](./2026-06-09-onboarding-session-design.md)) never touches this pipeline: `buildOnboardingAgentGuidance()` (`apps/sandbox-bridge/src/constants/bridge.ts`) does not mention `sandbox.yaml`, `sandbox init`, or `sandbox validate`. So onboarding a missing-toolchain repo silently produces a config the agent cannot actually boot in-session (the toolchain is absent), and no sandbox layer is created for future sessions.

### Enabling facts (verified in code)

- **The `cycloid` CLI is in the sandbox.** Baked into the base image (`apps/sandbox-e2b/template.ts:221`, `npm install -g @trycycloid/cli`) and gated by `apps/sandbox-e2b/ready-check.sh:30` (`cycloid --version`). `cycloid sandbox init` and `cycloid sandbox validate` are fully offline — no `requireConfig`/`apiFetch` (`apps/cli/src/commands/sandbox.ts:453,490`); `validate` just runs the shared parser (`shared/sandbox-layer/parser.ts`). `cycloid`, `node`, `docker` are not on the blocked-command list (`apps/sandbox-bridge/src/constants/bridge.ts:556`); `.cycloid/sandbox.*` are not protected paths.
- **The layer Dockerfile supports only `RUN` and `ENV`** (`FROM`/`COPY`/`ADD`/`ARG` rejected — Cycloid owns the base; `shared/sandbox-layer/parser.ts:560`). Smoke commands are arg-arrays.
- **Nothing auto-builds on merge.** The GitHub `push` webhook is a no-op (`apps/control-plane-worker/src/webhooks/github.ts:3360`); the PR-merged handler does not touch sandbox layers. Building requires **business-admin** auth (`prepareSandboxLayerBuildRequest`, `apps/control-plane-worker/src/sandbox/layer-source-service.ts:162`) and only **promotes** when built against default-branch HEAD. So build is inherently post-merge and cannot happen inside the onboarding session.
- **A missing/unbuilt layer is safe.** Session template resolution (`apps/control-plane-worker/src/sandbox/layer-resolver.ts`) falls back to the base default when no usable repo-local artifact exists; it does not fail. So merging `.cycloid/sandbox.*` before any build changes nothing until an admin builds.

The gap is therefore entirely in the onboarding prompt layer. No platform/CLI/control-plane capability is missing.

## Decision

Extend the bridge-owned onboarding prompt layer to drive the agent through sandbox-layer steps 1–3 (init → edit → validate) conditionally, verify the layer in-session against the live disposable sandbox, include the files in the existing draft PR, and emit the step-5 build command for a human admin in the final report. No control-plane, CLI, or resolver changes.

Rejected alternatives: a deterministic control-plane step that runs init/validate outside the LLM (cannot make the "what toolchain is missing" judgment); a post-session hook (the files belong in the same draft PR the agent already opens); automating build-on-merge now (separate, riskier ticket — admin auth + promotion semantics + new webhook path off the no-op push handler).

### New agent behavior

Woven into the existing boot-chain / descent-gate narrative (when boot fails because a toolchain is absent from the base sandbox, the remedy is a sandbox layer rather than descending the completeness ladder):

1. **Detect** whether the app needs a toolchain the base sandbox lacks — empirically (command-not-found during the build/boot attempt; `command -v go`) and via language manifests (`go.mod`, `Package.swift`, `Cargo.toml`, `pom.xml`, `*.csproj`, …). Empirical in-sandbox detection is authoritative; the prompt carries only a short non-exhaustive "base already includes …" hint to avoid drift against `template.ts`.
2. **Author, only if something is missing:** `cycloid sandbox init`, then edit `.cycloid/sandbox.layer.Dockerfile` to add the `RUN`/`ENV` install lines (no `FROM`/`COPY`), and set `.cycloid/sandbox.yaml` `smoke.commands` to assert the new tools (e.g. `["bash","-lc","command -v go"]`). If nothing is missing, author nothing and record "base template sufficient."
3. **Verify in-session:** run `cycloid sandbox validate` (static); then run the layer's own `RUN`/`ENV` commands live in the disposable sandbox to prove they install; then re-attempt the app boot/verify with the toolchain present. If the live apply fails, fall back to static-validate-only and say so prominently in the report.
4. **Hand off:** include `.cycloid/sandbox.*` in the draft PR, and in the final report (which becomes the PR Summary) emit the exact post-merge command — `cycloid sandbox build <owner/repo> --ref main --wait --follow` — noting it must be run by a business admin after merge and that promotion happens only off default-branch HEAD.

### Components — Graphite stack of 3 small atomic PRs

1. **PR 1 — content (no behavior change).** Add a self-contained exported builder (e.g. `buildSandboxLayerGuidance()`) in `apps/sandbox-bridge/src/constants/bridge.ts` returning the section above, plus a unit test pinning its invariants: conditional "only when base lacks a toolchain", `cycloid sandbox init`/`validate` named, `RUN`/`ENV`-only constraint, smoke-command update, apply-live verification, and the `cycloid sandbox build … --ref main` admin/post-merge handoff. Not wired into the playbook yet → ships no live behavior; reviewable in isolation.
2. **PR 2 — wire-in (behavior on).** Compose the new section into the onboarding guidance (call from `buildOnboardingAgentGuidance()`, or push it as its own `cadence: "always_on"` context section at the injection point, `apps/sandbox-bridge/src/bridge.ts:3811`). Add `.cycloid/sandbox.*` as a **conditional** deliverable in the playbook's Deliverables list. Add/extend a test asserting the resolved onboarding profile now contains the sandbox-layer section. Depends on PR 1.
3. **PR 3 — docs.** Update `docs/prompt-agents.md` and `docs/sandbox-templates.md` to state onboarding now authors layers conditionally, the manual post-merge admin build step, and auto-build-on-merge as a follow-up. Token-efficient per repo doc conventions. Depends on PR 2.

## Out of scope (follow-up)

- **Auto-build-on-merge** (step 5 automation): a control-plane trigger that queues + promotes the layer build when `.cycloid/sandbox.*` changes merge to `main`. Tracked as a separate ticket.
- Admin org-default / repo-default template **assignment** from onboarding (`cycloid sandbox assign`).
- Any change to the build pipeline, resolver, or layer parser.
- Source-drift staleness detection (today only base-drift rebuild campaigns exist).

## Verification

- **Unit/integration tests in their PRs:** PR 1 — content invariants of `buildSandboxLayerGuidance()` (string assertions on the items above). PR 2 — the resolved `onboard` profile guidance includes the sandbox-layer section. Run via the repo's Vitest targets (`docs/testing.md`); no `dev:full` needed.
- **E2E — a Cycloid session** (`docs/testing.md#e2e-means-a-cycloid-session`), before merging the stack: one onboarding session against a repo that needs a base-absent toolchain (e.g. a Go repo). Pass bar:
  - Agent detects the missing toolchain and runs `cycloid sandbox init` + edits `.cycloid/sandbox.layer.Dockerfile` with valid `RUN`/`ENV` installs and matching smoke commands.
  - `cycloid sandbox validate` passes in-session; the layer's install commands are applied live and the app boot/verify is re-attempted with the toolchain present (or an explicit, accurate static-only fallback is reported).
  - The draft PR contains `.cycloid/sandbox.*` and the PR Summary includes the post-merge `cycloid sandbox build … --ref main` admin handoff.
  - A repo that needs nothing extra authors no sandbox-layer files and records "base sufficient" (negative case).

## Risks

- **Over-creation.** The agent authors a layer when the base already suffices. Mitigation: empirical detection is authoritative, conditional phrasing is explicit, and the negative E2E case guards it.
- **Live-apply cost/failure.** Installing a toolchain in-session adds time and can fail. Mitigation: it is best-effort with an honest static-only fallback; the draft PR + report stay non-fatal.
- **Prompt bloat / compaction.** Adding a section lengthens an already-large always-on guidance string. Mitigation: keep the section terse; reuse the existing always-on injection mechanism.
- **Stale base hint.** The "base already includes …" hint can drift from `template.ts`. Mitigation: phrase it as non-exhaustive and defer to empirical detection; no logic depends on it.
