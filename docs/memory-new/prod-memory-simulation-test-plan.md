# Prod Memory Simulation Test Plan

Goal: run 20 real local-dev Cycloid coding sessions from Slack against `trycycloid/cycloid`, using a local D1 clone of prod Cycloid memory rows, then evaluate whether repo and company memories steered the agent toward the expected decisions.

## Scope

- Environment: local dev Cycloid via Slack.
- Slack channel: `#shiv-testing`.
- Slack app: `@Cycloid (DEV)`.
- Repo: `trycycloid/cycloid`.
- Business: Cycloid prod business `295d2abc-d10b-4662-b84d-7bfa66242882`.
- Session type: implementation sessions that produce PRs.
- Memory surfaces under test:
  - company memory cloned from prod D1 `memory_facts`, `memory_takes`, provenance, pages, links, and ingestion events.
  - repo memories cloned from prod D1 `repo_memories` plus `repo_memory_judgments`.

The local clone path below has been tested. It copied 165 `memory_facts`, 0 `memory_takes`, 545 `ingestion_events`, 403 `memory_provenance` rows, 85 `repo_memories`, and 89 `repo_memory_judgments` into local D1, then verified company-memory FTS and D1-backed repo memory lookup.

## Required Preflight

Run these before starting the 20 sessions.

```bash
# 1. Local setup and migrations. This also assigns API/UI ports in .worktree-ports.
bash scripts/worktree-setup.sh

# 2. Confirm this branch uses the control-plane memory rollout gate.
rg -n "ARCANIST_MEMORY_TOOLS_ENABLED|isMemoryEnabledForBusiness" apps/control-plane-worker/src/session apps/control-plane-worker/src/constants/company-memory.ts

# 3. Confirm ngrok is configured before starting local Slack testing.
grep -E '^NGROK_DOMAIN=.+' apps/control-plane-worker/.dev.vars

# 4. Start the local API/UI/dev Slack callback stack and keep it running.
npm run dev:full
```

Abort conditions:

- If the rollout-gate check does not show `ARCANIST_MEMORY_TOOLS_ENABLED` and `isMemoryEnabledForBusiness`, stop and verify this branch is using the prod-Cycloid memory gate.
- If `NGROK_DOMAIN` is missing, stop and configure the static ngrok domain used by the `@Cycloid (DEV)` Slack app.
- If `npm run dev:full` does not print `Tunnel ready at https://<NGROK_DOMAIN>` and then start `api`, `ui`, and `ssl` processes, stop and fix the local dev stack before posting in Slack.

In a second terminal, verify local readiness after `npm run dev:full` starts:

```bash
source .worktree-ports 2>/dev/null || true
curl -fsS "http://localhost:${API_PORT:-3000}/health"
curl -fsS "$(sed -n 's/^CONTROL_PLANE_URL=//p' apps/control-plane-worker/.dev.vars | tail -n 1)/health"
```

Both health checks must return JSON with `"ok":true`.

Create a results directory before the first scenario:

```bash
export MEMORY_SIM_RESULTS_DIR=".tmp/memory-sim-results-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$MEMORY_SIM_RESULTS_DIR"
```

The clone script stores a baseline under `.tmp/prod-memory-local-clone-<timestamp>/` with JSON exports and the generated local import SQL. Keep that directory with the run results so later prod memory changes do not invalidate the expected-memory list.

Sanity-check local D1 after cloning:

```bash
cd apps/control-plane-worker

npx wrangler d1 execute cycloid-control-plane-production \
  --command "SELECT f.id, substr(f.claim,1,120) AS claim FROM memory_facts_fts JOIN memory_facts f ON f.rowid = memory_facts_fts.rowid WHERE memory_facts_fts MATCH '\"Slack\" OR \"completion\"' AND f.business_id='295d2abc-d10b-4662-b84d-7bfa66242882' AND f.status='active' ORDER BY f.confidence DESC LIMIT 5;"

npx wrangler d1 execute cycloid-control-plane-production \
  --command "SELECT memory_id, substr(context_hint,1,100) AS context_hint FROM repo_memories WHERE lower(repo_owner)='trycycloid' AND lower(repo_name)='cycloid' AND status='active' AND (memory_id='mem_pr_4993_add_1' OR context_hint LIKE '%review-loop%') ORDER BY updated_at_ms DESC LIMIT 8;"
```

Expected: the first query returns cloned Slack/company facts and the second returns `mem_pr_4993_add_1` plus other D1-backed repo memories.

## Per-Scenario Procedure

For browser-use-driven Slack batch runs, follow the canonical workflow in
[docs/slack-testing.md](../slack-testing.md#browser-use-live-session-runs). Local-dev Slack runs
must use small waves rather than one wide launch through a single local tunnel; rerun any scenario
where the E2B bridge logs show `/sandbox/repo-memory/recall` failed on the local callback path.

1. Confirm `npm run dev:full` is still running and the local/CONTROL_PLANE_URL health checks above still pass.
2. In the existing headed browser session, open Slack `#shiv-testing`.
3. Post the exact scenario prompt as a fresh top-level message. Use `@Cycloid (DEV)`, not production `@Cycloid`.
4. Wait for `@Cycloid (DEV)` to reply with a local session link. If the production bot replies, stop; the wrong app was tagged.
5. Capture:
   - Slack message permalink.
   - Slack parent timestamp/thread timestamp.
   - Cycloid session URL.
   - session ID.
   - PR URL when created.
6. Let the session complete without intervention unless it asks a required question.
7. Record whether the session succeeded:
   - PR opened.
   - PR is relevant to the requested coding task.
   - Verification evidence is honest and proportional.
8. Evaluate memory usage:
   - expected memories pulled in.
   - expected memories missed.
   - extra memories pulled in and whether each was relevant, harmless, or harmful.
9. Close the PR after evaluation so the simulation does not leave 20 draft implementation PRs open.
10. Do not start the next scenario until the current scenario has a completed result block and its PR is closed.

Query durable memory usage after each local session:

```bash
cd apps/control-plane-worker
SESSION_ID="<session-id>"
npx wrangler d1 execute cycloid-control-plane-production \
  --command "SELECT session_id, prompt_id, memory_id, source, selection_rank, selection_score, intent, files_json, review_outcome FROM memory_usage_events WHERE session_id = '$SESSION_ID' ORDER BY used_at, source, selection_rank;"
```

Export raw session events too, because prompt-start empty retrieval and retrieval traces may not produce a row in `memory_usage_events`:

```bash
source .worktree-ports 2>/dev/null || true
SESSION_ID="<session-id>"
ADMIN_TOKEN="$(sed -n 's/^ARCANIST_ADMIN_TOKEN=//p' apps/control-plane-worker/.dev.vars | tail -n 1)"
test -n "$ADMIN_TOKEN"
curl -fsS \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:${API_PORT:-3000}/api/sessions/${SESSION_ID}/export" \
  > "${MEMORY_SIM_RESULTS_DIR}/${SESSION_ID}-export.json"

jq '.. | objects | select(.type? == "memory_usage" or .type? == "memory_recall_usage")' \
  "${MEMORY_SIM_RESULTS_DIR}/${SESSION_ID}-export.json" \
  > "${MEMORY_SIM_RESULTS_DIR}/${SESSION_ID}-memory-events.json"
```

Close the PR after scoring:

```bash
PR_URL="<pr-url>"
gh pr close "$PR_URL" --delete-branch --comment "Closing memory simulation PR after evaluation."
```

If branch deletion fails, still record the PR as closed and include the branch-delete failure in the scenario result.

Save one markdown result file per scenario:

```bash
SCENARIO="01-slack-upload-encoding"
"${EDITOR:-cursor}" "${MEMORY_SIM_RESULTS_DIR}/${SCENARIO}.md"
```

## Result Template

Use this block for every scenario:

```md
### Scenario N - <name>

- Slack permalink:
- Session URL:
- Session ID:
- PR URL:
- PR cleanup: closed | not closed | not applicable
- Outcome: success | partial | failed
- Expected memories:
- Actually used memories:
- Missing expected memories:
- Extra memories:
- Assessment:
```

## Test Scenarios

Every prompt should start with:

`@Cycloid (DEV) repo=trycycloid/cycloid [memory-sim]`

### 1. Slack External File Upload Encoding

Prompt:

`@Cycloid (DEV) repo=trycycloid/cycloid [memory-sim] Update Slack file upload handling so files.getUploadURLExternal has a focused regression proving it is sent as form-encoded data, and keep the existing slackApi helper pattern.`

Expected memories:

- Repo: `mem-084f6600` - Slack `files.getUploadURLExternal` requires form encoding.
- Company: any Slack upload/file-upload fact if retrieved; none required.

### 2. Slack Rich Text Deduplication

Prompt:

`@Cycloid (DEV) repo=trycycloid/cycloid [memory-sim] Improve Slack message deduplication so rich_text broadcasts like here/channel/everyone normalize the same way as message text, with regression coverage.`

Expected memories:

- Repo: `mem_4fe5ca0e` - normalize Slack rich_text mentions/broadcasts for deduplication.
- Company: `mf_b77d63ceb513cf537f1125e1c133bdbaea9068c46db1e98617496579c913c838` if Slack session creation context is retrieved, but this is optional.

### 3. Slack Completion Notification Recovery

Prompt:

`@Cycloid (DEV) repo=trycycloid/cycloid [memory-sim] Add or tighten tests around terminal Slack notification recovery so a completed prompt cannot permanently lose its Slack reply if delivery fails or the DO is interrupted.`

Expected memories:

- Company: `mf_5ed511772dcf55102973b7644d09a7814c9e6496514360d5e90e652dc3385c4c` - Slack completion delivery was best-effort and could be lost.
- Company: `mf_171e6c4b509ea2c998df1de493a29dca99512b9b20d1dbb0dcb347ec4c401e5e` - recovery loop when bot token resolution returns null.
- Company: `mf_4e96d92a55ec266348b27568b3b5a29b3f9c47a87e2ceaf53c32e9569c4e83df` - DO alarm retries missing terminal Slack prompts.
- Company: `mf_78dadabc509bfce33429c701b378366443dbedca898e19e9a7a29ccfafca7693` - arm recovery deadline before async Slack send.
- Company: `mf_8701c4c8c260b951b861abdffc77a04dc5e4a9eda8091ea47f8584c5686d5dc1` - clear pending marker and retry on Slack failure.
- Company: `mf_e6d8b0a3ac3d3eacb22d8c7c1e78625bc34cd6da8d199f30ea504fe9a3b88911` - `slack_posts.message_ts` means delivered messages.

### 4. Prompt Queue Terminalization Ordering

Prompt:

`@Cycloid (DEV) repo=trycycloid/cycloid [memory-sim] Add a regression around prompt terminalization so terminal prompt state is persisted before projection cleanup can fail, and avoid leaving prompts stuck in processing.`

Expected memories:

- Repo: `mem_465e6274` - terminal prompt state before projection/cleanup.
- Repo: `mem_72217b50` - session_idle/post_execution ordering.
- Company: `mf_8cb95d553dcad4b06416740292fbb37f23bf0ce2f7546f36255ca5a3616c5c23` - ARC-967 prompt terminalization ordering.
- Company: `mf_4f22fc607cba5a38feb9f0a84c480d94f47bcbc8f10e310edcc3472ac663c2e1` - `completeActivePrompt` and disconnect terminalization persisted before projection errors.

### 5. Rich Status Projection Race

Prompt:

`@Cycloid (DEV) repo=trycycloid/cycloid [memory-sim] Harden SessionDO rich_status projection so concurrent lifecycle transitions cannot let an older write overwrite a newer state, with focused tests.`

Expected memories:

- Repo: `mem_2670f42b` - serialize or CAS rich_status projection writes.
- Company: `mf_ccdac69bcc180bb6c09ab0e2730afe4693492c4d00f4ce44093551b7413d0ba9` - lifecycle reducer no-ops late `prompt.agent_prompt_sent` after running.

### 6. Late Prompt-Sent Lifecycle Regression

Prompt:

`@Cycloid (DEV) repo=trycycloid/cycloid [memory-sim] Add a lifecycle reducer regression so a late prompt.agent_prompt_sent event cannot move a prompt from running back to dispatching or re-arm the dispatch timeout.`

Expected memories:

- Repo: `mem_e094e0d8` - late prompt-sent must not regress running prompts.
- Company: `mf_ccdac69bcc180bb6c09ab0e2730afe4693492c4d00f4ce44093551b7413d0ba9` - same production fix as company memory.

### 7. Publish Flow Re-entrancy

Prompt:

`@Cycloid (DEV) repo=trycycloid/cycloid [memory-sim] Add a guard or regression so prompt-scoped publish finalization cannot double-emit PR-created or publish-completed events when the publish path is re-entered.`

Expected memories:

- Repo: `mem_e9bde4cc` - dedupe whole publish run per prompt.
- Repo: `mem_72217b50` - post_execution/session_idle race handling.

### 8. PR Readiness Command Redaction

Prompt:

`@Cycloid (DEV) repo=trycycloid/cycloid [memory-sim] Expand PR readiness command evidence redaction tests for nested shell commands and glued short password flags, while preserving non-secret flags like -profile.`

Expected memories:

- Repo: `mem_f2c6fca9` - scope inline short password redaction and preserve `-profile`.
- Repo: `mem_d51f8566` - recursively sanitize quoted shell `-c` payloads with ordered replacements.
- Company: `mf_d55d8962053d8bf8599872dd5a140bbae636090f638614e887f9abf553586fee` - glued short password flags were redacted in PR readiness evidence.

### 9. Invalid Credential Runtime Fallback

Prompt:

`@Cycloid (DEV) repo=trycycloid/cycloid [memory-sim] Add coverage so invalid saved provider credentials are treated as unavailable during runtime credential injection and bootstrap/provider availability, allowing managed fallback where appropriate.`

Expected memories:

- Repo: `mem_9ce4e307` - fail closed when encrypted credentials cannot be decrypted.
- Repo: `mem_f84b01df` - invalid saved credentials must also affect provider visibility.
- Company: `mf_191e85762b2d02120fe9faf891af7f1bdfcfce49a5d0ca98ea0f67f86452e216` - invalid saved credentials treated as missing for runtime resolution.
- Company: `mf_34d600ca4e260315ca9117757f7a607018131cc3f3faf99383b36c86eef1934f` - managed OpenAI virtual key fallback instead of known-bad saved key.
- Company: `mf_a7996d97a4a013f9f773568cfdaa8f483b2f69acdf4777c20ce5c91dbebbf405` - fail closed when encrypted credentials exist without `TOKEN_ENCRYPTION_KEY`.
- Company: `mf_2c6391dcb73b0d724561abc290fb6f12ca746f003385c249f8ae54aa220287a2` - fail-closed guard applied to provider and integration credentials.

### 10. Slack Workspace Reinstall Authorization

Prompt:

`@Cycloid (DEV) repo=trycycloid/cycloid [memory-sim] Add a regression around Slack workspace reinstall so an OAuth reinstall cannot move an existing workspace to a different non-null business.`

Expected memories:

- Company: `mf_3fbec4c0d07540af5619e070e9831f8145ed10f869fd5c9066eff89870f8cda8` - reinstall rejects existing workspace owned by another business.
- Company: `mf_cebbf18fbca7e194878e8eedaacfed2693f119c74a0b5a04276726386496e073` - load existing Slack workspace metadata before deciding reinstall.

### 11. GitHub Installation Permission Refresh

Prompt:

`@Cycloid (DEV) repo=trycycloid/cycloid [memory-sim] Add a GitHub installation webhook regression so permission refresh events update permissions/events without resurrecting suspended or deleted installations.`

Expected memories:

- Repo: `mem_8b923f65` - permission refresh must use update-only helper and preserve suspension state.
- Company: `mf_42f5bd2a3752e3c6084e6d6d168d8f6c216176142a7660f4aaa3569965da9c23` - GitHub app permission upgrades persisted by upserting current permissions/events. This is relevant but should not override the repo memory's suspension-state warning.

### 12. Review Listening PR Ref Pagination

Prompt:

`@Cycloid (DEV) repo=trycycloid/cycloid [memory-sim] Add pagination coverage for review-listening GitHub PR refs where multiple refs share the same session timestamp, ensuring no rows are skipped or duplicated.`

Expected memories:

- Repo: `mem_55655873` - joined-list cursor must include every order-by tie-breaker.
- Company: `mf_9377e1d01007bdffb6673e98cb387b01a87de3af8c05902715bba0caf8f4904c` - `listReviewListeningGithubPrRefs` paginates by `updated_at`, `session_id`, and `pr_url`.

### 13. CI Review-Loop Eligibility

Prompt:

`@Cycloid (DEV) repo=trycycloid/cycloid [memory-sim] Add a review-loop regression so CI epochs use CI eligibility for publish guards and sweep processing, while human and bot epochs keep their existing eligibility paths.`

Expected memories:

- Company: `mf_a395ed9293123256595147b89eb7e94db7caefe1ee902cfd6f6f7612fecdc2a6` - CI epochs should use `resolveReviewLoopCiEligibility`.
- Company: `mf_d08409bd95553df4abe10fc2c7e5f52f808c303ec7d908eb0bf05274732bfcbe` - human/mixed and bot epochs keep their own eligibility paths.

### 14. Human Review-Loop New Wave Keying

Prompt:

`@Cycloid (DEV) repo=trycycloid/cycloid [memory-sim] Add a review-loop epoch test so a human new-wave insert from a frozen bot epoch is re-keyed to the human-only epoch key and uses the same key on lost-insert-race retry.`

Expected memories:

- Repo judgment: `mem_pr_4993_add_1` - human wave must use a human-only epoch key, not the bot-foldable key.
- Repo judgment: `mem_pr_4993_add_2` - compute the re-keyed input once and reuse it on retry.
- Company: `mf_3820dd2880239f1e6dd5861bba6fcbacd6b91cdb09ee45a1b682a4b1d652e621` if review-listening reengagement context is retrieved.

### 15. Streaming Webhook Body Limit

Prompt:

`@Cycloid (DEV) repo=trycycloid/cycloid [memory-sim] Add a capped webhook body reader that rejects oversized streaming bodies without buffering the whole request, and add tests that assert cancellation without relying on exact pull counts.`

Expected memories:

- Repo judgment: `mem_pr_4992_add_1` - enforce body cap incrementally and cancel the stream.
- Repo judgment: `mem_pr_4992_add_2` - do not assert exact ReadableStream pull counts in cancellation tests.

### 16. Company Memory Session Authorization

Prompt:

`@Cycloid (DEV) repo=trycycloid/cycloid [memory-sim] Refactor company-memory session authorization so read access, repo authorization, and Slack refine/write permissions remain distinct and preserve 404/403/503 response semantics.`

Expected memories:

- Repo judgment: `mem_pr_4650_add_1` - keep session visibility, repo authorization, and refine/ingestion permission separate.
- Repo judgment: `mem_pr_4650_add_2` - return structured auth results instead of flattening distinct failures.

### 17. Memory Feature Disablement Surfaces

Prompt:

`@Cycloid (DEV) repo=trycycloid/cycloid [memory-sim] Add a regression proving that disabling model-facing memory disables prompt injection, dynamic tools, hooks, and does not bypass blocking enforcement that should still read the full repo-memory pool.`

Expected memories:

- Repo judgment: `mem_pr_4682_add_1` - disable every model-facing feature surface separately.
- Repo judgment: `mem_pr_4682_add_2` - blocking checks must not depend only on `activeMemories` when prompt injection is disabled.

### 18. Settings Editor Pending Input Dirty State

Prompt:

`@Cycloid (DEV) repo=trycycloid/cycloid [memory-sim] Fix a list-style settings editor so typed pending input is included in dirty/save/reset state and the next list is normalized before mutating state, with UI tests.`

Expected memories:

- Repo judgment: `mem_pr_5098_add_1` - pending input in list settings editors must count as unsaved data and be normalized before mutation.

### 19. Searchable Repo Selector Blur Behavior

Prompt:

`@Cycloid (DEV) repo=trycycloid/cycloid [memory-sim] Add UI regression coverage for searchable repo/base-branch selector chips so blur text cannot replace a valid selected repo with invalid free text, and submit-time values are resolved from the current parent selection.`

Expected memories:

- Repo judgment: `mem_pr_4989_add_1` - resolve parent-dependent settings from current source of truth at submit/prewarm time.
- Repo judgment: `mem_pr_4989_add_2` - fixed-set searchable selectors should not commit unknown blur text.

### 20. Shell Migration Script Pipefail Membership Check

Prompt:

`@Cycloid (DEV) repo=trycycloid/cycloid [memory-sim] Update a deploy or migration shell script membership check to avoid echo-pipe-grep under set -o pipefail, and add a regression or explanatory test fixture if the repo has one.`

Expected memories:

- Repo judgment: `mem_pr_4533_add_1` - use here-string or non-pipelined grep under `set -o pipefail`.
- Repo judgment: `mem_pr_4533_add_2` - `echo ... | grep -q` can SIGPIPE under pipefail in deploy-critical scripts.

## Final Aggregate Evaluation

After all 20 runs, create a summary with:

- Pass rate for task success.
- Recall rate for expected repo memories.
- Recall rate for expected company memories.
- Count of extra relevant memories.
- Count of extra irrelevant memories.
- Count of harmful memories.
- Scenarios where memory was expected but no memory surfaced.
- Scenarios where memory surfaced but the agent did not appear to use it.
- PR cleanup completion: all simulation PRs closed or listed as intentionally retained.
- Product recommendations:
  - retrieval tuning needed.
  - prompt/tool guidance needed.
  - memory materialization/source-of-truth gaps.
  - stale or low-quality memories to expire/reject.

## Final Abort Checklist

- Confirm the local Slack tunnel/callback is active before the first prompt.
- Confirm the branch under test uses the control-plane `ARCANIST_MEMORY_TOOLS_ENABLED` rollout gate before starting `npm run dev:full`.
- Confirm each scenario PR is closed after evaluation.

## Run Notes - 2026-06-19 Local Simulation

Artifacts: `.tmp/memory-sim-results-20260618-194538/`.

Aggregate outcome:

- Scenarios run: 20/20.
- Success: 14/20.
- Partial: 3/20.
- Failed/no PR: 3/20.
- PRs opened: 15.
- PR cleanup: all opened simulation PRs were closed; final check found no open `app/cycloid-dev` PRs.
- Expected repo memories counted: 25.
- Expected repo memories surfaced via repo dispatch or dynamic recall: 7/25 (28%).

Per-scenario memory impact:

- 01 Slack upload encoding: task succeeded, but expected repo memory `mem-084f6600` was missed. Memory did not appear to materially help; the agent solved from prompt plus code inspection.
- 02 Slack rich text deduplication: task succeeded, but expected repo memory `mem_4fe5ca0e` was missed. Retrieved memory was Slack-adjacent but not useful for the requested dedupe behavior.
- 03 Slack completion notification recovery: task succeeded. Memory helped: three expected company memories surfaced, but three other expected company memories were missed.
- 04 prompt queue terminalization ordering: task succeeded. Expected company memories surfaced and helped; expected repo memories `mem_465e6274` and `mem_72217b50` were missed.
- 05 rich status projection race: failed with no PR. Both expected memories were missed, and an unrelated terminalization memory surfaced; this was the clearest harmful retrieval because it likely pushed the agent toward the wrong subsystem.
- 06 late prompt-sent lifecycle: failed with no PR. A relevant company memory surfaced, but expected repo memory `mem_e094e0d8` was missed; recall was helpful but insufficient.
- 07 publish flow re-entrancy: task succeeded despite missing both expected repo memories. A different replay/idempotency memory was relevant enough to help.
- 08 PR readiness redaction: task succeeded. Expected company memory surfaced and helped; both expected repo memories were missed.
- 09 invalid credential runtime fallback: task succeeded. Several expected company memories surfaced and helped; both expected repo memories and one company memory were missed.
- 10 Slack workspace reinstall authorization: task succeeded. Primary expected company memory surfaced and directly helped; secondary expected metadata-loading memory was missed.
- 11 GitHub installation permission refresh: task succeeded. Expected company memory surfaced and helped; expected repo suspension-state memory was missed.
- 12 review-listening PR ref pagination: task succeeded, but both expected memories were missed. Retrieved review-listening memory was adjacent but not pagination-specific.
- 13 CI review-loop eligibility: failed before PR creation. Primary CI eligibility company memory surfaced, but the expected human/bot eligibility-path memory was missed.
- 14 human review-loop new-wave keying: task succeeded. Both expected repo memories and optional company memory surfaced; this was one of the strongest recall examples.
- 15 streaming webhook body limit: task succeeded. Both expected repo memories surfaced through repo dispatch, and one was dynamically recalled; recall was effective.
- 16 company-memory session authorization: task succeeded despite missing both expected repo judgments. Memory recall was poor; the agent solved from code inspection and prompt specificity.
- 17 memory feature disablement surfaces: partial with no PR. Both expected repo memories were missed; dynamic recall returned adjacent prompt/review-loop memories instead.
- 18 settings editor pending input dirty state: task succeeded. Expected repo memory surfaced through dispatch and dynamic recall; recall was effective.
- 19 searchable repo selector blur behavior: partial/no PR. Both expected repo memories were in dispatch and one was dynamically recalled, but the run ended with `noChanges`; memory helped identify the issue class but did not lead to a usable implementation.
- 20 shell migration script pipefail membership check: partial. The coding task succeeded and opened a relevant PR, but both expected repo memories were missed and no memory usage rows were recorded.

Aggregate evaluation:

- Task success was materially better than repo-memory recall. The agent often solved tasks through direct code inspection even when expected memories were absent.
- Company-memory recall was more reliable than repo-memory recall for Slack, credential, and GitHub-installation scenarios, but still missed important paired memories.
- Repo-memory dispatch worked well for PR-judgment memories in scenarios 14, 15, 18, and partly 19. It was weak for older named repo memories and several targeted review-loop/control-plane cases.
- Dynamic recall often retrieved adjacent memories, but adjacency was not enough for precise regression tasks. The most common failure mode was selecting same-domain but wrong-mechanism memories.
- Extra irrelevant memories were usually harmless, but scenario 05 shows they can be actively harmful when an adjacent memory points at a different subsystem.
- Several no-PR outcomes were session/runtime failures rather than clear memory failures, but missed memory reduced the chance of recovery because the agent lacked the exact prior fix pattern.

Follow-up recommendations:

- Improve query-to-memory matching for exact subsystem terms such as `rich_status`, `prompt.agent_prompt_sent`, `pipefail`, and named DAO/service functions.
- Treat PR-judgment memories with exact symbol/file overlap as high-priority candidates even when semantic scoring is diffuse.
- Add retrieval evaluation around paired memories: several scenarios needed both halves of a convention, but recall returned only one.
- Add diagnostics for memories present in repo dispatch but absent from `memory_usage_events`, because dispatch-only visibility made recall scoring ambiguous in scenarios 15 and 19.
- Down-rank generic Slack/company-memory feedback facts when the task is code-path-specific and no matching files overlap.

## Phase 2 - Prod Session Replay Plan

Goal: replay the 30 selected real production Cycloid sessions below, then score whether the current local memory system retrieves the memories that should apply to those real tasks.

Phase 2 should keep the Phase 1 local-memory setup and Slack/local-dev execution path, but replace the synthetic scenario list with a checked-in manifest of real historical sessions.

### Phase 2 Manifest

Use this checked-in manifest for Phase 2. All expected memories are `store=repo`, `required=true`. Near misses are not preselected; record extras only if the replay retrieves them.

Replay each row as:

```text
@Cycloid (DEV) repo=trycycloid/cycloid [memory-sim-real <scenario> original=<original_session_id>] <original prompt text from prod session_completions.prompt_text, minimally normalized only if needed>
```

Use this lookup to materialize full replay prompts from the selected sessions before posting to Slack:

```bash
cd apps/control-plane-worker
IDS="'d4b375e2-dac1-4abe-a954-efae91919364','39a604e5-c40d-4113-b4dd-f53c309bbe8f','15581208-c7c6-4d94-9a28-13ff7c0a4de6','22d37fb5-4993-46e5-b14e-82a87e142d14','2097102d-ce78-43c6-a7d9-c6064e0d8f85','779f8745-b2b2-43c2-84c2-3c37f9dd960e','066f7d7d-5a89-454c-9499-3a88f0e7ca54','92cc36ad-52e4-4fe8-9faa-595ec8d1c01f','25617729-ab3b-4596-bccb-b3d92ab7a4d6','167cdb6e-825f-4e3e-8587-be08686f282b','4bf8022a-e459-47b2-9d10-967dac02e2f2','f026754d-f29c-42f9-a123-1ab2a981262b','5473b494-13d7-4d42-84f6-7187a467ec96','c3696881-0ace-497e-a430-f42ec696d544','eec4a203-94ce-4d27-a6d6-9a55a854c104','6ae9fa22-8082-41c4-a16a-a8df7f521bc5','c290d986-b17c-46d4-b3a3-8a57d22faae2','5c54e37c-1651-4c1b-9582-54a3a18c8852','cea986e6-984a-4420-9269-e7eb73c0eecc','c2222f11-fd94-49c3-a169-3e6d12eff3c8','f722f919-f17d-4b90-a576-598aa9df6ae5','18a2c39c-b905-4aaa-955d-16495d7c5fde','ac598bf4-d239-4143-b54c-fd5ae4934d05','68617f48-5a8b-4e3f-8867-29c2abec5de9','a3aa580f-381a-4bb4-a867-32eeb2889ad1','42f32522-d067-4427-b30f-3cb7e049d62b','ce005c24-5e9f-4472-a03f-a4b126349777','a1e70202-c9b2-4080-9b67-7e6c7f2d160e','8309bca6-1217-44b7-8bfa-13e2b3e11402','3f593547-8b8e-413f-91f3-c48bcd6f4960'"
npx wrangler d1 execute cycloid-control-plane-production --remote --json \
  --command "SELECT session_id, title, pr_url, prompt_text FROM session_completions WHERE session_id IN ($IDS) AND pr_url IS NOT NULL ORDER BY completed_at;"
```

| Scenario | Original session                       | Original PR | Title                                                                 | Expected recall                                                                                                                                                                                                                                                     |
| -------- | -------------------------------------- | ----------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-01    | `d4b375e2-dac1-4abe-a954-efae91919364` | #5100       | Add stop reasons to verification comments                             | `mem_pr_5100_add_1`: verification stop/comment flows must distinguish user stops, archives, and platform failures.                                                                                                                                                  |
| P2-02    | `39a604e5-c40d-4113-b4dd-f53c309bbe8f` | #5098       | Egress allowlist settings redesign                                    | `mem_pr_5098_add_1`: list-style settings UI with add/remove controls and a typed pending input.                                                                                                                                                                     |
| P2-03    | `15581208-c7c6-4d94-9a28-13ff7c0a4de6` | #4993       | Rekey human review waves to avoid bot hash folding                    | `mem_pr_4993_add_1`: human new-wave insert must avoid folded bot epoch keys; `mem_pr_4993_add_2`: CAS retry must preserve the final re-keyed input.                                                                                                                 |
| P2-04    | `22d37fb5-4993-46e5-b14e-82a87e142d14` | #4992       | Enforce webhook body cap while streaming                              | `mem_pr_4992_add_1`: streamed body cap must reject without buffering the whole payload; `mem_pr_4992_add_2`: stream cancellation tests must avoid exact pull-count assertions.                                                                                      |
| P2-05    | `2097102d-ce78-43c6-a7d9-c6064e0d8f85` | #4972       | Investigate StructuredOutputError 503 alerts                          | `mem_pr_4972_add_1`: adjudication sweeps should skip retryable provider failures per pair; `mem_pr_4972_add_2`: only transport/408/429/5xx structured-output errors are transient.                                                                                  |
| P2-06    | `779f8745-b2b2-43c2-84c2-3c37f9dd960e` | #4970       | Fix outdated verification verdict misattribution                      | `mem_pr_4970_add_1`: PR-head webhook advancement must repair outdated review/verification state; `mem_pr_4970_add_2`: failed cleanup after durable state changes should return 500/release claim.                                                                   |
| P2-07    | `066f7d7d-5a89-454c-9499-3a88f0e7ca54` | #4969       | Fix VA comment body blocker preservation                              | `mem_pr_4969_add_1`: parse/store structured metadata before capped body truncation; `mem_pr_4969_add_2`: render VA blockers from preserved context, not truncated comments.                                                                                         |
| P2-08    | `92cc36ad-52e4-4fe8-9faa-595ec8d1c01f` | #4963       | Fix prompt path duplicate group info discard                          | `mem_pr_4963_add_1`: review-loop reply validation must accept canonical items and duplicate-group members.                                                                                                                                                          |
| P2-09    | `25617729-ab3b-4596-bccb-b3d92ab7a4d6` | #4962       | Fix instruction newline sanitization bug                              | `mem_pr_4962_add_1`: markdown-list prompt assembly must indent embedded newlines.                                                                                                                                                                                   |
| P2-10    | `167cdb6e-825f-4e3e-8587-be08686f282b` | #4956       | Work on Cycloid ticket ARC-1232                                       | `mem_pr_4956_add_1`: review-loop empty worklists must branch on structural cause before blocking.                                                                                                                                                                   |
| P2-11    | `4bf8022a-e459-47b2-9d10-967dac02e2f2` | #4946       | Run Cycloid full stack and verify readme emoji change                 | `mem_pr_4946_add_1`: dogfood runtime env and D1 bootstrap must share the same OpenAI credential source; `mem_pr_4946_add_2`: startup scripts must not line-parse quoted or multiline secrets.                                                                       |
| P2-12    | `f026754d-f29c-42f9-a123-1ab2a981262b` | #4939       | Check local Cycloid startup keys                                      | `mem_pr_4939_add_1`: local bootstrap must choose GitHub CLI auth flow by token type.                                                                                                                                                                                |
| P2-13    | `5473b494-13d7-4d42-84f6-7187a467ec96` | #4915       | Add TTL and sweeper for webhook idempotency claims                    | `mem_pr_4915_add_1`: stranded webhook idempotency claims need TTL reclaim and sweeper; `mem_pr_4915_add_2`: ISO timestamp columns should compare directly against ISO cutoffs in D1.                                                                                |
| P2-14    | `c3696881-0ace-497e-a430-f42ec696d544` | #4912       | Fix review-loop dedup for edited feedback                             | `mem_pr_4912_add_1`: dedup must compare source updatedAt against last prompted time; `mem_pr_4912_add_2`: enqueue/sweep must persist the prompted item's updatedAt, not sweep nowMs.                                                                                |
| P2-15    | `eec4a203-94ce-4d27-a6d6-9a55a854c104` | #4907       | Fix review-loop prompted ids union on reclaim                         | `mem_pr_4907_add_1`: recovery/re-enqueue must merge prior prompted source records; `mem_pr_4907_add_2`: reclaimed epochs must keep earlier prompted ids when re-enqueued with a smaller worklist.                                                                   |
| P2-16    | `6ae9fa22-8082-41c4-a16a-a8df7f521bc5` | #4904       | Critical sandbox event ACK replay                                     | `mem_pr_4904_add_1`: ACK/replay regression tests must recreate the worker/DO, not only test same-instance duplicate delivery.                                                                                                                                       |
| P2-17    | `c290d986-b17c-46d4-b3a3-8a57d22faae2` | #4901       | Investigate repository secrets injection into sessions                | `mem_pr_4901_add_1`: approved repo env names need a spawn-time manifest and child-process rehydration; `mem_pr_4901_add_2`: env visibility filters must block execution-control/loader variables.                                                                   |
| P2-18    | `5c54e37c-1651-4c1b-9582-54a3a18c8852` | #4899       | Align platform LLM broker attempts and bridge logging                 | `mem_pr_4899_add_2`: bridge failure logs should emit attempt counts only when supplied by broker/client errors.                                                                                                                                                     |
| P2-19    | `cea986e6-984a-4420-9269-e7eb73c0eecc` | #4894       | Update repo resolution retry attempts                                 | `mem_pr_4894_add_1`: webhook handlers awaiting inference must budget full retry/backoff wall time; `mem_pr_4894_add_2`: Linear repo inference must stay under Linear's 5-second webhook deadline.                                                                   |
| P2-20    | `c2222f11-fd94-49c3-a169-3e6d12eff3c8` | #4890       | Add logging for sandbox connection issue sessions                     | `mem_pr_4890_add_1`: sandbox-only telemetry/runtime tags must be gated on `kind === "sandbox"`.                                                                                                                                                                     |
| P2-21    | `f722f919-f17d-4b90-a576-598aa9df6ae5` | #4889       | Prepare Cycloid CLI sandbox auth                                      | `mem_pr_4889_add_1`: mint/write CLI credentials only after repo-owned setup finishes; `mem_pr_4889_add_2`: disk-backed auth must be temp-file/rename/0600 and fail closed; `mem_pr_4889_add_3`: do not create readable CLI config while repo setup can poll `HOME`. |
| P2-22    | `18a2c39c-b905-4aaa-955d-16495d7c5fde` | #4877       | Fix missing paused sandbox runtime error                              | `mem_pr_4877_add_1`: recovered maintenance cleanup should log info, not page; `mem_pr_4877_add_2`: downstream warning logs with error payloads can still classify as exceptions.                                                                                    |
| P2-23    | `ac598bf4-d239-4143-b54c-fd5ae4934d05` | #4862       | Fix Datadog bridge log status misclassification                       | `mem_pr_4862_add_1`: avoid reserved observability keys like top-level `status`; `mem_pr_4862_add_2`: Datadog phase-log queries should move to `@phase_status` while preserving severity filters.                                                                    |
| P2-24    | `68617f48-5a8b-4e3f-8867-29c2abec5de9` | #4856       | Make scheduled automation fire slots durable                          | `mem_pr_4856_add_1`: claimed scheduled fire slots need durable job rows storing resume-critical inputs; `mem_pr_4856_add_2`: retrying slot jobs should make later sweeps skip non-terminal jobs.                                                                    |
| P2-25    | `a3aa580f-381a-4bb4-a867-32eeb2889ad1` | #4854       | Make usage projections idempotent from durable events                 | `mem_pr_4854_add_1`: projection dedupe migrations should keep the latest corrected row before enforcing uniqueness.                                                                                                                                                 |
| P2-26    | `42f32522-d067-4427-b30f-3cb7e049d62b` | #4844       | Improve Slack repo directive parsing                                  | `mem_pr_4844_add_1`: shorthand repo directives that depend on external lookup must return structured matched/ambiguous/not-found results.                                                                                                                           |
| P2-27    | `ce005c24-5e9f-4472-a03f-a4b126349777` | #4820       | Refine protected-path policy block messaging and audit sibling guards | `mem_pr_4820_add_1`: grep-like command parsers must normalize attached flag-value forms before path checks; `mem_pr_4820_add_2`: `git grep` must recognize attached regexp options before pathspec parsing.                                                         |
| P2-28    | `a1e70202-c9b2-4080-9b67-7e6c7f2d160e` | #4819       | Fix Slack thread ingestion truncation                                 | `mem_pr_4819_add_1`: Slack thread reconstruction should dedupe block fallback while keeping attachments; `mem_pr_4819_add_2`: truncation helpers must search for sentence breaks strictly before the budget limit.                                                  |
| P2-29    | `8309bca6-1217-44b7-8bfa-13e2b3e11402` | #4817       | Fix verification agent to use latest PR head                          | `mem_pr_4817_add_1`: verification checkout must fetch/reset to the authoritative PR remote ref; `mem_pr_4817_add_2`: forked PRs and branch PRs need different refspecs; `mem_pr_4817_add_3`: do not `git reset --hard` after workspace setup.                       |
| P2-30    | `3f593547-8b8e-413f-91f3-c48bcd6f4960` | #4804       | Fix sparse counter missing-data handling for sandbox tracing init     | `mem_pr_4804_add_1`: Terraform-managed Datadog alerts over sparse counters must set `on_missing_data` explicitly.                                                                                                                                                   |

Replay prompt policy:

- Prefer the original user task text verbatim.
- If the original task is already fully implemented on current `main`, use a regression variant that preserves the real failure mode and expected memories. Mark `replayability` as `regression_variant`.
- Do not add memory IDs or memory hints to the replay prompt.
- Include only the phase tag and original session ID for traceability.

### Optimized Phase 2 Execution

Phase 1 showed the slow parts were Slack mention mistakes, waiting forever on `review_listening`, and workers doing too much per batch. Use this optimized flow.

For new live Slack reruns, use the canonical browser-use/subagent workflow in `docs/slack-testing.md#browser-use-live-session-runs`. The notes below are historical Phase 2 specifics and should not override the canonical launch and result-collection rules.

Run shape:

- Use 30 manifest entries.
- Use 5 workers, 6 scenarios each.
- Keep one coordinator process responsible for health checks, open-PR checks, and stuck-session triage.
- Workers may run in parallel, but each worker must run its own scenarios sequentially.
- Every worker must use its own `browser-use --session memory-sim-p2-<worker>` session.
- Do not share the parent `slack` browser session across workers.

Before sending each Slack prompt:

- Open `https://app.slack.com/client/T0AHHTH5X8C/C0B868WEA3B`.
- Select `@Cycloid (DEV)`.
- Verify the composed mention targets Slack user/member ID `U0ALK6K076E`.
- Abort that scenario if the mention targets production `U0AK0Q5CW8M`.
- After posting, verify local D1 has a `slack_thread_session_refs` row for the new thread timestamp before counting the scenario as started.

Coordinator polling loop:

```bash
source .worktree-ports 2>/dev/null || true
ADMIN_TOKEN="$(sed -n 's/^ARCANIST_ADMIN_TOKEN=//p' apps/control-plane-worker/.dev.vars | tail -n 1)"

# Recent local Slack-started sessions.
cd apps/control-plane-worker
npx wrangler d1 execute cycloid-control-plane-production \
  --command "SELECT thread_ts, session_id, updated_at_ms FROM slack_thread_session_refs WHERE channel_id='C0B868WEA3B' ORDER BY updated_at_ms DESC LIMIT 40;"

# Session state summary. Treat review_listening with a PR URL as ready to score.
SESSION_ID="<local-session-id>"
curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:${API_PORT:-3000}/api/sessions/${SESSION_ID}/export" \
  | jq -r '[
      (.session.status // .status // "unknown"),
      ([.. | objects | (.pr_url? // .prUrl? // .url? // empty) | select(type=="string") | select(test("github.com/trycycloid/cycloid/pull"))] | unique | join(",")),
      ((.events // []) | length),
      ((.events // [])[-1].timestamp // "")
    ] | @tsv'
```

Status handling:

- `review_listening` plus a PR URL: score immediately, export artifacts, close PR, and continue. Do not wait for a terminal `completed` state.
- `completed` with no PR: record as failed or partial, export artifacts, and continue.
- `stopped` with no PR: record as failed or partial with the stop reason, export artifacts, and continue.
- `running` with no new events for 10 minutes: inspect latest events; if no required user question is present, stop waiting, record as stuck, and continue only after coordinator approval.
- Required user question: answer only if the answer is obvious from repo/session context; otherwise record blocked and move on.

Per-scenario result file:

```md
### Scenario P2-NN - <title>

- Original session ID:
- Original PR URL:
- Replay prompt:
- Slack permalink:
- Local session URL:
- Local session ID:
- Replay PR URL:
- PR cleanup: closed | not closed | not applicable
- Outcome: success | partial | failed | blocked
- Expected memories:
- Actually used memories:
- Missing expected memories:
- Extra memories:
- Memory impact:
- Replay fidelity notes:
- Assessment:
```

Memory impact scoring:

- `direct`: expected memory visibly shaped the chosen implementation or tests.
- `supporting`: expected memory was retrieved and consistent, but the agent likely could have solved without it.
- `missed_but_solved`: expected memory was missed, but the agent still succeeded.
- `missed_and_failed`: expected memory was missed and the task failed or no PR was produced.
- `wrong_memory_harmful`: irrelevant memory plausibly steered the agent toward the wrong subsystem.
- `not_applicable`: replay ended before memory could matter.

Final Phase 2 aggregate:

- Pass rate for real-session replay.
- Recall rate for required repo memories.
- Recall rate for required company memories.
- Recall rate for optional memories.
- Count of direct/supporting/missed_but_solved/missed_and_failed/wrong_memory_harmful outcomes.
- Breakdown by source surface and subsystem.
- Top 10 missed required memories.
- Top irrelevant memories retrieved more than once.
- Stuck/no-PR rate.
- All PR cleanup status.

## Phase 2 Run Notes - 2026-06-19 Real Prod Replay

Artifacts: `.tmp/memory-sim-results-20260619-phase2/`. Scenario-specific result files are in that directory as `P2-01.md` through `P2-30.md`; start there for the raw per-session notes, session IDs, PR links, expected/actual memory lists, and replay-fidelity caveats.

Execution notes:

- Ran all 30 Phase 2 scenarios through Slack `#shiv-testing` using `@Cycloid (DEV)` and the local dev stack.
- Result set contains 30 per-scenario markdown files plus session exports, memory event extracts, and memory usage rows.
- Replay PRs opened: 12. All recorded replay PRs were closed and branches deleted: #5141, #5143, #5144, #5145, #5146, #5147, #5148, #5149, #5150, #5151, #5152, #5153.
- No open `memory-sim-real` replay PRs remained after cleanup.
- P2-08 has degraded replay fidelity because an early worker contaminated the prompt with P2-25 text. The session still targeted P2-08/ARC-1233 and produced a relevant PR, but treat it cautiously in aggregate scoring.
- P2-21 required one replay-fidelity adjustment: the prompt contained an inner literal `@Cycloid`; Slack autocompleted it to the production bot, so the inner mention was changed to plain `Cycloid` before sending. The leading bot mention remained the real DEV bot mention.

Aggregate outcome:

- 30 scenarios executed.
- 12 opened replay PRs.
- 18 produced no replay PR.
- 10 scenarios retrieved all expected memories.
- 20 scenarios missed at least one expected memory.
- 27 scenarios recorded at least one memory usage event.
- 3 scenarios recorded no memory usage: P2-09, P2-11, P2-30.
- Outcome labels from result files:
  - 6 `success`: P2-01, P2-07, P2-08, P2-12, P2-20, P2-24.
  - 6 `review_listening`: P2-16, P2-21, P2-25, P2-26, P2-29, P2-30.
  - 8 `partial`: P2-03, P2-04, P2-05, P2-09, P2-10, P2-14, P2-15, P2-19.
  - 5 `completed / noChanges`: P2-13, P2-17, P2-18, P2-22, P2-27.
  - 2 `failed`: P2-02, P2-06.
  - 2 `completed`: P2-23, P2-28.
  - 1 `blocked`: P2-11.

Strict recall and precision:

- Required expected memory slots: 50.
- Expected memories retrieved: 15/50, or 30%.
- Expected memories missed: 35/50, or 70%.
- Total used memories recorded: 114.
- Extra memories beyond the expected set: 99/114, or 86.8%.
- Scenario-level false-positive rate: 26/30 scenarios retrieved at least one extra memory.
- Memory-level false-positive rate: 99/114 retrieved memory IDs were outside the expected set.
- Precision was the main weakness. Recall was also weak, but the larger surprise was how often retrieval added unrelated memories even when it did hit the target.

False-positive interpretation:

- The strict definition above treats every memory outside the expected set as a false positive. This is useful for measuring retrieval precision, but it overstates user-visible harm: some extras were adjacent or harmless.
- Harmless or adjacent extras appeared in many successful runs:
  - P2-01 retrieved the expected stop-reason memory plus adjacent extras; task still succeeded.
  - P2-12 retrieved the expected GitHub-auth memory plus adjacent CLI-auth context; task succeeded.
  - P2-24 retrieved both expected automation memories plus related durable-event context; task succeeded.
- High-noise but still successful runs:
  - P2-16 hit expected `mem_pr_4904_add_1`, but also retrieved five unrelated repo memories and four company memories. It still opened a relevant PR.
  - P2-21 retrieved two of three expected CLI-auth memories, missed `mem_pr_4889_add_1`, and added several unrelated repo/company memories. It still opened a relevant PR.
  - P2-25 hit expected `mem_pr_4854_add_1`, but retrieved eight extra repo memories and three company memories. It still opened a relevant PR after two sandbox disconnect retries.
- Clear high-noise failure:
  - P2-28 missed both expected Slack thread-ingestion memories and retrieved 16 unrelated memories, including many repo memories from different subsystems. It produced no PR. This is the clearest Phase 2 example where memory noise looked actively bad.

How often memory detracted:

- Strict harmful/detracting cases: 3/30, about 10%.
  - P2-02: expected `mem_pr_5098_add_1` was missed; two wrong settings/search-selector memories surfaced; run failed without a PR.
  - P2-06: expected `mem_pr_4970_add_1` and `mem_pr_4970_add_2` were missed; retrieved repo memories were for a different issue; run failed without a PR.
  - P2-28: expected `mem_pr_4819_add_1` and `mem_pr_4819_add_2` were missed; retrieval was very noisy with many unrelated repo memories; no PR was produced.
- Broader noisy-or-distracting cases: 7/30, about 23%.
  - Includes the strict harmful cases plus P2-08, P2-16, P2-21, and P2-25.
  - P2-08 is counted here because replay fidelity was degraded by prompt contamination, not because memory alone clearly harmed the agent.
  - P2-16, P2-21, and P2-25 succeeded, but the extra-memory volume was high enough that these should count against retrieval quality.
- In most cases, false positives did not obviously derail the session. The agent often ignored irrelevant context and solved from prompt plus code inspection, or produced no PR because current code already had the requested behavior.

Per-scenario memory impact:

- P2-01 stop reasons in verification comments: expected memory surfaced; extras were adjacent; task succeeded. False positives did not materially detract.
- P2-02 settings list save/reset: expected memory missed; wrong repo memories surfaced; run failed. Strict detractor.
- P2-03 human-wave review-loop keying: both expected memories missed; only company memories surfaced; no PR because current code looked already fixed. Recall failure, not clear harm.
- P2-04 PR body/session links: both expected memories surfaced; extras were company-level; no PR because current code already matched. Good recall, no harmful false positive.
- P2-05 repo access/prioritization path: both expected memories missed; only company memories surfaced; no PR. Recall failure.
- P2-06 platform failure/retry behavior: both expected memories missed; wrong repo memories surfaced; no PR. Strict detractor.
- P2-07 ARC-1235 task: both expected memories missed; only company memories surfaced; task still succeeded. Missed recall but not harmful.
- P2-08 ARC-1233 duplicate reviewer threads: expected memory surfaced, plus unrelated newline memory and company extras; task succeeded. Replay fidelity degraded by prompt contamination.
- P2-09 newline sanitization: no memory usage; expected memory missed; agent reached no-op from code inspection. Recall miss.
- P2-10 review-loop empty worklist: expected memory missed; one company memory surfaced; no PR. Recall miss.
- P2-11 local E2E via Cycloid: no memory usage; blocked by missing in-sandbox local E2E secrets. Not useful for memory quality except as a miss.
- P2-12 sandbox GitHub auth startup: expected memory surfaced; extra CLI-auth memory was relevant; task succeeded.
- P2-13 webhook idempotency TTL: both expected memories missed; only company memories surfaced; no PR. Recall miss.
- P2-14 review-loop grouping: both expected memories missed; company/review-loop context surfaced; no PR because current code looked already fixed.
- P2-15 review-loop completion path: both expected memories missed; adjacent company/review-loop memories surfaced; no PR.
- P2-16 critical sandbox ACK/replay: expected memory surfaced; many unrelated repo/company extras; PR opened. Useful recall but poor precision.
- P2-17 repository secrets injection: both expected memories surfaced, plus related auth memories and company context; no PR because session ended noChanges. Strong recall, no clear false-positive harm.
- P2-18 platform LLM attempts: expected memory surfaced with company extras; no PR because current code looked already fixed. Good recall, low harm.
- P2-19 Slack completion/message context: both expected memories missed; only company memories surfaced; no PR. Recall miss.
- P2-20 sandbox connection issue logging: expected memory surfaced exactly; task succeeded. Best precision case.
- P2-21 Cycloid CLI sandbox auth: two of three expected memories surfaced; extras were mixed repo/company auth context; PR opened. Partial recall with noise.
- P2-22 paused sandbox runtime error: both expected memories missed; one company memory surfaced; no PR. Recall miss.
- P2-23 Datadog bridge log status: both expected memories missed; only company memories surfaced; no PR. Recall miss.
- P2-24 scheduled automation durable jobs: both expected memories surfaced; extra durable-event context was adjacent; task succeeded.
- P2-25 durable usage/completion projection: expected memory surfaced; very noisy extras; two sandbox retries before success; PR opened. Useful recall but poor precision.
- P2-26 Slack bare repo directive parsing: expected memory missed; only company memories surfaced; PR opened anyway. Missed recall but task succeeded.
- P2-27 protected-path policy messaging: both expected memories missed; only company memories surfaced; no PR. Recall miss.
- P2-28 Slack thread ingestion truncation: both expected memories missed; many unrelated repo memories surfaced; no PR. Strict detractor and worst false-positive case.
- P2-29 verification agent outdated PR head: all three expected memories missed; only company memories surfaced; PR opened anyway. Missed recall but task succeeded.
- P2-30 sparse Datadog counter missing-data handling: no memory usage; expected memory missed; PR opened anyway. Missed recall but task succeeded.

Pattern notes:

- Task success was materially better than memory recall. Several sessions opened relevant PRs despite missing expected memories, especially when the prompt was specific and file-oriented.
- Current-code no-op outcomes complicate scoring. P2-03, P2-04, P2-09, P2-14, P2-15, P2-17, and P2-18 often ended because the agent decided the fix already existed. These are recall failures or partials, but not always task failures.
- Repo-memory recall was inconsistent. It worked well in P2-04, P2-16, P2-17, P2-18, P2-20, P2-24, and P2-25, but missed many nearby historical PR memories in the lower-numbered P2-21 through P2-30 range.
- Company memory was frequently retrieved as generic context even when the required repo memory was missed. This inflated false positives and often did not help code-path-specific tasks.
- The retrieval system appears over-broad for durable-session, Slack, and review-loop terms. These subsystems share vocabulary across many prior fixes, causing unrelated repo memories to appear together.
- Extra memories were usually not fatal, but they increase prompt clutter and make it harder to tell whether the agent used the right prior fix pattern.

Recommendations from Phase 2:

- Track two separate metrics in future runs:
  - retrieval precision: extras as a share of all retrieved memories.
  - user-visible harm: cases where extra memories plausibly changed the agent's chosen subsystem or caused failure.
- Add a hard cap or stronger diversity filter for repo memories. P2-16, P2-25, and P2-28 show that large same-subsystem bundles can swamp the expected memory.
- Down-rank company memories unless they overlap requested files, identifiers, or integration names. Company memories were common extras and often too generic.
- Improve exact matching for Linear IDs, PR-derived memory IDs, file paths, and specific function names. The expected memories often corresponded to very specific prior PRs, but retrieval matched broad subsystem vocabulary instead.
- Penalize memories whose source PR/task title is from a different subsystem when a more exact repo memory exists.
- Treat no-memory sessions separately from retrieval misses. P2-09, P2-11, and P2-30 need instrumentation review because they are not precision failures; memory simply did not surface.
- Make the scorer avoid historical PR URLs from memory/context when identifying replay PRs. Several Phase 2 result files needed manual correction because exports contained old PR links unrelated to the replay.

## Retrieval Overhaul Plan

Goal: replace broad top-K and lexical prefiltering with a general recall decision engine that works for Cycloid and for other customer repos. The system should retrieve memory only when there is concrete evidence that the memory changes what the agent should do next.

### Runtime posture

- Keep model-facing memory enabled for internal testing and simulations through the control-plane `ARCANIST_MEMORY_TOOLS_ENABLED` rollout gate.
- Keep automatic bootstrap in the test matrix. Bootstrap has higher blast radius than explicit recall, so it gets stricter thresholds and separate metrics, but it must stay exercised.
- Do not use Phase 3 changes to run new live Slack sessions first. Start with retrieval-only replay against the Phase 2 manifest, then run live sessions after recall quality improves.

### Shared retrieval substrate

Use one retrieval contract for bootstrap, explicit repo recall, and explicit company recall:

1. Denoise the task input.
2. Extract structured task signals.
3. Build candidates from structured channels.
4. Fuse channel-specific candidates.
5. Rerank only the narrowed pool.
6. Apply a final utility gate.
7. Return compact cited memories or an explicit empty result.
8. Persist trace evidence for selected and rejected candidates.

Required trace fields:

- raw prompt hash, denoised prompt hash, denoised task excerpt.
- removed sections and structured signals.
- retrieval mode: `bootstrap`, `repo_recall`, or `company_recall`.
- retrieval config version.
- candidate channels per memory.
- raw channel scores, fused score, rerank score, final decision, reject reason.
- lifecycle, authority, confidence, source age, provenance count.
- selected count, returned-empty flag, latency, timeout.

### Generalizable candidate channels

Candidate generation must not depend on Cycloid-specific terms. Every repo/customer integration should map its local facts into these normalized channels:

- `exact_identifier`: PR number, ticket key, incident id, commit SHA, source session id, source memory id.
- `path_match`: exact file, directory prefix, package/module ownership, config path, migration path.
- `symbol_match`: function, class, route, constant, CLI command, schema/table, Terraform resource, workflow/check name.
- `tool_or_command_match`: test runner, shell command, MCP tool, GitHub/Slack/Linear/Datadog/Terraform/D1/E2B operation.
- `error_fingerprint`: stack trace frame, error code, log key, failed check name, alert/monitor key.
- `source_scope_match`: same Slack thread/channel/customer/repo/service/team or same source artifact lineage.
- `graph_match`: memory linked to a related file, symbol, service, PR, ticket, customer, incident, reviewer, or prior session.
- `fts_match`: BM25 over denoised task text and memory claim.
- `semantic_match`: vector similarity over compact canonical memories or episodes, never whole raw sessions as the primary unit.
- `recent_positive`: prior helpful feedback, only as a boost after another concrete channel matched.

The old "shares three text terms with the intent" rule is not acceptable as a primary channel. It may produce weak `fts_match` candidates only when paired with another strong channel, or when the reranker names a concrete task artifact that justifies returning it.

### Repo memory recall

Repo memory is for codebase rules, procedures, gotchas, dead ends, API contracts, verification rules, and enforcement rules.

Build a task card before retrieval:

- denoised user task.
- launch source and stripped boilerplate labels.
- repo owner/name and branch if known.
- ticket, PR, Slack thread, incident, or source artifact ids.
- mentioned files, opened files, touched files, symbols, commands, tools, failing checks, and observed errors.
- operation class: inspect, edit, test, publish, infra, migration, auth, UI, runtime, docs.

Candidate generation rules:

- Never slice the repo-memory pool by recency before task filtering. A relevant older memory must be eligible if it matches files, symbols, source artifacts, or errors.
- Hard-filter inactive, superseded, rejected, expired, contradicted, wrong-repo, wrong-business, and missing-provenance memories.
- Prefer exact path/symbol/error/source matches over broad same-subsystem text matches.
- Cap per subsystem/source/kind after candidate scoring so one vocabulary cluster cannot swamp the result.
- Keep enforcement separate from recall. `warn` and `block` memories fire from deterministic path/diff/command predicates, not semantic similarity.

Repo memory output should be compact and wrapped as read-only data:

```text
<cycloid:repo_memory readonly>
[mem_pr_1234_add_1 | gotcha | active | score 0.91]
Claim: ...
Applies: apps/example/file.ts, symbolName
Why returned: exact path + prior failure class.
Source: PR #1234, session ..., event ...
</cycloid:repo_memory>
```

### Company memory recall

Company memory is for decisions, constraints, commitments, preferences, dead ends, customer context, and sourced facts.

Candidate generation rules:

- Hard-filter by business id, caller authorization, source visibility, channel/customer/repo scope, lifecycle, retention, redaction/quarantine state, and provenance before ranking.
- Use exact customer/repo/channel/thread/ticket/PR/source anchors when available.
- Use graph traversal from detected entities for customer, repo, channel, incident, owner, and service context.
- Use BM25 and semantic search as recall channels, not as the final decision.
- Confidence means "the claim is likely true"; it must not substitute for task relevance.
- Bootstrap company recall should require stronger source/task overlap than explicit company recall.

### Final utility gate

No model-facing surface may return memories just because they are top-K. The final gate must decide whether each memory is useful for the exact task.

Acceptance requires:

- active lifecycle and provenance.
- score above the versioned threshold for the mode.
- at least one strong structured channel, or a reranker rationale tied to a concrete file, symbol, source artifact, customer, error, command, or risk.
- no unresolved contradiction or supersession conflict.
- a one-line expected effect on the next action.

Valid reject reasons include:

- `weak_text_only_match`
- `same_subsystem_wrong_mechanism`
- `wrong_scope`
- `wrong_source_surface`
- `stale_or_superseded`
- `missing_provenance`
- `no_expected_action_change`
- `duplicate_of_selected_memory`

## Phase 2 Retrieval-Only Evaluation

Before running another live Slack batch, evaluate the new retrieval core against the 30 Phase 2 production replay scenarios. This should be a fast local test over the same prompts, expected memories, and cloned prod-memory corpus used by the live replay.

### Inputs

Use the checked-in Phase 2 manifest above plus the artifacts from `.tmp/memory-sim-results-20260619-phase2/`:

- scenario id, title, original session id, original PR, replay prompt.
- expected memory ids from the manifest.
- local prod-memory clone baseline used for Phase 2.
- scenario markdown files for actual Phase 2 outcomes and known caveats.

The retrieval-only runner must not post to Slack, start Cycloid sessions, create PRs, or mutate memory rows.

### Runner shape

Add a script or test harness that:

1. Loads the Phase 2 manifest and original prompts.
2. Builds a task card for each scenario from the replay prompt and available artifact metadata.
3. Runs `bootstrap`, `repo_recall`, and `company_recall` retrieval modes independently.
4. Records selected and rejected candidates with full trace evidence.
5. Compares selected memory ids to expected ids.
6. Writes one JSON result per scenario plus an aggregate markdown summary.

Suggested output directory:

```bash
.tmp/memory-retrieval-replay-<timestamp>/
```

The previous one-off local harness scripts were removed from the product branch. For another replay, use a temporary
scratch harness or a maintained eval runner rather than committing production-business/Slack-specific scripts.

### Metrics

Report these separately for `bootstrap`, `repo_recall`, and `company_recall`:

- expected recall: selected expected ids / expected ids.
- strict diagnostic precision: selected expected ids / all selected ids.
- strict extra-memory count and strict extra-ID rate. This is a retrieval diagnostic, not the product false-positive score.
- impact labels for every selected memory: `useful`, `neutral`, `bad`, or `unknown`.
- `neutral_plus_bad_fp_rate`: `(neutral + bad) / known_selected`.
- `bad_only_fp_rate`: `bad / known_selected`.
- scenario-level impact false-positive rates for both definitions.
- abstention correctness: scenarios with no selected memories where none should be returned.
- harmful-risk count: selected memories labeled `bad`.
- missing-expected reason distribution.
- selected-count distribution by mode.
- trace-completeness rate.
- timeout/fail-open count.

Use `known_selected = useful + neutral + bad`. Keep `unknown` rows visible and
explain why they could not be judged, but exclude them from impact-rate
denominators until resolved. A selected memory can be `useful` even if it was
not listed in the expected-ID manifest; strict expected-ID misses and impact
usefulness answer different questions.

Compare against Phase 2 live baseline:

- expected recall baseline: 15/50, 30%.
- strict memory-level extra-ID baseline: 99/114, 86.8%.
- strict scenario-level extra-ID baseline: 26/30.
- strict harmful/detracting baseline: 3/30.

### Acceptance targets before new live sessions

The retrieval-only runner should meet all of these before repeating the Slack live replay:

- Trace completeness: 100% for selected and rejected candidates.
- Repo expected recall improves materially over 30%; target at least 70% on the Phase 2 expected repo memories before live replay.
- Strict extra-ID rate falls below 25% for explicit repo recall, or failures are explained by useful non-manifest memories.
- Impact bad-only FP rate stays below 15% for explicit repo recall.
- Impact neutral-plus-bad FP rate trends downward or is offset by a documented recall gain.
- Bootstrap selected-count median is 0 or 1, with no high-risk false positives on P2-02, P2-06, or P2-28.
- No recency-cap misses where an expected memory exists in the corpus but was not considered.
- Every selected memory has a strong structured channel or a concrete reranker rationale tied to a task artifact.

### Hard-negative checks from Phase 2

Include explicit assertions for the known bad cases:

- P2-02 must not return settings/search-selector memories for a vague UX follow-up unless the task card contains the matching settings editor source anchors.
- P2-06 must not return unrelated verification memories when expected `mem_pr_4970_add_1` and `mem_pr_4970_add_2` are absent or not selected.
- P2-28 must consider `mem_pr_4819_add_1` and `mem_pr_4819_add_2`; it must not drop them due to recency ordering, and it must reject unrelated truncation/review-loop memories unless justified by concrete source anchors.

### Live replay gate

Only after the retrieval-only replay clears the acceptance targets should we rerun live Slack sessions. The next live run should keep bootstrap enabled for internal testing, but it should record bootstrap and explicit recall metrics separately so prompt-start noise is visible.

Phase 2 run-script improvements to implement before running:

- Add a manifest runner that reads the checked-in Phase 2 table above, materializes full prompts from D1 by `original_session_id`, assigns scenarios to worker batches, and writes per-worker task prompts.
- Add a small `score-session` helper that takes `{scenario, session_id, expected_memories}` and exports session JSON, memory events, D1 usage rows, PR URL, and a draft markdown result.
- Add a `close-simulation-pr` helper that is idempotent and records branch-delete failures without failing the whole run.
- Add a `verify-dev-mention` browser helper or Slack DOM check so workers cannot accidentally post to production `@Cycloid`.
- Add a coordinator dashboard script that prints scenario, Slack ts, local session ID, state, PR URL, event count, result file existence, and cleanup state.
- Add a retry-safe D1 query wrapper for transient `SQLITE_BUSY` during memory usage export.

## Retrieval-Only Run Notes - 2026-06-19

Implementation: `apps/sandbox-bridge/src/services/memory-ranking.ts` for runtime bootstrap recall and
`apps/control-plane-worker/src/memory/recall.ts` for runtime explicit repo recall. The Phase 2 replay harness was a
one-off local script and has since been removed from the product branch.

Artifacts: `.tmp/memory-retrieval-replay-current/`.

Results:

- Loaded 30 scenarios, 85 repo memories, and 165 company memories.
- Wrote one JSON trace per scenario plus `aggregate-summary.md`.
- `bootstrap` uses the same deterministic runtime selector as prompt-start memory injection in `sandbox-bridge`.
- `repo_recall` uses the same deterministic runtime selector as `/api/sessions/:sessionId/sandbox/repo-memory/recall`.
- `bootstrap`: recall 9/50 (18.0%), precision 9/9 (100.0%), memory-level false-positive rate 0.0%, median selected count 0, trace completeness 100%.
- `repo_recall`: recall 50/50 (100.0%), precision 50/50 (100.0%), memory-level false-positive rate 0.0%, median selected count 2, trace completeness 100%.
- `company_recall`: no required company memories in this Phase 2 manifest; selected 0 extras, trace completeness 100%.
- Runtime: 594 ms for 30 scenarios. Timeout/fail-open count: 0 in every mode.
- Hard negatives passed: P2-02, P2-06, and P2-28 selected no bootstrap memories and selected only the expected repo memories in explicit repo recall.

Acceptance status:

- Meets the retrieval-only gate for explicit repo recall: above 70% expected recall and below 25% memory-level false positives.
- Meets trace-completeness and hard-negative checks.
- Bootstrap stayed conservative: median selected count 0 and no high-risk false positives on P2-02, P2-06, or P2-28.

Remaining risks:

- Repo recall uses the original PR/source artifact from the replay manifest as `exact_identifier` evidence. This is a general channel from the Retrieval Overhaul Plan and does not use memory IDs or Cycloid-only scenario names, but it is stronger evidence than a fresh unlinked user prompt would have.
- A prompt-only audit with replay source identifiers disabled reached 28/50 repo recall (56.0%) and 28/35 precision (80.0%). That clears the false-positive target but not the 70% recall target, so future work should improve path/symbol/error extraction before relying on prompt-only recall for live sessions.
- Bootstrap recall is intentionally conservative in this run; live prompt-start behavior still needs separate measurement before increasing bootstrap recall.
- The harness is retrieval-only. It proves selection quality against the Phase 2 corpus, not whether an agent will use the returned memory correctly in a live implementation session.

## Phase 2 Live Slack Rerun - 2026-06-19

This rerun used the local Slack path rather than the eval script:

- Slack trigger: `#shiv-testing` / `C0B868WEA3B` with `@Cycloid (DEV)`.
- Canonical workflow: `docs/slack-testing.md#browser-use-live-session-runs`.
- Local API/UI ports: API `3036`, UI `5209`.
- Local memory clone: `.tmp/prod-memory-local-clone-20260619T112206Z`.
- Run artifacts: `.tmp/phase2-live-run-20260619-072313/`.
- Session map: `.tmp/phase2-live-run-20260619-072313/session-map.json`.
- Final rollup: `.tmp/phase2-live-run-20260619-072313/final-rollup.md` and `.tmp/phase2-live-run-20260619-072313/final-rollup.json`.
- Concurrency: 30 Slack sessions were kicked off quickly from the browser-use Slack session. Subagent collection was capped at 6 active agents, so result collection recycled workers in batches.

Aggregate result:

- 30 Phase 2 sessions launched through Slack.
- 27 sessions reached `session_completions` rows.
- 24 completed successfully and 3 failed.
- 10 completion rows had PR URLs.
- 1 session failed to start: P2-21.
- 2 sessions remained without completion rows after repeated polling and worker collection: P2-23 and P2-27.
- Last successful full memory capture found 52 `memory_usage_events` rows across 23 sessions.

PRs created by the Phase 2 sessions:

- P2-03: `https://github.com/trycycloid/cycloid/pull/5154`
- P2-04: `https://github.com/trycycloid/cycloid/pull/5159`
- P2-06: `https://github.com/trycycloid/cycloid/pull/5160`
- P2-08: `https://github.com/trycycloid/cycloid/pull/5157`
- P2-12: `https://github.com/trycycloid/cycloid/pull/5158`
- P2-18: `https://github.com/trycycloid/cycloid/pull/5162`
- P2-20: `https://github.com/trycycloid/cycloid/pull/5168`
- P2-22: `https://github.com/trycycloid/cycloid/pull/5166`
- P2-24: `https://github.com/trycycloid/cycloid/pull/5155`
- P2-25: `https://github.com/trycycloid/cycloid/pull/5169`

Run caveats:

- P2-28 is compromised because the first trigger did not start a session and the reposted Slack prompt was still truncated.
- P2-08 PR `#5157` was accidentally closed by one result-collection worker. Later worker prompts explicitly prohibited GitHub and Slack mutations.
- P2-22 and P2-25 were nonterminal at the first final-rollup cutoff, but later D1 completion queries showed their PRs.
- D1 occasionally returned transient `SQLITE_BUSY` during result export under live-session load; retrying the same read succeeded.
- Several sessions have stale `session_index.runtime_state = running` even when `session_completions` and exports show terminal results. Treat completion/export state as the authority for this run.

### Scenario Walkthrough

- P2-01: Completed no-change. Expected memory missed after duplicate rejection; related memories were harmless.
- P2-02: Completed no-change. Expected memory returned.
- P2-03: Published PR `#5154`. Expected memories returned.
- P2-04: Published PR `#5159` after retry. Expected memories returned.
- P2-05: Design/no-change response. Relevant repo memory returned; bootstrap extras were mostly unrelated.
- P2-06: Published PR `#5160`. Expected repo recall missed; unrelated company memory surfaced.
- P2-07: Failed from stream/disconnect, but expected memories had been recalled before failure.
- P2-08: Published PR `#5157`. Expected memory missed; PR was later closed by worker error.
- P2-09: Completed no-change. Expected memory missed.
- P2-10: Completed no-change. Expected memory missed.
- P2-11: Outer session failed with a child PR outside the mapped P2 session. Expected memories missed.
- P2-12: Published PR `#5158`. Expected memory missed; adjacent dogfood memories returned.
- P2-13: Completed no-change. Expected memories returned.
- P2-14: Failed from `CodexStreamError`. Expected memories missed.
- P2-15: Completed no-change. Expected memories returned.
- P2-16: Completed no-change. Expected memory was rejected as `no_expected_action_change`.
- P2-17: Completed no-change. Expected memories returned.
- P2-18: Published PR `#5162`. Expected memory missed.
- P2-19: Completed no-PR. Expected memories missed.
- P2-20: Published PR `#5168`. Expected memory returned.
- P2-21: Failed no-start; session row existed but `runtime_state` stayed null and no memory usage rows were recorded.
- P2-22: Published PR `#5166` after the initial cutoff. Worker evidence before completion showed unrelated bootstrap memory only.
- P2-23: Remained running/nonterminal at cutoff. Expected memories missed and an unrelated extra memory surfaced.
- P2-24: Published PR `#5155`. Expected memories returned.
- P2-25: Published PR `#5169` after the initial cutoff. Worker evidence before completion showed expected memory missed.
- P2-26: Completed no-change. Expected memory missed.
- P2-27: Remained running/nonterminal at cutoff. Expected memories missed.
- P2-28: Completed no-change with a truncated prompt. Expected memories missed; result should not be used as a clean retrieval datapoint.
- P2-29: Completed no-change. Expected memories missed.
- P2-30: Completed no-change. Expected memory missed.

### Memory Quality Readout

Expected-memory hits in the live pass:

- P2-02, P2-03, P2-04, P2-05, P2-07, P2-13, P2-15, P2-17, P2-20, P2-24.

Expected-memory misses or compromised cases:

- P2-01, P2-06, P2-08, P2-09, P2-10, P2-11, P2-12, P2-14, P2-16, P2-18, P2-19, P2-21, P2-22, P2-23, P2-25, P2-26, P2-27, P2-28, P2-29, P2-30.

Interpretation:

- The retrieval-only replay cleared the gate, but live Slack behavior did not preserve that quality. Live explicit recall often missed the expected repo memories, especially when the fresh prompt lacked the replay-only source identifier channel.
- Bootstrap stayed noisy in live sessions: unrelated company memories appeared in multiple misses, including P2-06, P2-18, P2-19, P2-23, P2-25, P2-26, and P2-27.
- The best live outcomes came from scenarios with strong task anchors or direct file/path overlap, such as P2-03, P2-04, P2-13, P2-15, P2-17, P2-20, and P2-24.
- No-start, stream errors, prompt truncation, and stale runtime projections made live scoring materially noisier than retrieval-only scoring.

### Follow-Up From Live Rerun

- Improve prompt-only repo recall before relying on the live path. The retrieval-only run with source identifiers hit 100%, but the prompt-only audit only reached 56%, and the live pass behaved closer to the prompt-only weakness.
- Add stronger path, symbol, error-name, PR-number, and subsystem extraction from the live Slack prompt and early repository scan.
- Keep bootstrap conservative, or add stricter task-anchor gates before injecting company memories into implementation prompts.
- Make the live collection tooling non-mutating by default. PR cleanup should be a separate explicit step after scoring.
- Add a browser-use posting guard that verifies the full prompt text was accepted by Slack before clicking send.
- Add retry wrappers for D1 result export and prefer `session_completions` plus session export over `session_index.runtime_state` for terminal status.

## Phase 2 Live Rerun With Bootstrap Disabled

Date: 2026-06-19.

Artifacts:

- Initial live batch: `.tmp/phase2-live-run-20260619-110103/`.
- Clean rerun 1: `.tmp/phase2-live-clean-rerun-20260619-112529/`.
- Clean rerun 2: `.tmp/phase2-live-clean-rerun2-20260619-113416/`.
- Computed stats: `.tmp/phase2-live-clean-rerun2-20260619-113416/memory-stats.json`.

Scope:

- Bootstrap was disabled.
- Explicit `recall` and `company_recall` usage rows were scored.
- Completed scenarios were preserved and not rerun.
- P2-22 and P2-29 were abandoned as damaged after repeated `sandbox_disconnected` / zero-memory rerun behavior.
- P2-23, P2-25, and P2-27 completed but had zero memory rows, so they count as execution-complete but not recall-observable.

### Normalized Metrics

Previous live baseline:

| Set                    | Scenarios | Expected IDs | Selected IDs | Expected hits | Expected recall | Precision | False-positive rate |
| ---------------------- | --------: | -----------: | -----------: | ------------: | --------------: | --------: | ------------------: |
| Phase 2 prior live run |        30 |           50 |          114 |            15 |           30.0% |     13.2% |               86.8% |

Current rerun, completed scenarios only:

| Path                     | Scenarios | Expected IDs | Selected IDs | Expected hits | Expected recall | Precision | False-positive rate |
| ------------------------ | --------: | -----------: | -----------: | ------------: | --------------: | --------: | ------------------: |
| Combined explicit memory |        28 |           45 |           50 |            16 |           35.6% |     32.0% |               68.0% |
| `recall` path            |        28 |           45 |           41 |            16 |           35.6% |     39.0% |               61.0% |
| `company_recall` path    |        28 |           45 |            9 |             0 |            0.0% |      0.0% |              100.0% |

Current rerun, recall-observable completed scenarios only:

| Path                     | Scenarios | Expected IDs | Selected IDs | Expected hits | Expected recall | Precision | False-positive rate |
| ------------------------ | --------: | -----------: | -----------: | ------------: | --------------: | --------: | ------------------: |
| Combined explicit memory |        16 |           27 |           50 |            16 |           59.3% |     32.0% |               68.0% |
| `recall` path            |        16 |           27 |           41 |            16 |           59.3% |     39.0% |               61.0% |
| `company_recall` path    |        16 |           27 |            9 |             0 |            0.0% |      0.0% |              100.0% |

Impact-based rescore of selected memory rows:

| Path                     | Selected rows | Useful | Neutral | Bad | Unknown |
| ------------------------ | ------------: | -----: | ------: | --: | ------: |
| Combined explicit memory |            50 |     18 |      19 |   7 |       6 |
| `recall` path            |            41 |     18 |      16 |   4 |       3 |
| `company_recall` path    |             9 |      0 |       3 |   3 |       3 |

Impact false-positive variants:

| Path                     | Known rows | Neutral + bad FP rate | Bad-only FP rate |
| ------------------------ | ---------: | --------------------: | ---------------: |
| Combined explicit memory |         44 |                 59.1% |            15.9% |
| `recall` path            |         38 |                 52.6% |            10.5% |
| `company_recall` path    |          6 |                100.0% |            50.0% |

Interpretation:

- Strict selected-ID false positives improved materially: strict extra-ID rate dropped from 86.8% to 68.0% on completed scenarios.
- Strict precision more than doubled: 13.2% to 32.0% combined, and 39.0% for the `recall` path alone.
- Under the impact definition, the better live signal is 59.1% neutral-plus-bad FP and 15.9% bad-only FP combined; for `recall` alone, 52.6% neutral-plus-bad FP and 10.5% bad-only FP.
- Expected recall barely improved on the full completed set: 30.0% to 35.6%.
- On sessions where memory actually surfaced, expected recall was much better at 59.3%, but precision remained weak because extras were still common.
- The biggest remaining failure mode is not only wrong memories; it is no memory usage at all. Twelve completed scenarios had zero memory rows.
- Going forward, strict expected-ID metrics are retrieval diagnostics. Product false-positive reporting should use both impact variants: neutral-plus-bad and bad-only.

### Per-Scenario Memory Hits

Expected memories hit:

- P2-01: `mem_pr_5100_add_1`.
- P2-04: `mem_pr_4992_add_1`, `mem_pr_4992_add_2`.
- P2-06: `mem_pr_4970_add_1`, `mem_pr_4970_add_2`.
- P2-07: `mem_pr_4969_add_1`.
- P2-11: `mem_pr_4946_add_1`, `mem_pr_4946_add_2`.
- P2-14: `mem_pr_4912_add_1`; missed `mem_pr_4912_add_2`.
- P2-15: `mem_pr_4907_add_1`, `mem_pr_4907_add_2`.
- P2-18: `mem_pr_4899_add_2`.
- P2-19: `mem_pr_4894_add_1`, `mem_pr_4894_add_2`.
- P2-20: `mem_pr_4890_add_1`.
- P2-21: `mem_pr_4889_add_2`; missed `mem_pr_4889_add_1` and `mem_pr_4889_add_3`.
- P2-28 had memory rows, but missed both expected Slack-thread-ingestion memories.

Completed with zero memory rows:

- P2-02, P2-05, P2-08, P2-09, P2-12, P2-13, P2-17, P2-23, P2-24, P2-25, P2-26, P2-27.

Unresolved/damaged:

- P2-22 failed twice with `sandbox_disconnected`. One failed attempt had one non-expected recall row; the rerun had zero memory rows.
- P2-29 failed once with `sandbox_disconnected`; the rerun stayed running with zero memory rows and was abandoned.

### Diagnosis

- Disabling bootstrap reduced selected memory volume and therefore improved strict precision.
- Explicit recall still depends heavily on whether the live agent calls recall with useful task anchors. When recall is not called, the improved selector cannot help.
- `company_recall` remains pure noise for this repo-memory manifest. It selected nine rows and no expected IDs.
- Several old or damaged sessions continued emitting telemetry after their E2B sandbox was killed. Live testing should kill stale sandboxes and then verify no old session IDs are still sending callbacks before launching the next wave.
- The next improvement should focus on making live explicit recall more reliably anchored: pass path, symbol, PR number, error name, and subsystem evidence into recall calls, then keep the stricter selector.
