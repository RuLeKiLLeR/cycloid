# Review-Loop Done-Detection — PR2: Frontend Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a breathing/steady ReviewLoopIndicator (list dot + detail badge) driven by the reviewLoopDoneState threaded from PR1.

**Architecture:** Thread reviewLoopDoneState through the UI session DTOs, add a ReviewLoopIndicator component with a CSS breathing animation, mount it in the session list and detail header, and update the open session row live via patchSession. Depends on PR1 (the shared reviewLoopDoneState field).

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects, D1 (raw prepared statements), Vitest. Spec: `docs/superpowers/specs/2026-06-08-review-loop-done-detection-design.md`.

## Conventions (read once)

- **Tests** are NOT colocated. Control-plane unit/integration tests: `tests/test_cloudflare/` (D1 via in-memory better-sqlite3 `SqliteD1`); UI tests: `tests/test_ui/`, rendered via `renderToStaticMarkup` from `react-dom/server` (no `@testing-library/react` installed — do not import it).
- **Run a test:** `npx vitest run <path>` from the repo root (e.g. `npx vitest run tests/test_cloudflare/review-loop-rollup.test.ts`).
- **Typecheck:** `npm run -w @cycloid/control-plane-worker typecheck`.
- **After adding a D1 migration:** run `npx vitest run tests/test_cloudflare/migration-integrity.test.ts` and commit the updated `migration-integrity.test.ts`.
- **Git:** if a worker runs in an isolated worktree it must NOT run git; the orchestrator performs every commit shown in the Step "Commit" blocks.
- Line anchors (`path:NN`) are approximate — confirm against the live file before editing.

---

### Task 1: UI types — add `reviewLoopDoneState` to `SessionMetadata`

**Files:**

- Modify: `apps/ui/src/types.ts:9` (import line) and `apps/ui/src/types.ts:55` (after `cronSnapshot` in `SessionMetadata`)

The import to extend (types.ts:9):

```ts
import type { FinalizingStep, Phase, SandboxSubstate, StopMode } from "../../../shared/session/phase.js";
```

The `SessionMetadata` tail to insert next to (types.ts:53-56):

```ts
  scheduledRuleId?: string | null;
  ruleNameSnapshot?: string | null;
  cronSnapshot?: string | null;
};
```

- [ ] **Step 1: Add `ReviewLoopDoneState` to the phase import**

Replace the import at `apps/ui/src/types.ts:9`:

```ts
import type {
  FinalizingStep,
  Phase,
  ReviewLoopDoneState,
  SandboxSubstate,
  StopMode,
} from "../../../shared/session/phase.js";
```

- [ ] **Step 2: Add the field to `SessionMetadata`**

Insert `reviewLoopDoneState` immediately after `cronSnapshot?: string | null;` (last field before the closing `};` at types.ts:55); `SessionDetail` (types.ts:61, `SessionMetadata & {...}`) inherits it:

```ts
  scheduledRuleId?: string | null;
  ruleNameSnapshot?: string | null;
  cronSnapshot?: string | null;
  // Review-loop done-state badge/dot signal (null = no claim, render nothing).
  reviewLoopDoneState?: ReviewLoopDoneState | null;
};
```

- [ ] **Step 3: Typecheck the package**

Run (from `apps/ui`): `npm run typecheck`
Expected: PASS (no `TS2339`/unused-import errors). `ReviewLoopDoneState` must resolve from `shared/session/phase.ts` — this fails if the `export type ReviewLoopDoneState` contract is not yet present there; land that first.

- [ ] **Step 4: Commit**

```bash
git add apps/ui/src/types.ts && git commit -m "feat(ui): thread reviewLoopDoneState through SessionMetadata"
```

---

### Task 2: UI API — carry `reviewLoopDoneState` in list normalize + detail mapper

**Files:**

- Modify: `apps/ui/src/api/sessions.ts:47-52` (`normalizeSessionMetadata` — confirm spread carries it) and `apps/ui/src/api/sessions.ts:224-228` (`fetchSessionView` explicit allowlist tail)

**Context (read for real):**

- `normalizeSessionMetadata` (sessions.ts:47-52) returns `{ ...session, phase: ... }`. `RawSessionMetadata` (sessions.ts:27) = `Omit<SessionMetadata, "phase"> & {...}`, so once `SessionMetadata` gains `reviewLoopDoneState` (prior task), the field flows through the `...session` spread **automatically** — confirm by inspection; no edit.
- `fetchSessionView` (sessions.ts:193-228) builds `SessionDetail` with an **explicit allowlist** (does NOT spread `vm`), so the field is dropped unless added. Tail anchor (sessions.ts:224-228):

```ts
    initiationMode: vm.initiationMode ?? "user",
    scheduledRuleId: vm.scheduledRuleId ?? null,
    ruleNameSnapshot: vm.ruleNameSnapshot ?? null,
    cronSnapshot: vm.cronSnapshot ?? null,
  };
```

- [ ] **Step 1: Add the explicit mapping line in `fetchSessionView`**

Edit the allowlist tail at `apps/ui/src/api/sessions.ts:224-228` — add `reviewLoopDoneState` after `cronSnapshot`:

```ts
    initiationMode: vm.initiationMode ?? "user",
    scheduledRuleId: vm.scheduledRuleId ?? null,
    ruleNameSnapshot: vm.ruleNameSnapshot ?? null,
    cronSnapshot: vm.cronSnapshot ?? null,
    reviewLoopDoneState: vm.reviewLoopDoneState ?? null,
  };
```

(No edit to `normalizeSessionMetadata` at sessions.ts:47-52 — the `...session` spread already carries `reviewLoopDoneState` once `SessionMetadata` declares it.)

- [ ] **Step 2: Typecheck the package**

Run (from `apps/ui`): `npm run typecheck`
Expected: PASS — proves `vm.reviewLoopDoneState` resolves on `SessionViewModel` (must be in `shared/types/session-view.ts` per CONTRACTS) and `SessionDetail` accepts the field (prior task). `TS2339` on `vm.reviewLoopDoneState` means the producer/shared-DTO `SessionViewModel.reviewLoopDoneState` field is missing — land it first.

- [ ] **Step 3: Run the UI test suite (no regression)**

Run (from `apps/ui`): `npm run test`
Expected: PASS (existing suites `utils/status-display.test.ts`, `hooks/useThemeSync.test.ts`, `hooks/session-state/reducer.test.ts` unaffected). No dedicated `sessions.test.ts` mapper test; behavior coverage lives in Cluster H's `ReviewLoopIndicator` component test.

- [ ] **Step 4: Commit**

```bash
git add apps/ui/src/api/sessions.ts && git commit -m "feat(ui): map reviewLoopDoneState in fetchSessionView allowlist"
```

---

Anchors verified against the actual files:

- `apps/ui/src/types.ts:9` import; `SessionMetadata` type alias at `types.ts:19`, tail `cronSnapshot` at `types.ts:55`, closing `};` at `types.ts:56`; `SessionDetail = SessionMetadata & {...}` at `types.ts:61` (inherits).
- `apps/ui/src/api/sessions.ts`: `RawSessionMetadata` at `:27`, `normalizeSessionMetadata` at `:47-52` (spread carries field, no edit), `fetchSessionView` allowlist tail at `:224-228`.
- `SessionViewModel` is in `shared/types/session-view.ts:32-81`; `vm.reviewLoopDoneState` depends on that producer cluster adding the field.
- UI vitest command (`apps/ui/package.json:9`): `"test": "vitest run"` → run `npm run test` (targeted `npx vitest run <path>`); typecheck `npm run typecheck` (`tsc --noEmit`).

---

### Task 3: ReviewLoopIndicator component

**Files:**

- Create: `apps/ui/src/components/ReviewLoopIndicator.tsx`
- Create (test): `tests/test_ui/review-loop-indicator.test.tsx`
- Dependency: imports `ReviewLoopDoneState` from `apps/ui/src/../../../../shared/session/phase.js` (the type added by the shared-contract PR; see NOTE above)

- [ ] **Step 1: Write the failing test**

Harness copied verbatim from `tests/test_ui/markdown-content.test.tsx:1-3` (`renderToStaticMarkup` + `createElement`, plain vitest — no React Testing Library in this repo).

```tsx
// tests/test_ui/review-loop-indicator.test.tsx
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReviewLoopIndicator } from "../../apps/ui/src/components/ReviewLoopIndicator";

describe("ReviewLoopIndicator null/absent", () => {
  it("renders nothing for a null state (dot variant)", () => {
    const html = renderToStaticMarkup(createElement(ReviewLoopIndicator, { variant: "dot", state: null }));
    expect(html).toBe("");
  });

  it("renders nothing for a null state (badge variant)", () => {
    const html = renderToStaticMarkup(createElement(ReviewLoopIndicator, { variant: "badge", state: null }));
    expect(html).toBe("");
  });
});

describe("ReviewLoopIndicator dot variant", () => {
  it("breathes and labels itself for the working state", () => {
    const html = renderToStaticMarkup(createElement(ReviewLoopIndicator, { variant: "dot", state: "working" }));
    expect(html).toContain("review-loop-breathe");
    expect(html).toContain('aria-label="Review loop: listening"');
    expect(html).toContain('title="Review loop: listening"');
    expect(html).toContain("bg-accent");
  });

  it("is steady green and labeled for done_green", () => {
    const html = renderToStaticMarkup(createElement(ReviewLoopIndicator, { variant: "dot", state: "done_green" }));
    expect(html).not.toContain("review-loop-breathe");
    expect(html).toContain('aria-label="Review loop: caught up"');
    expect(html).toContain('title="Review loop: caught up"');
    expect(html).toContain("bg-success");
  });

  it("is steady amber and labeled for done_exhausted", () => {
    const html = renderToStaticMarkup(createElement(ReviewLoopIndicator, { variant: "dot", state: "done_exhausted" }));
    expect(html).not.toContain("review-loop-breathe");
    expect(html).toContain('aria-label="Review loop: caught up · CI not green — did all it could"');
    expect(html).toContain("bg-warning");
  });
});

describe("ReviewLoopIndicator badge variant", () => {
  it("shows the listening copy and breathes for working", () => {
    const html = renderToStaticMarkup(createElement(ReviewLoopIndicator, { variant: "badge", state: "working" }));
    expect(html).toContain("Listening…");
    expect(html).toContain("review-loop-breathe");
  });

  it("shows the caught-up copy for done_green and does not breathe", () => {
    const html = renderToStaticMarkup(createElement(ReviewLoopIndicator, { variant: "badge", state: "done_green" }));
    expect(html).toContain("Review loop: caught up");
    expect(html).not.toContain("review-loop-breathe");
    expect(html).toContain("bg-success");
  });

  it("shows the CI-not-green copy for done_exhausted", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewLoopIndicator, { variant: "badge", state: "done_exhausted" }),
    );
    expect(html).toContain("Review loop: caught up · CI not green — did all it could");
    expect(html).toContain("bg-warning");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/test_ui/review-loop-indicator.test.tsx`
Expected: FAIL with `Failed to resolve import "../../apps/ui/src/components/ReviewLoopIndicator"` (the component file does not exist yet).

- [ ] **Step 3: Implement the component**

Color/animation classes use real codebase utilities: `bg-accent`/`bg-success`/`bg-warning` from `@theme` color vars `--color-accent`/`--color-success`/`--color-warning` (`App.css:45,52,56`); `review-loop-breathe` added in the App.css task below; working dot mirrors the `bg-accent ... rounded-full` precedent (`constants.ts:17`) and the `animate-pulse` precedent (`SessionDetail.tsx:564`).

```tsx
// apps/ui/src/components/ReviewLoopIndicator.tsx
import type { ReviewLoopDoneState } from "../../../../shared/session/phase.js";

export interface ReviewLoopIndicatorProps {
  variant: "dot" | "badge";
  state: ReviewLoopDoneState | null;
}

// Per-state presentation. `working` breathes (animation: see App.css
// .review-loop-breathe). `done_green`/`done_exhausted` are steady. `null`
// renders nothing (no claim).
interface StatePresentation {
  /** Tailwind color utility from the @theme palette (App.css). */
  color: string;
  /** Whether the breathing animation is applied (working only). */
  breathing: boolean;
  /** Accessible label / native tooltip for the dot variant. */
  label: string;
  /** Visible badge copy. */
  badgeCopy: string;
}

const PRESENTATION: Record<ReviewLoopDoneState, StatePresentation> = {
  working: {
    color: "bg-accent",
    breathing: true,
    label: "Review loop: listening",
    badgeCopy: "Listening…",
  },
  done_green: {
    color: "bg-success",
    breathing: false,
    label: "Review loop: caught up",
    badgeCopy: "Review loop: caught up",
  },
  done_exhausted: {
    color: "bg-warning",
    breathing: false,
    label: "Review loop: caught up · CI not green — did all it could",
    badgeCopy: "Review loop: caught up · CI not green — did all it could",
  },
};

export function ReviewLoopIndicator({ variant, state }: ReviewLoopIndicatorProps) {
  if (state === null) {
    return null;
  }
  const p = PRESENTATION[state];
  const motion = p.breathing ? " review-loop-breathe" : "";

  if (variant === "dot") {
    return (
      <span
        role="img"
        aria-label={p.label}
        title={p.label}
        className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${p.color}${motion}`}
      />
    );
  }

  // badge variant
  const badgeTone =
    state === "done_exhausted"
      ? "border-warning-soft-border bg-warning-soft text-warning"
      : state === "done_green"
        ? "border-success-soft-border bg-success-soft text-success"
        : "border-accent-soft-border bg-accent-soft text-accent";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${badgeTone}`}
    >
      <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${p.color}${motion}`} />
      {p.badgeCopy}
    </span>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/test_ui/review-loop-indicator.test.tsx`
Expected: PASS (all 9 tests green).

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/components/ReviewLoopIndicator.tsx tests/test_ui/review-loop-indicator.test.tsx && git commit -m "feat(ui): ReviewLoopIndicator dot/badge component"
```

---

### Task 4: review-loop-breathe animation in App.css

**Files:**

- Modify: `apps/ui/src/App.css:492-504` (insert immediately after the existing `.status-dot-pulse` rule + `@keyframes status-pulse` block; the contract requires this be distinct from `status-pulse`, in active use via `constants.ts:14`)

No Vitest assertion for raw CSS keyframes in this repo; CSS-only change. Behavioral guard exists — `review-loop-indicator.test.tsx` asserts `review-loop-breathe` applied for `working` and absent otherwise. Verify the CSS by build + visual check.

- [ ] **Step 1: Confirm the anchor before editing**

The new rules go right after this existing block (`App.css:492-504`):

```css
.status-dot-pulse {
  animation: status-pulse 2s ease-in-out infinite;
}

@keyframes status-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
```

- [ ] **Step 2: Add the breathing keyframe, utility class, and scoped reduced-motion fallback**

Insert immediately after `App.css:504` (closing `}` of `@keyframes status-pulse`). Opacity+glow over ~2s with `var(--ease-editorial)` (`App.css:72`); the keyframe drives `box-shadow` via `currentColor` so the glow follows the dot color set by the component's `bg-accent`/`bg-success`/`bg-warning` (`--color-success`/`--color-warning` at `App.css:52,56`). The scoped `prefers-reduced-motion` override pins the dot to its steady end-state even though the global reset at `App.css:557-566` already caps animation duration.

```css
/* Review-loop "breathing" pulse — distinct from status-pulse. Used by the
   ReviewLoopIndicator working state: a slow opacity + glow swell that reads
   as "listening" without the harder blink of status-pulse. The glow follows
   the dot's own color via currentColor, so bg-success/bg-warning/bg-accent
   all tint correctly. */
.review-loop-breathe {
  animation: review-loop-breathe 2s var(--ease-editorial) infinite;
}

@keyframes review-loop-breathe {
  0%,
  100% {
    opacity: 1;
    box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 45%, transparent);
  }
  50% {
    opacity: 0.55;
    box-shadow: 0 0 6px 2px color-mix(in srgb, currentColor 35%, transparent);
  }
}

/* Scoped reduced-motion fallback: hold the steady end-state, no swell/glow.
   The global reset (prefers-reduced-motion) already caps duration; this makes
   the resting appearance explicit and glow-free. */
@media (prefers-reduced-motion: reduce) {
  .review-loop-breathe {
    animation: none;
    opacity: 1;
    box-shadow: none;
  }
}
```

- [ ] **Step 3: Verify the component test still passes (the class is referenced, not duplicated)**

Run: `npx vitest run tests/test_ui/review-loop-indicator.test.tsx`
Expected: PASS — component emits `review-loop-breathe` only for `working`; the CSS above gives that class its animation.

- [ ] **Step 4: Verify the UI build compiles the CSS**

Run: `npm run build:ui`
Expected: PASS — Tailwind/Vite compiles `App.css` with the new keyframe and utility class.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/App.css && git commit -m "feat(ui): review-loop-breathe keyframe + reduced-motion fallback"
```

---

### Task 5: List — mount ReviewLoopIndicator dot in SessionCard status row

**Files:**

- Modify: `apps/ui/src/components/SessionList.tsx:159-169` (the status-label `<span>` inside the status row that begins at `apps/ui/src/components/SessionList.tsx:132`)
- Modify: `apps/ui/src/components/SessionList.tsx:1` (import)

The status row is the `<div className="mt-1 flex items-center gap-1.5 ...">` at line 132. The listening label is the status `<span>` at lines 159-169 rendering `{statusLabel}`. `display` at line 60 is `flattenStatus(session.phase)`; `review_listening` flattens to `"review_listening"` (status-display.ts:27-28). Gate on `session.phase === "review_listening"` for exactness (the dot is a liveness signal tied to the canonical phase, not the flattened bucket).

- [ ] **Step 1: Manual verification only (no component-render harness in this package)**
      No `@testing-library/react` in `apps/ui`; existing tests (`status-display.test.ts`, `reducer.test.ts`) are pure-logic/hook tests under `happy-dom`, no JSX render. Render assertion for this mount is Cluster H's (`ReviewLoopIndicator.test.tsx`). Manual check: `npm run dev:full`, open a session in `review_listening` phase, confirm a breathing/steady dot in the sidebar row next to the "review listening" label.

- [ ] **Step 2: Add the import**
      Anchor — current line 1:

```ts
import { Fragment } from "react";
```

Insert the indicator import after the existing local-component/util imports. Add directly below line 8 (`import { flattenStatus, STATUS_DISPLAY_LABEL } from "../utils/status-display";`):

```ts
import { ReviewLoopIndicator } from "./ReviewLoopIndicator";
```

- [ ] **Step 3: Mount the dot next to the status label**
      Anchor — the status label span at lines 159-169:

```tsx
<span
  className={`uppercase tracking-wider shrink-0 ${
    display === "working"
      ? "text-warning"
      : display === "waiting_for_input"
        ? "text-text-primary font-medium"
        : "text-text-muted"
  }`}
>
  {statusLabel}
</span>
```

Insert the gated indicator immediately AFTER that closing `</span>` (i.e. between line 169 and the `{/* Right rail ... */}` comment at line 170), so it sits inline in the status row, before the `ml-auto` right rail:

```tsx
{
  session.phase === "review_listening" && (
    <ReviewLoopIndicator variant="dot" state={session.reviewLoopDoneState ?? null} />
  );
}
```

- [ ] **Step 4: Typecheck the package**
      Run: `cd apps/ui && npx tsc --noEmit`
      Expected: PASS (requires Cluster H's `ReviewLoopIndicator.tsx` and the shared-DTO `reviewLoopDoneState` field; if not landed, expect `Cannot find module './ReviewLoopIndicator'` / `Property 'reviewLoopDoneState' does not exist` — documented cross-cluster dependency, not a defect in this edit).

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/components/SessionList.tsx && git commit -m "feat(ui): mount review-loop dot in SessionCard status row"
```

---

### Task 6: Detail — mount ReviewLoopIndicator badge in SessionHeader controls

**Files:**

- Modify: `apps/ui/src/components/SessionHeader.tsx:173` (the controls flex container `<div className="flex items-center gap-3 shrink-0">`)
- Modify: `apps/ui/src/components/SessionHeader.tsx:1-8` (import)

The controls flex container is `<div className="flex items-center gap-3 shrink-0">` at line 173; children: Scheduled-run pill (174-187), benchmark pills (188-197), Stop button / stop-confirm group (202-232). The badge mounts as a sibling inside this container, gated on `session.phase === "review_listening"`. `session` is typed `SessionDetail` (props at SessionHeader.tsx:11), which inherits `reviewLoopDoneState` from `SessionMetadata`.

- [ ] **Step 1: Manual verification only (no component-render harness in this package)**
      Same constraint as the list task. Manual check: `npm run dev:full`, open a session detail page where `phase === "review_listening"`, confirm a steady/breathing badge in the header controls row alongside the Scheduled/Stop pills, with the contract copy ("Review loop: caught up", etc.). Render assertion for the badge variant is Cluster H's `ReviewLoopIndicator.test.tsx`.

- [ ] **Step 2: Add the import**
      Anchor — current imports, lines 1-8:

```ts
import { useState } from "react";

import { isStopAvailable } from "../../../../shared/session/eligibility";
import { TERMINAL_CHILD_STATUSES } from "../../../../shared/types/child-session";
import type { ChildSessionSummary } from "../api/sessions";
import { fetchChildSessions } from "../api/sessions";
import { useSyncEffect } from "../hooks/useEffects";
import type { SessionDetail } from "../types";
```

Insert the indicator import after line 6 (`import { fetchChildSessions } from "../api/sessions";`):

```ts
import { ReviewLoopIndicator } from "./ReviewLoopIndicator";
```

- [ ] **Step 3: Mount the badge as the first child of the controls flex container**
      Anchor — the controls container opening tag and its first child, lines 173-174:

```tsx
          <div className="flex items-center gap-3 shrink-0">
            {session.initiationMode === "automation" && (
```

Insert the gated badge as the FIRST child, immediately after the `<div className="flex items-center gap-3 shrink-0">` opening tag at line 173 (between line 173 and the `{session.initiationMode === "automation" && (` at line 174):

```tsx
{
  session.phase === "review_listening" && (
    <ReviewLoopIndicator variant="badge" state={session.reviewLoopDoneState ?? null} />
  );
}
```

- [ ] **Step 4: Typecheck the package**
      Run: `cd apps/ui && npx tsc --noEmit`
      Expected: PASS (same cross-cluster dependency on Cluster H's `ReviewLoopIndicator.tsx` and the shared `reviewLoopDoneState` field as the list task).

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/components/SessionHeader.tsx && git commit -m "feat(ui): mount review-loop badge in SessionHeader controls"
```

---

### Task 7: Liveness — mirror reviewLoopDoneState into sidebar via patchSession on open session

**Files:**

- Modify: `apps/ui/src/components/SessionDetail.tsx:261-264` (the existing `useSyncEffect` that mirrors the open session's status into the sidebar `SessionMetadata` cache)

The open session's snapshot (including `reviewLoopDoneState`) lands in `session` (a `SessionDetail`) via `useSessionState` / `useSessionReplay`; the snapshot handler in `useSessionReplay.ts` (cases `subscribed` at line 202, `session_status` at line 301) drives `session` through `dispatchSessionState`. The component already re-mirrors `session` into the sidebar's `SessionMetadata` map via the `patchSession` effect at SessionDetail.tsx:261-264. Adding `reviewLoopDoneState` to that `patchSession` call (and the dep array) makes the OPEN session's sidebar row update live; per spec §6, all OTHER rows update on the next refetch. No new effect or WS handler — the field rides the existing mirror.

- [ ] **Step 1: Verify there is no pure-function seam to unit-test (manual verification path)**
      The mirror lives inside a `useSyncEffect` closure (not an extractable pure function) and `apps/ui` has no `@testing-library/react` to drive the effect — verified by behavior, not a unit test. Manual check: `npm run dev:full`, open a `review_listening` session; when the control-plane broadcasts a `reviewLoopDoneState` transition (e.g. `working` -> `done_green`), confirm BOTH the detail badge AND the open session's sidebar dot update without navigating away. Confirm a second, non-open `review_listening` row does NOT update until a sidebar refetch.

- [ ] **Step 2: Read the current mirror effect to confirm the exact anchor**
      Anchor — SessionDetail.tsx:261-264 (verbatim):

```tsx
useSyncEffect(() => {
  if (!session) return;
  patchSession(session.sessionId, { phase: session.phase, prUrl: session.prUrl });
}, [session?.sessionId, session?.phase, session?.prUrl, patchSession]);
```

- [ ] **Step 3: Extend the patchSession call and dep array with reviewLoopDoneState**
      Replace the effect at SessionDetail.tsx:261-264 with:

```tsx
useSyncEffect(() => {
  if (!session) return;
  patchSession(session.sessionId, {
    phase: session.phase,
    prUrl: session.prUrl,
    reviewLoopDoneState: session.reviewLoopDoneState ?? null,
  });
}, [session?.sessionId, session?.phase, session?.prUrl, session?.reviewLoopDoneState, patchSession]);
```

- [ ] **Step 4: Typecheck the package**
      Run: `cd apps/ui && npx tsc --noEmit`
      Expected: PASS (requires the shared-DTO `reviewLoopDoneState` field on `SessionMetadata`/`SessionDetail` at apps/ui/src/types.ts:19,61 and on the `SessionDetail` snapshot mapping in `useSessionReplay`/`session-state`; if not landed, expect `Property 'reviewLoopDoneState' does not exist on type 'SessionDetail'` and `... 'Partial<SessionMetadata>'` — documented cross-cluster dependency).

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/components/SessionDetail.tsx && git commit -m "feat(ui): mirror reviewLoopDoneState into sidebar for open session"
```

---

Anchors cited (all read this session):

- `apps/ui/src/components/SessionList.tsx`: import block ends at line 8; `display`/`statusLabel` at lines 60-62; status row `<div className="mt-1 flex items-center gap-1.5 ...">` at line 132; status-label `<span>{statusLabel}</span>` at lines 159-169; right-rail comment at line 170.
- `apps/ui/src/components/SessionHeader.tsx`: props (`session: SessionDetail`) at lines 10-18; controls flex container `<div className="flex items-center gap-3 shrink-0">` at line 173; Scheduled pill at 174-187; Stop button at 202-211; stop-confirm group at 212-232.
- `apps/ui/src/components/Layout.tsx`: `patchSession` defined at lines 133-135 (`setSessions((prev) => prev.map((s) => (s.sessionId === sessionId ? { ...s, ...patch } : s)))`), exposed on `LayoutContext` (type at line 93), callers at lines 754, 765.
- `apps/ui/src/components/SessionDetail.tsx`: `patchSession` pulled from `useLayoutContext()` at line 98; the sidebar-mirror `useSyncEffect` at lines 261-264.
- `apps/ui/src/hooks/useSessionWebSocket.ts`: hook only manages the socket; the snapshot-to-state consumer is `useSessionReplay.ts` (`onMessage: handleWsMessage` at line 397; `subscribed` case at 202, `session_status` case at 301), feeding `session`. The liveness wire belongs in SessionDetail's `patchSession` mirror (SessionDetail.tsx:261-264), NOT in the WS hook.
- `apps/ui/src/utils/status-display.ts:27-28`: `review_listening` flattens to `"review_listening"`.
- `apps/ui/src/types.ts:19,61`: `SessionMetadata` / `SessionDetail = SessionMetadata & {...}` — `reviewLoopDoneState` (added by shared-DTO cluster) inherits into `SessionDetail`.

Cross-cluster dependencies (will not typecheck until landed): `apps/ui/src/components/ReviewLoopIndicator.tsx` (Cluster H); `reviewLoopDoneState` on `SessionMetadata` + the `SessionDetail` snapshot mapping (shared-DTO cluster). UI test command: `npx vitest run <path>` from `apps/ui/` (env `happy-dom`); no `@testing-library/react`, so component mounts are manually verified and rely on Cluster H's `ReviewLoopIndicator.test.tsx` for render coverage.
