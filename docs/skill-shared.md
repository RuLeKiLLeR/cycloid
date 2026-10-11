# Shared skill guidance

## Skill Feedback Loop

Track friction as you go. A friction event is anything that made a skill harder than it promised: a documented command that failed or needed different flags, a stale path or doc reference, an undocumented failure mode you had to debug, a step that only succeeded after trial and error, or missing guidance that caused a wrong first attempt.

At report time, if any friction occurred:

- Add a `Skill gaps` section listing each event: what happened, root cause, and whether the fix belongs in the skill, a repo doc or script, or the user's environment.
- For each skill or repo-doc fix, include the smallest concrete edit so it can be applied directly.
- For user-environment fixes, state the exact one-time action the user should take.
- Offer to apply skill edits as a separate small PR. Skill edits never ride along in the worktree or PR being reconciled or verified.

Do not skip this because the run passed; friction on a passing run recurs on the next one. If there was no friction, omit the section.

## Slack testing

When a change affects Slack behavior, read `docs/slack-testing.md` and default to a real Slack verification in an internal non-customer sandbox/test channel when one is available. Ask the user to choose a channel only if no suitable internal test channel is accessible, write permission is missing, or the action would be externally visible in a customer/shared space.
