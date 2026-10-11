---
name: slack-daily-recap
description: Recap every Slack message I sent today (since local midnight, America/New_York), grouped by theme and ordered chronologically, with the threads I engaged in for context. On-demand end-of-day review. Writes the recap to a gitignored .slack-recaps/<date>.md in the current repo and prints it in the session; does not post to Slack.
disable-model-invocation: true
---

# Slack daily recap

End-of-day review of my own Slack activity. Pulls every message I authored since local midnight, pulls the threads I engaged in for context, then writes a chronological, theme-grouped recap to a **gitignored `.slack-recaps/<date>.md` at the current repo root** and also prints it in the session. It does not post to Slack or message anyone.

The point of the file: run it at end of day, and tomorrow morning open `.slack-recaps/` to read yesterday's recap. The file is named by the day it covers (`<DATE>.md`), so the folder becomes a dated archive.

## Identity and boundaries

- **Resolve my Slack user ID at runtime** - do not hardcode a person. Read the `slack_search_public_and_private` tool description; it prints `Current logged in user's user_id is <ID>`. Use that `<ID>` as `<ME>` everywhere below. This keeps the skill correct for whoever is logged in.
- Day boundary is **America/New_York local midnight to now**. Slack's `on:YYYY-MM-DD` modifier already keys off the workspace/user local day, so use it directly - no epoch math needed.
- Default target day is today. If the user passes a date argument (`YYYY-MM-DD`), recap that day instead.
- Read-only. Never call `slack_send_message`, `slack_send_message_draft`, `slack_schedule_message`, `slack_add_reaction`, canvas writes, or any mutating tool.

## Procedure

1. **Determine the target date.** Get today's ET date with `TZ=America/New_York date +%F`, or use the user-supplied `YYYY-MM-DD`.

2. **Pull all my messages for the day.** Call `slack_search_public_and_private`:
   - `query`: `from:<@ME> on:<DATE>` (substitute the resolved user ID and date; angle brackets are literal).
   - `sort`: `timestamp`, `sort_dir`: `asc`, `limit`: `20`, `include_context`: `false`.
   - **Paginate**: the response caps at 20 results and returns a `cursor` in `pagination_info`. Keep calling with that `cursor` until no further cursor is returned. Do not stop at the first page - a normal day exceeds 20 messages.
   - **Past 400 messages (the 20-page cap):** Slack search hard-caps pagination at 20 pages and then throws `page_limit_exceeded`. When that happens, do not stop - start a fresh query windowed by time: drop the `on:<DATE>` modifier, pass `after: <unix-ts-of-last-message-seen + 1>` (the numeric param, not a query modifier), and paginate that from page 1. Repeat the window-and-restart each time you hit the cap until a page returns "End of results". Heavy days need this or the afternoon/evening silently goes missing.
   - Collect: channel name + ID, timestamp (ET), text, and permalink for every result.

3. **Identify engaged threads.** A result whose permalink contains `?thread_ts=<TS>&cid=<CID>` is a message I sent inside a thread. Collect the unique `(cid, thread_ts)` pairs. For each, call `slack_read_thread` with `channel_id=<cid>`, `message_ts=<thread_ts>` to get the surrounding conversation. This is what "threads I engaged in" means - read enough to understand what I was responding to, not to quote the whole thread. Cap at ~15 distinct threads; if there are more, read the ones where I sent the most messages and note the rest were skipped.

4. **Resolve channel/person names as needed.** Search results already include channel names and DM participant names. Only call `slack_read_user_profile` / `slack_search_users` if a raw `U…`/`C…` ID would otherwise leak into the recap.

   **Never merge distinct entities that have similar names.** Customer/person channels like `#cycloid-mia` and `#cycloid-maya` are _different customers_ even though the names look alike (one-vowel apart, both `#cycloid-<name>`). Key every attribution on the **channel ID** (`C…`), not the display name - build the theme buckets by channel ID first, then label them. Do not let a more-frequent name absorb a rarely-seen one.

   **Do not give a DM/unlabeled message a customer/entity label without an explicit in-message anchor.** DMs carry no channel-name signal, so content discussed there must not inherit a customer label by vibe or by whichever customer was most active that day. Attribute it only when the message text itself names the entity (e.g. "open pr against **mia**") or links a specific channel/PR. If a DM thread discusses a customer but never names one, say "a customer" rather than guessing.

5. **Synthesize the recap.** Group the day into a handful of **themes** (e.g. "Hiring / sourcing", "Onboarding + credentials", "Local dev setup", "Product/PR decisions"). Within the recap, keep the overall flow **chronological** - themes should read roughly in the order the day unfolded, and within a theme keep events time-ordered. For each theme give:
   - a short bold label,
   - the ET time span,
   - 2-4 bullets of what actually happened / what I decided or asked, phrased as substance not a message log,
   - where useful, the channel(s) it happened in.

   Before finalizing, run one **attribution check**: for every customer/person named in the recap, confirm the underlying messages actually carry that entity's channel ID or name token. This is the step that catches similar-name merges (mia vs maya) - do not skip it.

## Write the file

Write the recap to `<repo-root>/.slack-recaps/<DATE>.md`, then also print it in the session.

1. `ROOT="$(git rev-parse --show-toplevel)"`. If this errors (not inside a git repo), skip the file and just print the recap, noting no repo was found.
2. Ensure the folder is gitignored so recaps never get committed. Prefer the tracked `.gitignore` if the repo already lists `.slack-recaps/`; otherwise fall back to the local-only `"$(git rev-parse --git-dir)/info/exclude"`. Idempotently add `.slack-recaps/` (check with `grep -qxF '.slack-recaps/'` before appending). Never stage or commit this change - just leave it in the working tree.
3. `mkdir -p "$ROOT/.slack-recaps"` and write the recap to `"$ROOT/.slack-recaps/<DATE>.md"`, overwriting if a file for that date already exists (a re-run replaces the day's recap).
4. Confirm with `git check-ignore -v "$ROOT/.slack-recaps/<DATE>.md"` that the file is ignored before finishing. If it is NOT ignored, stop and tell me rather than leaving an untracked recap that could be committed.
5. After writing, print the recap in the session and state the path written.

## Output format

The file body and the in-session print use the same markdown. Follow the user's formatting rules: plain `-` bullets only (never long/en dashes), sentence case, ET times, terse.

```
# Slack recap - <DATE> (ET)

<1-2 sentence gestalt of the day: how many messages, main threads of activity.>

## <HH:MM-HH:MM> Theme one
- ...
- ...

## <HH:MM-HH:MM> Theme two
- ...

## Loose ends / unresolved
- Open questions I asked that had no clear resolution, or things I said I'd follow up on.
```

- Lead with the recap. No preamble about how the data was gathered.
- `<DATE>` is the day the recap covers (today's ET date at end-of-day run), so tomorrow the file reads as "yesterday's recap."
- Prefer substance over volume: a one-word "kk" reply is context, not a headline. Fold trivial acks into the theme they belong to rather than listing each.
- Surface decisions, asks, commitments, and unresolved threads - those are the signal for an end-of-day review.

## Notes

- Verified 2026-07-06 against a ~630-message day: `from:<@ME> on:<date>` with `sort=timestamp` returns the day's messages in ET; pagination via `cursor` is required; the search hard-caps at 20 pages (400 messages) and then needs the `after:` time-window restart above; thread membership is detectable from the `thread_ts` query param in the permalink.
- If the search returns zero results, say so plainly (quiet day / wrong date / not logged into the expected workspace) rather than inventing themes.
