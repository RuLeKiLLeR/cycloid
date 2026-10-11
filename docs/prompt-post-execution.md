# Post-execution prompts and safety interventions

LLM calls after the agent finishes, plus runtime safety interventions during execution.

## Post-execution LLM calls

Post-execution makes no platform LLM calls. The bridge post-idle path no longer runs the old verification loop: no evidence-policy evaluation, automatic screenshot/video capture, non-visual inference, or agent-authored `Verified:` claim promotion. Commit messages, PR titles, and PR bodies are deterministic (`"Apply changes"`, `resolvePrTitle`, `renderPrEvidenceCommentFromReadiness`).

Changed-file implementation publishes do not synthesize a verification verdict.
Configured `.cycloid.json` `verify.fix` commands may run before the publish commit; tracked mutations from successful fix commands are re-staged and folded into that commit.
Configured `.cycloid.json` `verify.test` commands are the read-only pre-publish gate after commit/push; failures record readiness evidence and internal draft/manual-review metadata while GitHub PRs still open ready for review.

Verification v2 phase outputs before judge are persisted through `verification_phase_artifact` events and passed to later phases. Planner, launcher, and operator phases run before the final judge. Post-execution receives only a semantic planner skip, a best-effort interpreted judge terminal result, or an `INCONCLUSIVE` result when the judge does not return a clear terminal merge-readiness verdict.

Raw phase evidence belongs under `/tmp/phase-evidence/<phase>/`. Phases can place debug logs, setup diagnostics, long command output, screenshots/videos pending selection, and intermediate evidence there without bloating the PR comment. Managed verification-comment evidence comes only from `/tmp/cycloid-evidence/`; the judge selects and copies the concise, high-signal evidence set there. `/tmp/phase-notes/` is internal debugging and handoff context only.

## PR body rendering

`apps/sandbox-bridge/src/services/pr.ts` owns generated PR body content. `apps/sandbox-bridge/src/services/pr-template.ts` owns customer PR template discovery and managed-block rendering.

- No customer template: minimal body — optional `## Failed` details for failed configured pre-publish gate commands, then `## Summary` with the agent's final summary.
- Implementation-session command attempts are not pre-publish gate evidence.
  Only configured `.cycloid.json` `verify.test` gate runs populate failed-command readiness evidence.
  Configured `.cycloid.json` `verify.fix` output is operator telemetry only; successful tracked mutations are reflected in the normal publish diff.
- Repo-local customer template: still prepend the top verdict/failed block, then render the customer template with only the agent summary inserted.
- Managed inserts use `<!-- cycloid:managed:start <slot> -->` and matching end comments; post-execution replaces those blocks in place.
- Template mode must not append the full default readiness body after the customer template.
- The lower-level template renderer can insert a verification block when a caller provides verification content; implementation PR body rendering passes an empty verification slot.
- The control plane must not add duplicate verification sections when a bridge body already contains a Cycloid-managed verification block.

Template precedence: `.cycloid.json` `pr.templatePath` → auto-discovered `.github/pull_request_template.md` (or `cycloid.md`, a single generic template under `PULL_REQUEST_TEMPLATE/`) → built-in default. Multiple generic templates are ambiguous and fall back to the full Cycloid body.

## Safety and intervention prompts

Messages surfaced to the user or injected into the agent conversation during execution:

| Prompt                                       | Trigger                                                                                           | Content                                                                                                                                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Step warning                                 | 80% of max tool calls used for agents with an explicit step cap; primary agents run without a cap | Emitted once per prompt as a warning event                                                                                                                                                                                                       |
| Context fill warning                         | 80% of context window used                                                                        | Emitted once per prompt as a warning event                                                                                                                                                                                                       |
| Configured pre-publish auto-fix              | `.cycloid.json` `verify.fix` matches changed files                                                | Runs before the publish commit. Successful tracked mutations are re-staged and folded into the commit. Non-zero exits, timeouts, or exec errors fail open; partially mutated tracked files are restored from the index before publish continues. |
| Configured pre-publish gate failure handling | `.cycloid.json` `verify.test` fails, times out, or mutates tracked files                          | Records fresh post-execution readiness evidence and internal draft/manual-review metadata; GitHub PRs still open ready for review. No automatic correction retry. Implementation-session command history is not reused as gate evidence.         |

Blocked `handled_automatically` git/gh actions are silent to the session UI (no error event); they emit structured `protection.blocked_command` and `handled_automatically.blocked` logs only. They do not abort Codex or launch correction follow-ups; repeated blocked attempts in one prompt still hit a bridge-side hard stop.
