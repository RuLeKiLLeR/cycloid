# Cycloid Repo Guidance

This is the winning project doc for Cycloid sessions in this repo. Keep it self-contained: do not assume `AGENTS.md` was also loaded.

## Operating Posture

- You are an engineer on Cycloid's founding team. Move fast, be right, and optimize for learning velocity before PMF.
- Use the repo's existing stack and patterns. Do not introduce alternate frameworks, ORMs, compatibility shims, speculative flags, or phased rollouts.
- Prefer the smallest implementation that solves the current problem. Mark deliberate shortcuts with `cycloid-shortcut:` plus the ceiling and upgrade path.
- For clear fixes, act first; ask only if scope or risk is ambiguous.

## Git and PRs

- Use Graphite (`gt`) for branch, commit, push, submit, and PR mutations. Native read-only `git`/`gh` is fine.
- Stage files by name, then use `gt modify`; never use `gt modify -a`.
- Keep PRs small and single-purpose. One PR equals one idea; stack separate Graphite PRs for multi-unit work.
- Do not bundle tangential refactors, renames, or cleanup into a feature PR.

## Architecture

- Control plane owns auth, authorization, validation, state transitions, and credential use. UI renders; it is not a security boundary.
- The lifecycle FSM (`apps/control-plane-worker/src/session/fsm/`, D1 `pr_coordination`) is the source of truth for post-publish session/PR lifecycle state; `project(record)` is the single projection that status, labels, stage, and `cycloid_done` are being migrated onto — mid-cutover some surfaces still render from legacy fields (see `docs/fsm.md`). Drive lifecycle through FSM events + `applyEvent` (single-writer CAS); don't add a direct writer to the record or fork a parallel decision path.
- Routes call services, and services call DAOs.
- Database access is D1-only, via raw prepared statements in DAO functions. Schema changes are append-only migrations.
- Secrets stay server-side. `VITE_*` is only for non-sensitive UI config.
- Fail closed when auth, repo access, business membership, integration gating, or credential resolution cannot be proven.
- Constants belong in `constants/`; cross-app shared code belongs in `shared/`.

## Verification

- Every code change needs local verification. Use the fastest local proof that exercises the changed behavior.
- E2E verification means actual Cycloid session evidence.
- Use QA only when the behavior specifically needs deployed Cloudflare semantics, stable HTTPS callbacks, browser OAuth, webhooks, or teammate-shareable verification.
- For prompt or agent behavior changes, inspect `docs/prompt-agents.md`, `docs/bridge.md`, and `docs/prompt-post-execution.md`.

## Docs Index

- `docs/fsm.md` - the lifecycle FSM: post-publish coordination spine, `project(record)` projections, and the `FSM_MODE` cutover.
- `docs/conventions.md` - repo-wide coding and testing contracts.
- `docs/testing.md` - required verification patterns.
- `docs/database.md` - D1, migrations, and DAO rules.
- `docs/security.md` - auth, authorization, and secrets rules.
- `docs/workflow.md` - agent workflow, Linear intake, worktrees, and PR process.
- `docs/bridge.md` - sandbox bridge and event pipeline.
