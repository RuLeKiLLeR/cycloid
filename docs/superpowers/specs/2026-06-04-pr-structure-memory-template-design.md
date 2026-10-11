# PR-structure memory template — design

## Goal

Customers want PRs in their own structure; every repo/customer differs. Product flow:

1. **First session** — customer runs a task, Cycloid opens a PR with its default
   body, the customer tells Cycloid (plain language) to change the PR body to
   their structure. Cycloid applies it to the current PR immediately and saves
   the structure.
2. **Every future session** — Cycloid reads the saved structure and the publish
   path uses it to build the PR, with the **content always current**.

No per-repo template file required (though one is honored if present), and no
manual reformatting on later sessions.

## Scope split (read this — two tickets)

This document is the overall design. The work is split:

- **THIS PR (ARC-1126):** the **publish path resolves and renders a PR template in
  the correct precedence order**, adding **`.cycloid.json`** as a new explicit
  template source ahead of the existing repo-template auto-discovery. Precedence
  implemented here: `.cycloid.json` → `.github/pull_request_template.md`
  auto-discovery → built-in default. The **memory tier is a designed extension
  point but is NOT implemented here.** Rendering reuses the existing pipeline.
- **Follow-up (ARC-1124):** the **memory + `update_pr` capture side** — the
  `pr_structure` memory type, the capture flow (customer states structure →
  `update_pr` applies → saved to memory), inserting the memory tier into the
  precedence chain (between auto-discovery and default), and replacing the
  superseded `pr_body_agent_override` freeze.

Sections below are tagged with which ticket owns them.

## Background: what was tried and rejected (do not repeat)

- ARC-1122 shipped `cycloid.update_pr` (full body replace), stored as a durable
  `pr_body_agent_override` reused **verbatim** on republish (PR
  trycycloid/cycloid#4027).
- **Proven broken on QA:** the override _freezes_ the body. Once set, later
  changes don't update it, so the body goes stale and can be factually wrong
  (e.g. "docs-only, no runtime evidence" while the diff added a tested helper).
  Evidence: QA sessions `a60da08e-…` (PR #4035), `59359a32-…` (PR #4038); prod
  baseline #4037 (no override) refreshed correctly.
- Freezing the whole body = stale. Hard-coding a content function per arbitrary
  customer section = brittle. The chosen model avoids both.

## The model

- **Frozen:** the section titles / structure (the skeleton).
- **Always updatable:** the content of _every_ section, re-rendered on every
  publish. No fixed/updatable per-section tagging — all content updates.
- The skeleton lives in a template; each publish fills each section's content
  from the current session's data and writes the PR, so the body never goes stale.

## Template resolution precedence (every publish)

1. **`.cycloid.json`** — a new PR-template-path field (e.g. `pr.templatePath`)
   pointing to a template file in the repo. (`.cycloid.json` is an existing repo
   config; see `apps/control-plane-worker/src/services/repo-preview.ts:901`.)
   **[ARC-1126 / this PR]**
2. **Auto-discovered repo template** — `.github/pull_request_template.md` etc.,
   via the existing `RepoLocalPrTemplateProvider`. Company policy; current
   behavior, unchanged. **[exists today]**
3. **`pr_structure` memory** — the learned correction. Only used when no
   committed template (1 or 2) exists. **[ARC-1124 / follow-up — not this PR]**
4. **Built-in default** — current default composition. **[exists today]**

This PR (ARC-1126) implements the chain `1 → 2 → 4`; ARC-1124 inserts tier 3.

Rationale: committed templates (1, 2) are policy and win; memory (3) is purely
additive and only fills the gap for repos with no template, so it can never
override a company's `.github` template. Repos that already have a template are
untouched.

## Capture flow (first session) — [ARC-1124 / follow-up, NOT this PR]

1. Customer states the desired structure in plain language (or edits the PR body
   to demonstrate it).
2. The agent applies it to the current PR via `cycloid.update_pr` (the capture
   mechanism — `update_pr` is retained for this).
3. The structure (section titles / skeleton) is saved as a repo-scoped
   `pr_structure` memory. **Recommended:** route through Cycloid's existing
   memory-proposal/review flow (memory PRs) so it is reviewed once, not silently
   learned. Exact write path is an implementation decision (see Open questions).

## Render flow (every future session)

At publish (post-execution), resolve the template by the precedence above, then
render with the current session's content using the existing renderer
(`renderPrBodyFromTemplate` in `apps/sandbox-bridge/src/services/pr-template.ts`):

- **Fill mechanism for this PR: (i) known-content mapping.** Each section maps to
  content Cycloid already produces — summary, files changed, verification
  verdict, evidence — via the renderer's existing heading→slot aliasing
  (`SLOT_ALIASES`) and `buildCompactTemplateContent` (`pr.ts`). A section that
  maps to no known data source renders empty for now.
- Generative filling of arbitrary, no-data-source sections is **out of scope**
  (follow-up); see ARC-1124 successor / follow-up ticket.

## Code integration points

- `apps/sandbox-bridge/src/services/pr-template.ts` — `resolvePrTemplate`,
  `RepoLocalPrTemplateProvider`, `renderPrBodyFromTemplate`, `SLOT_ALIASES`,
  `PrTemplateSlot`. Add a `MemoryPrTemplateProvider` and an `.cycloid.json`
  template-path provider; compose them in the documented precedence.
- `apps/sandbox-bridge/src/services/post-execution/post-execution-runner.ts:404`
  — the current `resolvePrTemplate(new RepoLocalPrTemplateProvider(cwd))` call;
  the precedence chain plugs in here.
- `apps/sandbox-bridge/src/services/pr.ts` (~1235) — `renderPrBodyFromTemplate`
  call + `buildCompactTemplateContent` (the known-content fillers).
- `apps/control-plane-worker/src/memory/service.ts` +
  `apps/sandbox-bridge/src/services/memory-dynamic-tool.ts` — memory storage +
  recall; add the `pr_structure` memory type and the capture path.
- `.cycloid.json` — add the PR-template-path field + its parser
  (alongside existing `appRuntime`/`credentials`).
- `apps/control-plane-worker/src/session/publish-service.ts` — the
  `publishSessionResult` override branch (~824) and `applyProposedPrBody`: the
  durable verbatim `pr_body_agent_override` reuse is **superseded** by
  template-render-each-publish; remove/replace it so the body is no longer frozen.
- `apps/control-plane-worker/src/github/pr-dedup-marker.ts` — ARC-1014 dedup
  marker; preserve it through rendering.

## Invariants (must not break)

- **ARC-1014 dedup marker** (`<!-- cycloid-dedup: <sessionId>:<promptKey> -->`)
  always present — the `findOpenPr` recovery anchor.
- **Verification verdict is deterministic** — the exact control-plane/bridge
  verdict, never paraphrased.
- Repos with an existing `.github` template render exactly as today.

## Out of scope (→ follow-ups)

- **Generative filling** of arbitrary/no-data-source sections (the "big-boy"
  option). This PR uses known-content mapping (i) only.
- **Fixed/updatable per-section tagging** — explicitly not happening; all content
  is updatable.
- Full retirement of `cycloid.update_pr` body editing beyond what capture needs.

## Open implementation questions

- **Capture write path:** does the `pr_structure` memory get written directly by
  the agent/control plane on capture, or proposed for human review like other
  memories? (Recommend reviewed.)
- **`.cycloid.json` field shape:** `pr.templatePath` (string) vs a richer
  `pr` block; where the parser lives (bridge vs control plane) given the bridge
  resolves templates today.
- **Memory scope:** per-repo vs business-default + repo override.
- **Bridge vs control-plane split:** template resolution + render run in the
  bridge today; ensure the memory is fetchable there (memory recall already is).

## Verification

- Use the `verify-pr-on-qa` skill. Regression: the freeze repro (QA session
  `a60da08e-…` / PR #4035) must no longer go stale — after a follow-up change the
  body must reflect it. Baseline: prod #4037 (correct/dynamic body).
- Tests in the same PR for: precedence resolution, `MemoryPrTemplateProvider`,
  `.cycloid.json` parsing, capture → memory, render-with-known-content, dedup
  marker survival.

## Relationship to existing tickets

- **ARC-1122 / PR #4027** — the superseded full-replace approach. #4027 should not
  merge as-is; `update_pr` narrows to the capture role.
- **ARC-1124** — rescoped to this design.
