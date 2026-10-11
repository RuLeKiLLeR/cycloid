# Onboarding Agent Authors Custom Sandbox Layers (ARC-1286) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the onboarding agent so it conditionally authors + validates a repo-local sandbox-layer template (`.cycloid/sandbox.yaml` + `.cycloid/sandbox.layer.Dockerfile`) when the repo needs a toolchain the base sandbox lacks, and hands the post-merge build off to a human admin in its PR report.

**Architecture:** Pure prompt-layer change in the bridge. A new self-contained `buildSandboxLayerGuidance()` returns a markdown section (Task 1, unwired); it is then spliced into the existing `buildOnboardingAgentGuidance()` onboarding playbook and surfaced as a conditional deliverable (Task 2); docs follow (Task 3). No control-plane, CLI, resolver, or parser changes — the `cycloid` CLI is already in-sandbox and `sandbox init`/`validate` are offline.

**Tech Stack:** TypeScript, Vitest. Files live in `apps/sandbox-bridge/src/constants/bridge.ts` and `tests/test_agent/constants.test.ts`. Graphite for the stacked PRs.

## Global Constraints

Copied verbatim from the spec; every task implicitly includes these.

- Layer Dockerfile supports **only `RUN` and `ENV`** — `FROM`, `COPY`, `ADD`, `ARG` are rejected (Cycloid owns the base image).
- `sandbox.yaml` `smoke.commands` are **arg-arrays**, e.g. `["bash","-lc","command -v go"]`, never shell strings.
- Author a sandbox layer **only when the base sandbox lacks the needed toolchain**; otherwise author nothing and record "base template sufficient".
- In-session verification = `cycloid sandbox validate` (static) **then** apply the layer's `RUN`/`ENV` commands live + re-attempt boot; static-only fallback with an explicit caveat if live apply fails.
- The build is **admin-only and post-merge**: `cycloid sandbox build <owner/repo> --ref main --wait --follow`; promotion happens only off default-branch HEAD. The onboarding session must NOT build.
- Scope: prompt layer + tests + docs **only**. No CLI/control-plane/resolver changes. Auto-build-on-merge is an explicit follow-up, out of scope.
- Every commit message ends with the trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Graphite stack layout

The design spec is already committed at the base of the worktree branch (`docs/superpowers/specs/2026-06-22-onboarding-sandbox-layer-design.md`). Stack the three implementation PRs on top, each its own branch:

| Task        | Branch                                       | Stacked on | PR                                       |
| ----------- | -------------------------------------------- | ---------- | ---------------------------------------- |
| Spec (done) | `worktree-arc-1286-onboarding-sandbox-layer` | `main`     | base                                     |
| 1           | `arc-1286-sandbox-layer-guidance`            | spec base  | content fn + unit test                   |
| 2           | `arc-1286-sandbox-layer-wire-in`             | Task 1     | wire-in + deliverable + integration test |
| 3           | `arc-1286-sandbox-layer-docs`                | Task 2     | docs                                     |

Each task's commit step creates its stacked branch with `gt create <branch> -m "<message>"` (after `git add`). Submit the whole stack at the end with `gt submit --stack` (do not push/submit until the user asks).

> Historical note: this was a plan-local instruction, not current Graphite policy. For fresh stacks, follow [docs/graphite.md](../../graphite.md) and submit each branch as it is ready so per-PR review automation starts progressively.

---

### Task 1: `buildSandboxLayerGuidance()` content builder (PR 1)

A standalone exported function returning the sandbox-layer markdown section, pinned by unit tests. Not yet wired into the playbook, so the assembled onboarding context is unchanged — this PR ships no live behavior and is reviewable purely as content. The function is consumed by its unit test in this PR (so it is not an unused export) and by the playbook in Task 2.

**Files:**

- Modify: `apps/sandbox-bridge/src/constants/bridge.ts` (add `buildSandboxLayerGuidance` immediately after `buildOnboardingAgentGuidance`, i.e. after line 516)
- Test: `tests/test_agent/constants.test.ts` (add import on line 9–10; add a new `describe` block after line 553)

**Interfaces:**

- Produces: `export function buildSandboxLayerGuidance(): string` — returns a markdown section beginning `## Custom sandbox layer (only when the base sandbox lacks a toolchain)`. Task 2 consumes it.

- [ ] **Step 1: Write the failing test**

Add `buildSandboxLayerGuidance,` to the import block in `tests/test_agent/constants.test.ts` (alphabetically, right after `buildPrWorkflowGuidanceBullets,` on line 10 — it sorts before that; place it after `buildOnboardingAgentGuidance,` on line 9):

```ts
  buildOnboardingAgentGuidance,
  buildSandboxLayerGuidance,
  buildPrWorkflowGuidanceBullets,
```

Then add this new top-level `describe` block immediately after the closing `});` of the existing `describe("buildOnboardingAgentGuidance", …)` block (after line 553):

```ts
describe("buildSandboxLayerGuidance (ARC-1286)", () => {
  const guidance = buildSandboxLayerGuidance();

  it("gates authoring on a missing toolchain and records the no-op case", () => {
    expect(guidance).toContain("## Custom sandbox layer (only when the base sandbox lacks a toolchain)");
    expect(guidance).toContain("Author a custom sandbox layer ONLY when");
    expect(guidance).toContain("Go, Swift, Rust, Java, .NET, Ruby");
    expect(guidance).toContain("command not found");
    expect(guidance).toContain("command -v <tool>");
    expect(guidance).toContain('author NO sandbox-layer files and record "base template sufficient"');
  });

  it("teaches the init -> edit -> validate flow with the RUN/ENV-only constraint", () => {
    expect(guidance).toContain("cycloid sandbox init");
    expect(guidance).toContain("`RUN`/`ENV` instructions ONLY");
    expect(guidance).toContain("`FROM`, `COPY`, `ADD`, and `ARG` are rejected");
    expect(guidance).toContain('["bash","-lc","command -v go"]');
    expect(guidance).toContain("cycloid sandbox validate");
  });

  it("requires live apply + boot verification with a static-only fallback", () => {
    expect(guidance).toContain("apply the layer's own `RUN`/`ENV` commands live in this disposable sandbox");
    expect(guidance).toContain("fall back to static validation only");
  });

  it("hands the admin post-merge build off in the report and never builds in-session", () => {
    expect(guidance).toContain("`cycloid sandbox build` needs admin auth");
    expect(guidance).toContain("cycloid sandbox build <owner/repo> --ref main --wait --follow");
    expect(guidance).toContain("an unbuilt layer falls back safely");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/test_agent/constants.test.ts`
Expected: FAIL — `buildSandboxLayerGuidance` is not exported from `bridge.ts` (import resolves to `undefined`; calling it throws `TypeError: buildSandboxLayerGuidance is not a function`).

- [ ] **Step 3: Write the minimal implementation**

In `apps/sandbox-bridge/src/constants/bridge.ts`, immediately after the closing `}` of `buildOnboardingAgentGuidance` (line 516, before the `// File protection:` comment on line 518), add:

```ts
// Custom sandbox-layer guidance for the onboarding agent (ARC-1286). Returned
// as a standalone section and spliced into buildOnboardingAgentGuidance(). The
// base E2B template (apps/sandbox-e2b/template.ts) ships Node/Python/Postgres/
// Docker/gh/bun but no extra language toolchains; per-repo layers add them
// (docs/sandbox-templates.md). The `cycloid` CLI is in-sandbox and `sandbox
// init`/`validate` are offline, so the agent authors + statically checks the
// layer in-session; the build is admin-only and post-merge.
export function buildSandboxLayerGuidance(): string {
  return `## Custom sandbox layer (only when the base sandbox lacks a toolchain)
The base sandbox already includes Node, Python, Postgres, Docker, gh, and bun (non-exhaustive). Author a custom sandbox layer ONLY when the app needs a language toolchain or system package the base lacks — Go, Swift, Rust, Java, .NET, Ruby, and similar. Detect this empirically: a \`command not found\` during the build/boot attempt or a failing \`command -v <tool>\` is authoritative; language manifests (\`go.mod\`, \`Package.swift\`, \`Cargo.toml\`, \`pom.xml\`, \`*.csproj\`) corroborate. If the base already has everything the boot needs, author NO sandbox-layer files and record "base template sufficient" in your report.

When a toolchain IS missing:
- Run \`cycloid sandbox init\` to scaffold \`.cycloid/sandbox.yaml\` and \`.cycloid/sandbox.layer.Dockerfile\`.
- Edit \`.cycloid/sandbox.layer.Dockerfile\` to install the missing toolchain with \`RUN\`/\`ENV\` instructions ONLY — \`FROM\`, \`COPY\`, \`ADD\`, and \`ARG\` are rejected because Cycloid owns the base image and startup path.
- Set \`.cycloid/sandbox.yaml\` \`smoke.commands\` to assert each tool you added, as arg arrays — e.g. \`["bash","-lc","command -v go"]\` — so the post-merge build verifies the toolchain.

Verify the layer in-session before publishing:
- Run \`cycloid sandbox validate\`: a static check of the manifest and Dockerfile (no network, no build). Fix every reported issue.
- Then apply the layer's own \`RUN\`/\`ENV\` commands live in this disposable sandbox to prove they install, and re-attempt the app boot/verify with the toolchain present. If the live apply fails, fall back to static validation only and say so prominently in your report.

This session and its PR cannot build the template: \`cycloid sandbox build\` needs admin auth, the files must already be on the default branch, and promotion happens only off default-branch HEAD. Include \`.cycloid/sandbox.yaml\` and \`.cycloid/sandbox.layer.Dockerfile\` in this PR, and in your final report give the exact post-merge handoff for a business admin to run after merge:
\`cycloid sandbox build <owner/repo> --ref main --wait --follow\`
Until that build runs, sessions keep using the base template — an unbuilt layer falls back safely — so authoring the files now is non-disruptive.`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/test_agent/constants.test.ts`
Expected: PASS (all four new `it` cases plus the existing `buildOnboardingAgentGuidance` cases green).

- [ ] **Step 5: Typecheck**

Run: `npm run -w @cycloid/sandbox-bridge typecheck && npx tsc --noEmit`
Expected: no errors (bridge workspace + root test tsconfig).

- [ ] **Step 6: Commit on a stacked Graphite branch**

```bash
git add apps/sandbox-bridge/src/constants/bridge.ts tests/test_agent/constants.test.ts
gt create arc-1286-sandbox-layer-guidance -m "feat(onboarding): add custom sandbox-layer guidance builder (ARC-1286)

Standalone buildSandboxLayerGuidance() section + unit tests; not yet wired
into the onboarding playbook (no behavior change).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Wire the section into the onboarding playbook (PR 2)

Splice `buildSandboxLayerGuidance()` into `buildOnboardingAgentGuidance()` and add a conditional deliverable bullet, turning the behavior on. Add an integration assertion and confirm the prompt-golden suite stays green.

**Files:**

- Modify: `apps/sandbox-bridge/src/constants/bridge.ts` (Deliverables list ~line 443; splice section after Boot-chain hygiene ~line 503)
- Test: `tests/test_agent/constants.test.ts` (add one `it` inside the existing `describe("buildOnboardingAgentGuidance", …)` block)

**Interfaces:**

- Consumes: `buildSandboxLayerGuidance()` from Task 1.
- Produces: `buildOnboardingAgentGuidance()` output now contains the `## Custom sandbox layer …` section and the conditional `.cycloid/sandbox.*` deliverable bullet.

- [ ] **Step 1: Write the failing integration test**

In `tests/test_agent/constants.test.ts`, inside the existing `describe("buildOnboardingAgentGuidance", () => { const guidance = buildOnboardingAgentGuidance(); … })` block (reusing its `guidance` const), add this `it` after the last existing case in that block:

```ts
it("splices the custom sandbox-layer section and conditional deliverable (ARC-1286)", () => {
  expect(guidance).toContain("## Custom sandbox layer (only when the base sandbox lacks a toolchain)");
  expect(guidance).toContain(
    "`.cycloid/sandbox.yaml` + `.cycloid/sandbox.layer.Dockerfile` — ONLY when the app needs a toolchain the base sandbox lacks",
  );
  expect(guidance).toContain("cycloid sandbox build <owner/repo> --ref main --wait --follow");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/test_agent/constants.test.ts -t "splices the custom sandbox-layer section"`
Expected: FAIL — the assembled onboarding guidance does not yet contain the section or the deliverable bullet.

- [ ] **Step 3: Add the conditional deliverable bullet**

In `apps/sandbox-bridge/src/constants/bridge.ts`, in the `## Deliverables` list of `buildOnboardingAgentGuidance`, replace the `CYCLOID.md` bullet (line 443):

Find:

```
- \`CYCLOID.md\` — repo instructions for future Cycloid sessions (recipe below).
```

Replace with:

```
- \`CYCLOID.md\` — repo instructions for future Cycloid sessions (recipe below).
- \`.cycloid/sandbox.yaml\` + \`.cycloid/sandbox.layer.Dockerfile\` — ONLY when the app needs a toolchain the base sandbox lacks (see Custom sandbox layer below); otherwise omit.
```

- [ ] **Step 4: Splice the section after Boot-chain hygiene**

In the same function, find the end of the `## Boot-chain hygiene` section followed by `## Self-test the verify gate` (around lines 503–505):

Find:

```
- Stub unreachable external services explicitly at the integration seam — a client left retry-looping forever is not a stub — and name every stub in the report.

## Self-test the verify gate
```

Replace with:

```
- Stub unreachable external services explicitly at the integration seam — a client left retry-looping forever is not a stub — and name every stub in the report.

${buildSandboxLayerGuidance()}

## Self-test the verify gate
```

(The `${buildSandboxLayerGuidance()}` interpolation sits inside the existing backtick template literal of `buildOnboardingAgentGuidance`.)

- [ ] **Step 5: Run the integration + full constants suite**

Run: `npx vitest run tests/test_agent/constants.test.ts`
Expected: PASS — the new integration case and all existing cases green.

- [ ] **Step 6: Confirm the prompt-golden suite is unaffected**

The onboarding profile is not pinned in `tests/test_sandbox-bridge/prompt-golden/` (verified: no `onboard` refs there), so this should pass unchanged.

Run: `npx vitest run tests/test_sandbox-bridge/prompt-golden`
Expected: PASS, no golden diff. If — unexpectedly — a golden changes, that means the onboarding context IS pinned; regenerate intentionally with `UPDATE_PROMPT_GOLDENS=1 npx vitest run tests/test_sandbox-bridge/prompt-golden`, re-run to confirm green, and stage the updated `.golden.txt`.

- [ ] **Step 7: Typecheck**

Run: `npm run -w @cycloid/sandbox-bridge typecheck && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit on a stacked Graphite branch**

```bash
git add apps/sandbox-bridge/src/constants/bridge.ts tests/test_agent/constants.test.ts
gt create arc-1286-sandbox-layer-wire-in -m "feat(onboarding): author sandbox layers when base lacks a toolchain (ARC-1286)

Splice buildSandboxLayerGuidance() into the onboarding playbook and add the
conditional .cycloid/sandbox.* deliverable. Build remains a manual post-merge
admin step surfaced in the PR report.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Documentation (PR 3)

Record that onboarding now authors sandbox layers conditionally, with a manual post-merge admin build and auto-build noted as a follow-up. Token-efficient per repo doc conventions.

**Files:**

- Modify: `docs/prompt-agents.md` (insert a subsection in the `## Onboarding agent` section, before `### R1–R4 completeness ladder` on line 62)
- Modify: `docs/sandbox-templates.md` (insert a section before `## Supported Layer Instructions` on line 74)

**Interfaces:** none (docs only).

- [ ] **Step 1: Add the prompt-agents.md subsection**

In `docs/prompt-agents.md`, find:

```
### R1–R4 completeness ladder
```

Replace with:

```
### Custom sandbox layers

When the app needs a language toolchain the base sandbox lacks (Go, Swift, Rust, etc.), the onboarding agent also runs `cycloid sandbox init`, edits `.cycloid/sandbox.layer.Dockerfile` (`RUN`/`ENV` only), and statically validates it with `cycloid sandbox validate` — all in-session — and includes the files in the setup PR. It skips this when the base template already suffices. The layer is not built during onboarding: building needs admin auth and the files on the default branch, so the PR report hands off the post-merge `cycloid sandbox build <owner/repo> --ref main --wait --follow` for a business admin to run after merge. See [sandbox-templates.md](sandbox-templates.md). Auto-build-on-merge is a follow-up.

### R1–R4 completeness ladder
```

- [ ] **Step 2: Add the sandbox-templates.md section**

In `docs/sandbox-templates.md`, find:

```
## Supported Layer Instructions
```

Replace with:

```
## Onboarding Integration

The onboarding agent authors `.cycloid/sandbox.yaml` + `.cycloid/sandbox.layer.Dockerfile` automatically when a repo needs a toolchain the base sandbox lacks, validating them in-session with `cycloid sandbox validate` and including them in the setup PR (see [prompt-agents.md](prompt-agents.md#onboarding-agent)). It does not build the template — `cycloid sandbox build` needs admin auth and the files on the default branch — so an admin runs the build after merge. Auto-build-on-merge is not yet implemented.

## Supported Layer Instructions
```

- [ ] **Step 3: Verify the docs render and links resolve**

Run: `npm run format:check -- docs/prompt-agents.md docs/sandbox-templates.md`
Expected: PASS (prettier-clean). Eyeball that the two new headings sit correctly and the relative links (`sandbox-templates.md`, `prompt-agents.md#onboarding-agent`) point at existing files/anchors.

- [ ] **Step 4: Commit on a stacked Graphite branch**

```bash
git add docs/prompt-agents.md docs/sandbox-templates.md
gt create arc-1286-sandbox-layer-docs -m "docs: note onboarding authors sandbox layers (ARC-1286)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4 (manual, pre-merge): E2E verification — a Cycloid session

Per [docs/testing.md](../../testing.md#e2e-means-a-cycloid-session) and the spec, the unit tests are necessary but not sufficient. Before merging the stack, run one real onboarding Cycloid session and confirm the agent behaves. This is not a code change — do not skip it, and do not claim the feature works on unit tests alone.

- [ ] **Step 1: Start an onboarding session against a repo needing a base-absent toolchain**

Use a repo whose stack needs e.g. Go (absent from the base template). Start an onboarding CLI session (`cycloid sessions create … --onboarding`) per the onboarding flow.

- [ ] **Step 2: Confirm the pass bar from the spec**

- The agent detects the missing toolchain and runs `cycloid sandbox init` + edits `.cycloid/sandbox.layer.Dockerfile` with valid `RUN`/`ENV` installs and matching `smoke.commands`.
- `cycloid sandbox validate` passes in-session; the install commands are applied live and boot/verify is re-attempted with the toolchain present (or an explicit, accurate static-only fallback is reported).
- The draft PR contains `.cycloid/sandbox.*` and the PR Summary includes the post-merge `cycloid sandbox build … --ref main` admin handoff.

- [ ] **Step 3: Confirm the negative case**

A repo that needs nothing extra authors no sandbox-layer files and records "base template sufficient".

- [ ] **Step 4: Submit the stack** (only after the user approves)

> Historical note: this was a plan-local instruction, not current Graphite policy. For fresh stacks, follow [docs/graphite.md](../../graphite.md) and submit each branch as it is ready so per-PR review automation starts progressively.

```bash
gt submit --stack
```

---

## Self-Review

**Spec coverage:**

- Conditional authoring (only when base lacks a toolchain) → Task 1 content + Task 2 deliverable; negative case in Task 4 Step 3. ✓
- init → edit (RUN/ENV-only) → validate flow → Task 1 content. ✓
- Validate + apply-live + boot, static-only fallback → Task 1 content; Task 4 Step 2. ✓
- Manual post-merge admin build in the report, `--ref main`, default-branch-HEAD promotion → Task 1 content; Task 4 Step 2. ✓
- 3-PR Graphite stack → stack-layout table + per-task `gt create` steps. ✓
- Docs (prompt-agents.md, sandbox-templates.md), auto-build noted as follow-up → Task 3. ✓
- Verification: unit per-PR + one Cycloid session → Tasks 1–2 tests, Task 4. ✓
- Out of scope (auto-build, assignment, parser/resolver changes) → no task touches them; noted in Global Constraints. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full content; commands have expected output. ✓

**Type consistency:** `buildSandboxLayerGuidance` named identically in Task 1 (definition + import + test) and Task 2 (interpolation). The Task 2 integration-test substring "`…the base sandbox lacks`" is a prefix of the Task 2 deliverable bullet text, so it matches. The Task 1 assertion strings are exact substrings of the Task 1 function body (e.g. ``"`RUN`/`ENV` instructions ONLY"``, `'["bash","-lc","command -v go"]'`, `"an unbuilt layer falls back safely"`). ✓

## Execution Handoff

After saving this plan, the executor picks an approach (subagent-driven recommended). Tasks 1–3 are TDD code/docs; Task 4 is a manual Cycloid-session gate before `gt submit`.
