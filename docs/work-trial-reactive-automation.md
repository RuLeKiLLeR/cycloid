# Work Trial: Reactive Automation

Two days, supervised, in-person. Ask freely - especially "is this intentional?" Good questions count.

## How this works

Two problems, **working code for both**. How deep you go on each is your call - tell us why you split your time the way you did. We weight engineering and product thinking about equally, so show both. Small and real beats big and hand-wavy. Write tests.

- **Problem 1 ships in our repo.** Wire it into the real control plane. The integration test: can you land a clean change in a codebase you didn't write?
- **Problem 2 is standalone.** Your own stack, ground you know. Use this repo as a reference for what good looks like, not something to plug into.

## Problem 1: extend the alert automation trigger

Slack alert automation for Datadog and Sentry is now live: bot messages matching configured rules in `apps/control-plane-worker/src/automation/slack-channel-trigger.ts` and `slack-channel-service.ts` already spawn triage sessions and post results back to the thread. The UI in `apps/ui/src/components/settings/SlackAlertAutomationSettings.tsx` lets admins configure channels, detect sender IDs, and set prompts.

**Extend it.** Add a new trigger kind — for example, a Linear issue with a specific label, or a GitHub PR review comment matching a pattern — that spawns a Cycloid session. Wire it through the existing automation infrastructure: `automation_rules` table, scheduler tick, trigger matching, and session creation. The edges matter: deduping, failure modes, and evidence that it ran.

Start by reading `docs/slack.md` and tracing how Slack events become sessions today — then add your trigger kind to the same pipeline.

## Problem 2: don't do the same work ten times, and don't act on noise

Problem 1 fires on every event. That's the dumb version, and it fails two ways. A local agent (Cursor, a human) hits both because it only ever sees one request at a time. Cycloid is a **shared platform**: it turns isolated requests into a dataset, and that unlocks two things a local agent can't do.

**Duplicated work.** Ten people ask for the same thing at once. A local agent can't see the other nine, so it does the work ten times - one real need, ten times the cost. The fix is dedup: do it once.

**Premature action.** One request isn't proof the thing should be built. Could be noise. Act now and you've spent real work on a signal of one. The fix is patience: let requests accumulate, act once a pattern proves itself. Sometimes the right move is to _not_ react.

Two different levers, not one - keep them distinct. What ties them together: **trust the aggregate over the individual event.** A local agent has one row of the table; it can't do either. Build something that shows the idea working - how you cluster, when you act, what you do when a pattern crosses the bar is yours to design.

## How the two connect

They look contradictory - "fire on everything" vs "often don't fire." They aren't. Problem 1 builds the pipe that turns events into a dataset; Problem 2 is the policy layer deciding what's worth sending down it. Tell us if you think it's one system or two, and why. There's a real answer.

## Why this is the whole value prop

The jump from Problem 1 to Problem 2 is the jump from a tool to infrastructure - that's how Cycloid gets entrenched.

Problem 1 alone is copyable: a webhook fires an agent. Reach Problem 2 and you're aggregating every request and incident across the company, learning what recurs, deciding what's worth acting on. That dataset is the company's operational memory, and it exists only because Cycloid sat in the middle long enough to build it. A competitor clones the webhook in a day. They can't clone years of knowing what actually breaks here and what the team keeps asking for.

So the complexity progression **is** the moat. Reactive automation is the wedge; the learning layer is why they can't leave. You're not building a Slack bot - you're building the thing a company's work flows through.

## Notes

Not goals: a complete feature, polish, every event source. Slack is enough.

If the environment fights you, that's a finding, not a failure. Say what you'd do with more time.

Good luck.
