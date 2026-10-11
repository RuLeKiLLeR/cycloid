# Diagrams

- `Cycloid FSM.excalidraw` (+ PNG/SVG) — the lifecycle FSM state diagram.
- `Cycloid Architecture Diag.excalidraw` (+ PNG/SVG) — the system architecture diagram.

## Known drift: FSM diagram predates the CI-ladder cut (ARC-1330)

The checked-in FSM diagram still shows `REVIEW.caught_up → VERIFYING` as a merge gate. That edge no longer exists in code. The current model:

- The `REVIEW.caught_up` cascade is a **pure CI ladder**; `MERGE_READY` is reached on `ci_green ∧ no in-flight epoch`, independent of QA.
- QA is **off-gate**: the verifier child is spawned at publish (`SPAWN_VERIFICATION_CHILD` on `publish.pr_opened`) and runs as an out-of-band parallel child. There is **no entering `VERIFYING` edge from `REVIEW.caught_up`**; `VERIFYING` is drain-only.
- QA verdicts are advisory bookkeeping; a run-limit/infra failure is a non-blocking `notify_qa_issue` DM.

Treat [`../fsm.md`](../fsm.md) as the authoritative state model until the diagram is regenerated.
