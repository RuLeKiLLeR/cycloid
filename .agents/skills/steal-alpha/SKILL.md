---
name: steal-alpha
description: Mine idea-content (tweets/threads, essays, talks, changelog notes, screenshots) for insights Cycloid should adopt, cross-reference each idea against the current codebase, and produce a ranked, evidence-backed "steal this / already have it / skip it" report. Findings accumulate in a persistent alpha ledger so repeated runs compound - recurring ideas across independent sources get upgraded, settled ideas don't get re-litigated. Sibling to competitor-teardown - that one diffs competitor products, this one diffs ideas. Use when Josiah drops one or more links or screenshots and asks what we can take from them.
user_invocable: true
argument: one or more URLs (tweet/essay/thread/talk), pasted text, or screenshots to mine; optionally a lens ("focus on onboarding") or a ship directive ("and ship the top one"); e.g. "https://x.com/neilrahilly/status/... what can we steal"
---

# Steal alpha

Turn idea-content into a ranked, evidence-backed list of things Cycloid should adopt. Output: for each idea, where we stand today (cited in code), the concrete change to make, and a cost/signal verdict. This is a research + writing workflow - the only files it edits are the alpha ledger (and skill fixes per own-your-tooling); never product code.

Ground every claim in evidence: a quote from the source or a `file:line` in our repo. An idea with no analog in our code and no concrete change is not alpha - drop it. Do not inflate a truism ("ship fast", "listen to users") into a finding; only surface ideas that imply a specific change to a specific surface.

## Input

`$ARGUMENTS` is one or more URLs, pasted text, or screenshot references. It may also carry a lens ("what can we steal for onboarding", "focus on agent UX") - honor it and weight findings toward that surface - and/or a ship directive ("and ship the top one", "ticket the steals") - see Handoff.

- **Multiple sources:** run steps 1-2 per source (parallel where possible), then merge into one claim pool before cross-referencing, attributing each claim to its source. One report, not N.
- **Routing:** if a link is a competitor's changelog, product page, or launch post, that is `competitor-teardown`'s job - say so and offer to run it instead (or alongside, if the same drop also contains genuine idea-content).

## Steps

1. **Get the content verbatim.**
   - **X/Twitter:** `WebFetch` fails (HTTP 402 to bots). Use fxtwitter instead. For a thread (or when unsure), `curl -s "https://api.fxtwitter.com/2/thread/<id>"` returns the linked post plus the unrolled thread when available (`status`, `thread` list, `author`). For a single post, `curl -s "https://api.fxtwitter.com/<user>/status/<id>"` (`tweet.text`, `tweet.author`, quoted tweet under `tweet.quote`). Only if the thread comes back incomplete ask Josiah for the remaining posts rather than guessing.
   - **Everything else:** try `WebFetch`. If paywalls or auth walls block it, do NOT reconstruct the content from the author's reputation. Stop and ask Josiah to paste the text or drop a screenshot (screenshots you read directly). Getting the real words matters more than looking fast: a fabricated "insight" from a post you never read is worse than a one-line "paste it and I'll mine it." If a talk/video, ask for a transcript or the key slides.

2. **Extract the raw claims.** Pull out every distinct assertion, opinion, or design choice - not a summary. Tag each: is it a _product/UX_ idea (a surface, flow, or capability), a _technical_ idea (an architecture, model, or eval choice), or a _positioning/GTM/process_ idea (how they sell, onboard, or run the team)? Keep the author's framing; note who they are and why they'd have signal on this (e.g. ex-Mixpanel product, Sierra agents) - it calibrates confidence, it does not substitute for the actual claim.

3. **Check the ledger.** Read `docs/competitive-research/alpha-ledger.md` (create it on first run). For each extracted claim:
   - **Already verdicted, code unlikely to have changed:** reuse the prior verdict and evidence; add this source to its `sources:` line and bump recurrence. Don't re-run the cross-reference.
   - **Recurring:** the same idea arriving from independent credible sources is itself signal. On the 2nd-3rd independent source, re-examine - including previously SKIPped ideas; recurrence can flip a SKIP to a STEAL or raise a STEAL's rank.
   - **New:** proceed to step 4.
     The ledger is memory, not authority - if our code has plausibly changed since an entry was written, re-verify before reusing it.

4. **Cross-reference against our code.** For each new or re-opened claim, launch parallel `Explore` agents to find where Cycloid stands today, with `file:line` evidence. Reuse the standing dimensions from competitor-teardown when the idea touches them (triggers/integrations, harnesses/backends/models, sandbox/environment, governance/lifecycle) - see `.claude/skills/competitor-teardown/SKILL.md`. For idea-content the extra dimensions that come up most:
   - **Agent UX & product surface** - session UI, event stream, PR-as-user flow, review loop, Slack/CLI/web surfaces (`apps/ui/**`, `docs/lifecycle.md`, `docs/review-loop.md`).
   - **Onboarding, activation, retention** - first-run, access, feature gating (`docs/onboarding-checklist.md`, `docs/user-access.md`, `docs/feature-gating.md`).
   - **Evals, prompts, agent behavior** - prompt layers, post-execution, success SLOs (`docs/prompt-agents.md`, `docs/prompt-post-execution.md`).

5. **Verdict each idea.** Map every stealable idea to one of:
   - **STEAL** - we don't do this (or do it worse); name the concrete change and the surface it touches.
   - **HAVE** - we already do this; cite the `file:line` (still useful - it confirms the thesis and can sharpen positioning).
   - **SKIP** - not applicable, truism, or too costly for the signal; give the one-line reason.
     Apply the repo's Worth-it Gate to every STEAL: `build` / `build-smaller` / `don't-build`, priced by cheapest-path-to-signal for speculative work. A STEAL with no cheap probe is a `don't-build`, not a backlog item.

6. **Rank.** Order STEALs by (signal or upside) / (cost), highest first, with recurrence across independent sources as an upweight. Lead the report with the top 1-3 - the ones actually worth doing this week - not an exhaustive dump.

7. **Update the ledger.** Append new entries and update touched ones in `docs/competitive-research/alpha-ledger.md`. One entry per idea (not per source):

   ```
   ## <idea slug>
   - verdict: STEAL (<gate token>) | HAVE | SKIP
   - status: open | ticketed <LIN-###> | shipped <PR#> | rejected
   - change: <one-line concrete change and surface>
   - evidence: <file:line or "no analog">
   - sources: <url or handle> (<yyyy-mm-dd>)[, ...]
   ```

   In a local checkout, keep the ledger update a working-tree edit - do not open a PR per run; Josiah lands accumulated ledger changes periodically as one PR. In a Cycloid-run session there is no working-tree-only mode (the bridge publishes committed changes), so include the ledger update in that session's PR instead. When a STEAL gets ticketed or shipped (this run or noticed later), update its `status:` instead of adding a duplicate.

## Output: ranked findings report

Structure:

- **One-line source read** (per source) - what it is, who wrote it, the through-line.
- **Steal this (ranked)** - per idea: the quote, where we stand (`file:line` or "no analog"), the concrete change, the Worth-it verdict + token. Mark recurring ideas with their source count ("3rd independent source").
- **Already have it** - short list with `file:line`, so the thesis is confirmed and we don't re-litigate.
- **Skip** - one line each, so Josiah sees they were considered and rejected, not missed.
- **Previously settled** - one line naming ideas matched to existing ledger entries, so the report shows dedup happened.

Keep it terse and scannable. Plain hyphens, sentence case, code over prose.

## Handoff

Default: end by asking whether to turn the top STEALs into Linear tickets, a Slack post, or a build - do not do it unsolicited. But if the invocation already carried a ship directive ("and ship the top one", "ticket everything worth it"), skip the ask: hand the top STEAL to `ship-stack` and update that ledger entry's `status:`, or file the Linear tickets for all qualifying STEALs and update those ledger entries' `status:`, before finishing. A ship directive only covers STEALs whose Worth-it verdict is `build` or `build-smaller`; a `don't-build` STEAL is never auto-shipped or auto-ticketed - report it and let Josiah decide.

## Guardrails

- No source, no findings. If step 1 fails and Josiah hasn't pasted anything, the correct output is the one-line ask, not invented alpha.
- Confidence rides on evidence. Label anything derived from a screenshot fragment, a paraphrase, or the author's reputation (rather than their actual words) as lower confidence.
- Don't overfit to a personality. A sharp post from a credible operator is a hypothesis about our product, not a mandate - the code cross-reference is what promotes it to a finding.
- The ledger dedups and weights; it never substitutes for evidence. A recurring idea still needs the code cross-reference before its verdict changes.
