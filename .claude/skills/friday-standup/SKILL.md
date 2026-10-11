---
name: friday-standup
description: Turn a full week of work into a retrospective on the broad themes of how the user made the product better, organized around a stated weekly lens. Use for the Friday standup, a weekly retro, or a "what was the higher-level idea behind my week" summary. Themes-only, never a PR-number dump.
user_invocable: true
argument: required weekly lens - the angle or focus the user was pursuing this week (e.g. "the experience of using Cycloid", "reliability", "review-loop performance")
---

# Friday Standup

Produce a retrospective on **the broad themes of how the user made the product better this week**, not a status list. The Friday standup is a retro on the general theme of the week's work, not a plan for the day and not a list of individual PRs.

Distill the whole week into a **small number of very broad themes** - default 3, hard cap 4. Each theme is the higher-level idea a cluster of work ladders up to. If you find yourself with 6+ themes, they are too granular: merge them until each is a thesis a stranger would remember.

## Input: the lens is required

`$ARGUMENTS` is the **lens** - the focus the user was pursuing this week (e.g. "I focused on the experience of using Cycloid", "reliability", "closing the review loop"). The lens is how the week's work gets organized and interpreted.

If no lens is given, ask one short question for it before doing anything else - do not guess a lens from the PRs. Example: "What was the theme you were chasing this week? (e.g. experience, reliability, velocity)". The user may give more than one lens; organize around all of them.

The lens biases synthesis but does not filter evidence: gather the whole week, then interpret it through the lens. If a large cluster of the week's work sits outside the stated lens, surface it as one additional theme rather than dropping it - but say plainly that it was off the stated focus.

## Window: Sunday → Friday noon

Default window is **this week's Sunday 00:00 through the Friday standup at ~12:00 local (America/New_York)**. Cover everything in that range. If the user names a different window, use it.

Compute the window explicitly from today's date; do not hardcode. Sunday is the most recent Sunday on or before today.

**Use portable date math.** The mirrored `.agents` copy runs under Codex on GNU/Linux, where BSD `date -j -v` flags fail with `date: invalid option -- 'j'`; macOS `date` rejects GNU `-d`. Define a helper that tries GNU first and falls back to BSD, and use it everywhere a date is added:

```bash
add_day() { date -d "$1 +1 day" +%Y-%m-%d 2>/dev/null || date -j -v+1d -f "%Y-%m-%d" "$1" +%Y-%m-%d; }
today=$(date +%F)
dow=$(date +%w)  # 0=Sun
sunday=$(date -d "$today -$dow days" +%Y-%m-%d 2>/dev/null || date -j -v-"${dow}"d -f "%Y-%m-%d" "$today" +%Y-%m-%d)
```

## Gather Evidence (robustly - do not undercount)

Scope to the user's identity, exactly like `daily-update`, and fail closed if identity is unavailable:

```bash
gh_login="$(gh api user --jq .login)"
repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
```

Fetch every PR the user authored in the window - merged, closed, and open. **The `--limit` truncation trap is real:** a single `gh pr list --limit 200` sorted by recency silently drops the earliest days of a high-volume week (Sunday and Monday vanish). Never trust one bounded call. Instead, either page per-day or query each state separately with a date-bucketed search, then reconcile counts:

```bash
# Per-day buckets guarantee no day is dropped. Loop each date from sunday to today
# using the portable add_day helper defined above:
d="$sunday"
while [ "$d" != "$(add_day "$today")" ]; do
  next=$(add_day "$d")
  gh pr list --repo "$repo" --author "$gh_login" --state all --limit 200 \
    --search "created:$d..$next" \
    --json number,title,createdAt,mergedAt,state,url \
    --jq '.[] | select(.createdAt[0:10]=="'"$d"'")'
done
```

Sanity-check with a per-day count (`... --jq '.[].createdAt[0:10]' | sort | uniq -c`). If any in-window day shows zero and the user clearly worked that day, you undercounted - refetch that day before synthesizing.

Read enough PR **titles** to cluster; the titles plus stack prefixes (`[N/M]`, ticket keys, shared plan links) are usually enough to infer themes. Open a representative PR body or plan only when a cluster's purpose is ambiguous. Group Graphite stacks as one unit of work, not M units.

Note the closed/junk PRs (throwaway dogfooding artifacts like README/SECURITY "comment" PRs) as **evidence of behavior** - e.g. heavy dogfooding - not as work items. They often confirm the lens (auditing by running real sessions) even though none of them is a "theme."

## Synthesize the themes

1. Cluster the whole week's work by the higher-level idea it serves, then collapse clusters until you have **3 (up to 4) very broad themes**.
2. Lead the whole retro with a one-line **thesis** for the week - the single sentence that ties the themes together, framed through the lens.
3. For each theme: a short bold title (the idea, not a category label) and 2-4 sentences of what the work was and why it made the product better. Describe the _shape_ of the work ("hunted down every place the product lied about status") - never enumerate PRs.
4. Order themes by how central they are to the stated lens.

## Output Rules

- **Never surface PR numbers, PR titles, ticket IDs, or per-PR detail in the report.** Themes only. Keep an internal evidence map (theme → the PRs behind it) so the synthesis is grounded and you can answer follow-ups, but do not print it.
- **No day-by-day breakdown.** The week is one arc; do not organize by weekday.
- Broad over granular: 3 themes, 4 only if a genuinely separate large cluster exists. Never 5+.
- Lead with the thesis line, then the themes. No preamble, no PR appendix, no metrics table.
- Plain `-` only, sentence case, no em dashes (per the user's formatting rules).
- Coworker-facing retro language, not agent narration.

## Output Shape

```text
## The week's thesis
<one sentence tying the themes together, framed through the lens>

## <Theme 1 title - the idea>
<2-4 sentences: shape of the work and why it made the product better>

## <Theme 2 title>
<...>

## <Theme 3 title>
<...>
```

## Fallback

If evidence is too thin for a trustworthy retro (e.g. `gh` unavailable, or the window has almost no authored work), say so and ask one short question rather than inventing themes.
