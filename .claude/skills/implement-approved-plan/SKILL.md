---
name: implement-approved-plan
description: Use when Josiah asks Codex to implement an approved plan, especially from a file in ~/.claude/plans or a Claude/Codex planning pass. Optimized for YOLO-mode implementation with scoped edits and verification.
user_invocable: true
argument: required -- absolute path to an approved plan; use implement-plan-as-stack for the full plan as a Graphite stack with one PR per plan unit
---

# Implement Approved Plan

Codex is the implementation agent. The supplied plan is authoritative unless it conflicts with repo instructions or is technically impossible.

## Workflow

1. Read the plan completely.
2. Read the repo instructions and required docs for the touched area.
3. Identify the expected touched files.
4. Inspect the current code before editing.
5. Implement the smallest scoped change that satisfies the plan.
6. Run the narrowest meaningful verification.
7. If verification fails, debug and fix within scope.
8. If the task opened or updated PRs, complete the post-publish handoff checklist in `docs/workflow.md#branch-and-pr-hygiene` before responding.
9. Final response:
   - changed files
   - verification command and result
   - any residual risk or follow-up

## Rules

- Do not ask for approval for routine local commands, edits, or tests.
- Do not re-plan from scratch.
- Do not expand scope for opportunistic cleanup.
- Do not leave TODOs where the plan requires working behavior.
- Do not claim verification passed unless a command or product check actually ran.
