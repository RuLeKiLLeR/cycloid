# Daily Dev Changelog — Design

2026-06-11. Status: approved direction, pending spec review.

## Goal

A daily, TLDR-style changelog of what merged in `trycycloid/cycloid`, posted to a Slack channel at 6am ET every day, written in plain language a smart high-schooler could follow. Purpose: every dev knows what changed in parts of the product they don't work on, in under a minute of reading (with optional depth).

## Decisions (settled)

- **Channel:** new dedicated Slack channel `#changelog`. Email is out of scope (phase 2 at most).
- **Cadence:** daily cron at 09:37 UTC (2026-06-14 amendment: daily, was weekday-only; 2026-06-12 amendment: 09:37, was 10:00). GitHub cron is best-effort and queues runs late — the first scheduled run fired 82 min after the hour — and minute 0 is the most congested slot, so the cron sits earlier and off-peak; posts land ~6am ET. GitHub Actions cron is UTC-only, no DST handling. Every issue covers the previous 24h.
- **No human gate:** posts go out unedited. Slack is low-stakes; corrections happen in thread. Thread replies/reactions are the feedback loop for prompt iteration.
- **Vehicle: GitHub Action**, not a Cycloid automation-schedule session. A session's output is a PR needing a daily merge (a chore, and we don't auto-merge); an Action posts to Slack directly, versions its prompt in the repo, and we already run scheduled Actions.
- **No repo archive of issues.** Slack history is the archive. Revisit if anyone misses it.
- **Quiet days still post, via the same LLM call.** If the filter leaves nothing substantive, the day's filtered-out merges (docs, bots, dep bumps) are passed to the model instead, so the post is an honest short note ("Quiet day — just doc updates and dep bumps, #x #y") rather than a canned line. Consistency keeps the habit loop (research: inconsistent issues kill trust/readership).
- **Kill criterion:** review after ~4 weeks of issues. If posts get no replies/reactions and nobody objects to a pause test, rework or stop.

## Architecture

```
.github/workflows/daily-changelog.yml   cron: 37 9 * * *  (+ workflow_dispatch with dry_run input)
  └─ scripts/daily-changelog/index.mjs
       1. collect   gh pr list --state merged, window = 24h anchored to 09:37 UTC
       2. filter    deterministic, no LLM (see below)
       3. summarize one Claude API call, structured output
       4. render    JSON -> Slack Block Kit
       5. post      Slack incoming webhook for #changelog
```

Secrets (GitHub Actions): `ANTHROPIC_API_KEY`, `CHANGELOG_SLACK_WEBHOOK_URL`. `GITHUB_TOKEN` (built-in) for `gh`. Independent of the product's Slack app credentials by design — a webhook can't touch anything else.

### 1. Collect

`gh pr list --repo trycycloid/cycloid --state merged --search "merged:>=<window-start>" --json number,title,body,author,files,labels`. The window is half-open `[start, end)`, anchored to fixed 09:37 UTC boundaries rather than the run time (2026-06-12 amendment): cron jitter would otherwise create coverage gaps or duplicates between consecutive issues. PRs merged between the anchor and a delayed run land in the next issue. A failed run drops its window — acceptable; Action failures notify on GitHub. Volume baseline: ~32 merged PRs/day pre-filter, ~15–20 after.

### 2. Filter (deterministic, unit-tested)

- Drop bot authors: `app/detail-app`, `app/cycloid`.
- Drop docs-only PRs (every changed file under `docs/` or `*.md`).
- Strip known boilerplate sections from bodies by marker (CodeRabbit summaries, Codesmith sections) — present in 55–71% of PRs and pure noise for the model.
- Truncate each remaining body to ~4,000 chars.
- No significance judgment here — grouping and ranking belong to the model. Stacked-PR dedup (`[i/N]` titles) is also left to the model via a prompt instruction ("treat stacked PRs as one change").

Expected input to the LLM: ~15–25K tokens/day. Fits one call with huge margin.

### 3. Summarize (the Claude call)

- **Model:** `claude-opus-4-8` (adaptive thinking, `@anthropic-ai/sdk`). Model quality dominates changelog quality (Ubicloud's scored comparison: Opus 7–8/10 vs o3 3/10 on identical input). Cost ≈ $0.15/day ≈ $4/month — not worth economizing.
- **Structured output:** `output_config.format` with this schema, so rendering is deterministic:

```jsonc
{
  "tldr": ["..."], // 3-5 bullets, the 60-second layer
  "highlights": [
    // 1-3 max (Linear's rule)
    { "title": "...", "body": "...", "why_it_matters": "...", "pr_numbers": [1] },
  ],
  "heads_up": [
    // 0-3: breaking changes, migrations, cross-feature interactions
    { "text": "...", "pr_numbers": [1] },
  ],
  "also_merged": [
    // coverage ledger for everything else; generated but not posted (2026-06-11 amendment)
    { "text": "...", "pr_numbers": [1] },
  ],
}
```

- **Prompt context:** the filtered PR list + `docs/changelog-glossary.md` — a new, maintained one-line-per-concept glossary (control plane, bridge, review loop, automation schedules, memory PRs, …) so plain-language translation stays accurate. Seeded from `docs/what-is-cycloid.md` / `docs/codebase-map.md`; the prompt file itself lives at `scripts/daily-changelog/prompt.md` and is versioned like code.
- **Style rules in the prompt:** write for a smart high-schooler; no unexplained jargon — define internal names on first use using the glossary; "before this X, now Y" framing; one "why it matters" line per highlight; every claim cites PR number(s); honest about regressions/reverts; treat `[i/N]` stacks as one change; if a change interacts with another feature ("X now affects how Y behaves"), say so in `heads_up`.
- **Hallucination guard:** the renderer drops any item whose `pr_numbers` aren't in the input set — a claim that can't cite a real PR from the window never reaches Slack.

### 4–5. Render and post

JSON → Slack Block Kit: header with date + PR count, TLDR bullets, divider, highlights, ⚠️ heads-up section, 🏆 dogfood leaderboard. The `also_merged` ledger is not rendered (2026-06-11 amendment: the small-text tail added noise without readership value). Target ≤ ~250 words rendered (research: readership drops ~20% per extra 500 words). Post via webhook; on Slack 5xx retry once.

**Dogfood leaderboard (2026-06-11 amendment):** a deterministic trailing section counting Cycloid-published PRs merged in the window per cycloid-biz member (provenance markers in raw PR bodies identify Cycloid PRs; PRs publish as the requesting user). Every member is listed, zeroes included, sorted by count — to encourage dogfooding. Member list is a constant in `scripts/daily-changelog/dogfood.mjs`, kept in sync manually.

## Failure handling

- Action failure (gh, API, Slack) → workflow fails, GitHub notifies. No silent skip.
- Claude API error → one SDK retry (built-in), then fail the run.
- Structured-output parse failure → fail the run (schema-validated by the SDK, so effectively unreachable).
- Missed run → next run does not backfill beyond its window. Accepted.

## Verification (same PR)

- Vitest unit tests for filter, boilerplate-strip, window computation, and the renderer's PR-number guard.
- `node scripts/daily-changelog/index.mjs --dry-run` prints the rendered message instead of posting; run locally against real `gh` data and eyeball 2–3 days of output.
- One `workflow_dispatch` run posting to `#changelog` as the live test before the cron is trusted.

## Out of scope / phase 2

- Email delivery (Google Group + simple send) — only if Slack proves insufficient.
- Repo archive of issues, weekly roundup edition.
- Author-supplied "reader impact" PR-template field — add only if inferred interaction content proves thin after a few weeks.
