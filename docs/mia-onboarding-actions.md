# Mia onboarding: action items

Everything from the `#cycloid-onboarding-mia-labs-repo` channel, pulled into themes. Test repo: [trycycloid/mia-copy](https://github.com/trycycloid/mia-copy).

How to read it:

- Not done up top, dropped (decided against) in the middle, done at the bottom.
- Themes first, then ARC tickets. Inside a theme, lowest to highest effort.
- Each item: **Proof** (already shipped?), **Complexity** (🧩, XS 1 to XL 5), **Claude's verdict** (build or not).

Proof checked against a real code audit of cycloid PRs since Mon 6/01. ✅ done · ◐ partway · ✗ nothing yet.

> **Where we are:** 22 done or resolved, 9 dropped, 1 partway, 2 calls to make. 7 of the "done" were closed without new work: 3 already covered by shipped PRs, 4 confirmed not needed after investigation. The cheap verification fixes mostly landed (the optimistic publish resolver in #3841/#3844 made screenshots advisory and killed a bunch of false "inconclusive" cases). The big build (ARC-1108) is still open; ARC-1110 is dropped for now.
> **Heads up:** every sandbox/template fix needs an E2B template rebuild to go live; most are not yet tested in a real session. "Done" means merged, not proven.

---

# Not done

## Themes

### Verification & review loop

### PR publishing & metadata

- [ ] 🟡 **Say why a PR is a draft** _(partway)_ · 🧩 **S (2/5)** — put the real reason in the body.
  - Owner: **kv** done with https://github.com/trycycloid/cycloid/pull/3956
  - Proof: ◐ #3832 adds a "Why Inconclusive" section, but it's keyed on the verdict, not the verify-regex skip path.
  - Claude verdict: **BUILD** — small, just wire the skip reason into the field that's already there.

### Decisions to make

- [ ] ❓ **Toolchain source of truth: our template vs their Dockerfile** · 🧩 **XS (1/5) to decide.**
  - Owner: no owner
  - Proof: ✗ never written down. #3871/#3768 already expanded our shared template, so we're de-facto on "our template."
  - Claude verdict: **DECIDE** — ratify "our template," write one line, close it.

## Tickets

- [ ] 🔴 **ARC-1108: a complex prod repo with a broad e2e eval set** · 🧩 **XL (5/5)** — cover every vertical (UI, backend, infra, prompt, DB, scheduler).
  - Owner: no owner
  - Proof: ✗ nothing built.
  - Claude verdict: **BUILD, but scope it down** — an eval set makes every other fix measurable; right now we're shipping blind. Start with a few real tasks per vertical, not the whole thing.

---

# Dropped

Items where Claude's verdict was drop (including "mostly DROP" / "DROP / defer" / "DROP for now"). Decisions not to build, not pending work. Full proof and context kept inline.

## Themes

### Verification & review loop

- 🔴 **`.cycloid/verify/baseline.md` verification contract** · 🧩 **M (3/5)** — per-repo file the agent checks before handoff.
  - Proof: ✗ doesn't exist. Only `baseline` refs are screenshot capture.
  - Claude verdict: **DROP** — a new file plus a parser is the same staleness trap as AGENTS.md. Fold into ARC-1110 if ever built.
- 🔴 **Screenshot route inference (stop hitting fake routes)** · 🧩 **L (4/5)** — map a changed frontend file to the URL it renders, screenshot that.
  - Why: the route finder navigates to routes that don't exist, and the failure note doesn't match the screenshot it took (PR #83).
  - Proof: obsolete — the post-idle screenshot route inference code has been removed.
  - Claude verdict: **DROP** — screenshots are advisory now (#3844), payoff gone. At most, hide the misleading "wrong route" note.

### PR publishing & metadata

- 🟡 **Let Cycloid set its own PR title** _(partway)_ · 🧩 **M (3/5)** — so the loop can fix a bad title (`gh pr edit` is blocked in the loop).
  - Proof: ◐ #3904 reconciles the title on republish, with human-rename-wins. But the title is _resolved_ by us; the agent can't deliberately set a CI-passing one.
  - Claude verdict: **SIMPLIFY, mostly DROP** — get the title right at creation (ticket-prefix item under Not done) and let #3904 reconcile. Don't build an agent edit channel.
- 🔴 **Use the repo's PR template** · 🧩 **M (3/5)** — read `.github/PULL_REQUEST_TEMPLATE`, only append our sections.
  - Proof: ✗ we use our own `DEFAULT_PR_TEMPLATE`, never read theirs.
  - Claude verdict: **DROP / defer** — no sign Mia cares about body format (they care about the title gate). Wait for a customer ask.

### Sandbox & infra

- 🔴 **Use a non-default verify port (8000 → 18000)** · 🧩 **S (2/5)** — avoid clashes.
  - Proof: ✗ no verify-port setting anywhere. Only `ARCANIST_PREVIEW_PORT` (preview, untouched).
  - Claude verdict: **DROP** — a hunch, not a real collision. Do it when one happens.
- 🔴 **Bug: template updates churn live sessions** · 🧩 **L (4/5)** — a new template should only apply to new sessions.
  - Proof: ✗ nothing pins existing sessions; template PRs rebuild the shared image.
  - Claude verdict: **DROP** — our own rule is "OK to break in-flight sessions on deploy." Version-pinning is real complexity against a problem we accept. Revisit when we have an SLA.
- 🟡 **Multiple sandbox templates** _(partway)_ · 🧩 **L (4/5)** — separate per-repo image.
  - Proof: ◐ #3864 added per-repo resource tiers (`mem{MB}-cpu{N}`), but every repo still shares one Dockerfile.
  - Claude verdict: **DROP / defer** — shared template plus resource tiers is enough. Per-repo image pipeline is heavy infra, only worth it once a repo's toolchain actually conflicts.

### Customer repo config

- 🔴 **`CYCLOID.md`: precedence lookup + generate it from the customer's rules at onboarding** · 🧩 **L (4/5)** — one Cycloid-owned instructions file the agent reads, built from the customer's conventions (precedence loader + onboarding generator + Cursor-rules ingestion).
  - Proof: ◐ the loader shipped (#3959) then was reverted; the generator never merged (PR #3979 closed). `docs/cycloid-md-generation.md` removed.
  - Claude verdict: **DROP** — mia-copy already worked via a hand-committed `CYCLOID.md`, so the loader bought nothing, and the generalized generator is a per-format staleness trap. Codex reads `AGENTS.md`/`CLAUDE.md` natively and opens nested files on demand; no Cycloid-owned instruction-file machinery in the middle.

## Tickets

- 🔴 **ARC-1110: a QA Tester agent that runs next to the implementation agent** · 🧩 **XL (5/5)** — the big structural build.
  - What: a dedicated QA Tester agent running before the review loop that also fixes the PR body and title and works on any repo. Near-term stand-in: a small verification-fixing loop. Long-term: a Devin-style QA tester. A 34KB ref doc exists but is incomplete and stale.
  - Proof: ✗ nothing built. The inline verification placeholder was removed; implementation sessions now omit the verification payload entirely.
  - Claude verdict: **DROP for now** — this week's cheap fixes drained most of the pain. Build the small verification-fixing loop; hold the XL agent until eval data proves the need.

---

# Done

## Themes

### Verification & review loop

- [x] ✅ **Accept equivalent verify commands, not just an exact prefix** — `uv run python …/migrations/hooks/validate_history.py` failed because we only accepted the `db-history-validate` prefix.
  - Proof: ✅ #3867 added the regex to `DATA_PROOF_COMMAND_PATTERNS` with tests. Also #3888, #3820. ([mia-copy #44](https://github.com/trycycloid/mia-copy/pull/44).)
- [x] ✅ **UI is conclusive on 1+ screenshot, before/after dropped** — UI PRs kept getting flagged even when fine.
  - Proof: ✅ #3841 + #3844. New optimistic resolver is confirmed unless something actually goes wrong; screenshots advisory. Confirmed live on open PR #3906.
- [x] ✅ **A test that failed then passed no longer counts as failed**
  - Proof: ✅ #3844 only drafts on a failure that ran after the last edit and wasn't recovered.
- [x] ✅ **Right test command per component** — we were matching python test commands against `.yml` files.
  - Proof: ✅ #3820 classifies test files and per-component commands, dbt `.yml` counts as data.
- [x] ✅ **Killed the "browser artifacts captured → inconclusive" message**
  - Proof: ✅ #3896 (re-merged as #3901) deleted the generic strings.
- [x] ✅ **Run the repo's pre-commit hooks before pushing** — a PR went draft because hooks weren't run ([mia-copy #52](https://github.com/trycycloid/mia-copy/pull/52)).
  - Proof: ✅ #3887 (hardened by #3891, egress by #3895). Installs and runs hooks before the first commit, fails closed. Best-effort if egress is blocked.
- [x] ✅ **Lint no longer causes false inconclusive PRs** — covered by two shipped things: hooks run and fail closed before push; the generic CI-fix path catches a failing lint check by name. No dedicated lint signal needed.
  - Proof: ✅ #3887 (hooks), #3812 (CI-fix path).
- [x] ✅ **Review loop already sees the full PR** _(investigated, not a gap)_ — the loop session checks out the PR branch as its working tree, so the agent can `git diff` and read changed files itself. The prompt not injecting the diff doesn't matter.
  - Proof: ✅ respawn checks out `lastBranch` (`durable-object.ts:10359-10381`); `start-bridge.sh` fetches + checks it out (FETCH_HEAD fallback, commit `62e64a414`); the bridge won't start without a valid worktree (`bridge.ts:560-565`). No build needed.
- [x] ✅ **Detect missing test coverage and nudge** — obsolete in the bridge post-idle path; this verifier code was removed when verification was reduced to configured tests.
  - Proof: obsolete — the old changed-symbol caveat path no longer exists.

### PR publishing & metadata

- [x] ✅ **Stop the verification loop from wrecking the PR summary** — the summary flipped from "I implemented X" to the review-loop run's message ("Addressed the review-loop item…").
  - Proof: ✅ #3957 preserves the implementation `Summary:` block on automated review-loop/CI-fix republishes, gated on `prompt.reviewLoopEpochId` and anchored to the verdict block so a touch-up run can't overwrite it. Flip confirmed in merged PR #3642. Not E2E-tested yet (control-plane change).
- [x] ✅ **Mark Cycloid PRs without using the title** — every Cycloid-created PR gets the durable `cycloid` label.
  - Proof: ✅ #3947 labels session-created, adopted, updated, scheduled, and memory PRs; scheduled PRs keep `cycloid:scheduled` too. Verified deployed with cold session PR #3950, which has the `cycloid` label.
  - Forward note: memory PRs now carry `cycloid:memory`, parallel to scheduled PRs' `cycloid:scheduled`.
- [x] ✅ **Kill the useless pre-publish-test message** — the redacted `"Configured pre-publish test failed… output omitted"` told operators nothing.
  - Proof: ✅ #3934 adds an operator-only, pre-redacted, bounded `failureLogTail` across all three failure branches, logged under the `configured_pre_publish_test_failed` event marker with a Datadog us5 logs deep-link (`buildDatadogLogsUrl`). Customer PR message stays redacted/unchanged. Not E2E-tested yet (bridge change, needs a real session).
- [x] ✅ **Dropped the `[ARC]` title prefix** — it broke Mia's title check.
  - Proof: ✅ #3813. Still used on memory PRs.
- [x] ✅ **Publish watchdog 5m → 20m** — publish was taking ~10m and timing out.
  - Proof: ✅ #3804.
- [x] ✅ **PRs no longer open as draft unexpectedly** _(investigated, resolved)_ — the verify-regex-miss / no-evidence path is gone. The bridge post-idle path no longer runs the non-visual verifier; draft cases come from configured tests, failures, push/publish recovery, or explicit manual-review signals.
  - Proof: obsolete — the old `nonvisual-evidence.ts` path was removed.
- [x] ✅ **Pull the ticket number from the invocation into the title** — ticket key is extracted (LLM-first, then Linear identifier, then leading prompt text) and prefixed onto the PR title at creation.
  - Owner: **shivam** — part of memory.
  - Why: Mia's CI requires `(ENG|TS|DATA|IT)-XXXX` titles. This is the thing blocking their merges.
  - Proof: ✅ #4192 added `ticketKey` extraction to `resolvePrTitle` via `resolveSessionTicketKey`. The session-title LLM returns a `ticketKey` field; fallbacks include Linear integration and bare key leading P0. PRs open with the prefix (born compliant).

### Sandbox & infra

- [x] ✅ **Accept both `type-check` and `typecheck`, no package.json edit** — we'd had to add a script to Mia's package.json.
  - Proof: ✅ already supported, extended by #3820.
- [x] ✅ **Native deps in the template** (`ffmpeg`, `libpq-dev`, `libicu-dev`, `libzstd-dev`, `pkg-config`)
  - Proof: ✅ #3846.
- [x] ✅ **Before/after screenshot startup fixed** — commit `277a427` on mia-copy.
- [x] ✅ **TS typecheck version handled** — pinned TS to 5.9.3 so it won't drift into TS6 deprecation errors (the thing that forced `ignoreDeprecations`).
  - Proof: ✅ #3871. (Reopen only if a TS5-pinned repo actually needs the `ignoreDeprecations` flag.)
- [x] ✅ **Mia CPU headroom** — bumped mia-copy to 4 CPU / 8GB preemptively.
  - Proof: ✅ #3864. (Reopen only if we actually hit a CPU-bound failure.)
- [x] ✅ **Backend toolchain: nothing left to install** _(investigated, not a gap)_ — `dbt` and `az` are both non-gaps. Mia runs dbt only through `uv run` from its locked Python env (no binary needed); `az` was excluded on purpose — Mia uses the Azure SDK, the CLI only shows up in operator flows needing subscription creds a sandbox won't have.
  - Proof: ✅ Mia's dbt is a Python dep (`dag/data/pyproject.toml`), every call is `uv run … dbt …`; repo-owned verification should now live in `.cycloid.json` `verify.test`. #3846's body explicitly excludes Azure CLI. No build needed.
- [x] ✅ **Bug: sandbox restart/reconnect is broken** _(fixed + verified)_ — followups after reviving a session now work; this was the whole reason we moved to e2b, so it was a bad failure mode to leave open.
  - Proof: ✅ #3903 fixed the cold-resume checkout (`git checkout -B <branch> FETCH_HEAD`), #3907 saves the Codex rollout to S3 so context survives. E2E verified by jag (start → stop → cold-resume → send a followup); the prompt field is confirmed working.

### Customer repo config

- [x] ✅ **Module-level AGENTS.md: Codex handles it, not us** _(investigated, not our job)_ — Codex auto-loads the root AGENTS.md and reads nested ones with its normal file tools as it works in a subtree. `docs/bridge.md:246` is accurate; building traversal would fight its design.
  - Proof: ✅ Cycloid only configures Codex's project-doc loader (`codex-session.ts:14-15,82-83`), it doesn't copy files. For stronger nested adherence, the lever is Codex's `child_agents_md` feature flag, not Cycloid code.
- [x] ✅ **Reversed: dropped the `CYCLOID.md` initiative** — originally decided to create a dedicated `CYCLOID.md` (precedence loader + onboarding generator) rather than edit the customer's AGENTS.md in place. Reversed: mia-copy already worked with a hand-committed file so the loader added nothing, and the generator is a per-format staleness trap. Loader (#3959) reverted; generator (#3979) abandoned. Codex reads `AGENTS.md`/`CLAUDE.md` natively. See the dropped item under _Customer repo config_.
  - Originally-accepted trade-off (now moot): CYCLOID.md would be permanent tech debt unless memory kept it fresh.
- [x] ✅ **Repo-owned sandbox setup script (`.cycloid/setup.sh`)** — customers check in a script Cycloid runs at sandbox startup (`npm ci`, `uv sync`, etc.); when present it replaces the npm/pnpm/yarn auto-detect. Sandbox-side only; a failure marker surfaces a non-zero exit/timeout in the UI while still letting the agent run.
  - Proof: ✅ #3946 (`start-bridge.sh` runs it via the existing workspace-setup markers, with credential scrubbing and a 540s timeout); contract in [customer-repo-config.md](customer-repo-config.md). E2E verified: a cold prod session on a repo with `.cycloid/setup.sh` ran the script at startup and the agent observed its output.

### Operations & onboarding

- [x] ✅ **Onboarding runbook** — access, secrets, `.cycloid` files, verify setup.
  - Owner: **kv**
  - Proof: ✅ fixed with https://github.com/trycycloid/cycloid/pull/3970.
- [x] ✅ **`.cycloid` scaffolding on mia-copy** (`.cycloid.json`, `docker-compose.cycloid.yml`, `scripts/cycloid-dev.sh`, `cycloid-auth.ts`, `dev:cycloid`)
- [x] ✅ **`copy-customer-repo` motion** (mia-copy created)

## Tickets

- [x] ✅ **ARC-1114: let agents create and manage Linear tickets, then keep going** — verified in prod.
  - Proof: ✅ #3923 added the `linear.create_issue` dynamic tool (`linear-dynamic-tool.ts`), plus `get_issue` and `list_issue_statuses`. Agent creates a ticket and continues. (No update/edit tool yet, but create + continue is the asked-for motion.)
- [x] ✅ **ARC-1109: run the review loop on every PR, not just drafts** — lint fails, PR opens normally, loop catches and fixes it.
  - Proof: ✅ #3901 removed the draft-skip block, drafts now arm through the normal gates.

---

## Reference: conclusive open mia-copy PRs

UI [#41](https://github.com/trycycloid/mia-copy/pull/41) · BE [#39](https://github.com/trycycloid/mia-copy/pull/39) · infra [#38](https://github.com/trycycloid/mia-copy/pull/38) · docs [#37](https://github.com/trycycloid/mia-copy/pull/37)
