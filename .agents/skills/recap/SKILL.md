---
name: recap
description: Summarize the current session so a human can quickly understand the goal, current status, evidence gathered, decisions made, open blockers, and next action.
user_invocable: true
argument: optional focus area or question to emphasize in the recap
---

# Recap

Produce a concise session recap for a human joining midstream or returning after a long run.

## Input

`$ARGUMENTS` may give an optional focus (file path, error, PR, feature, or question). If present, emphasize it while still covering overall session state.

## What to Include

Read the visible session context and summarize:

- the user's original goal
- current status: done, in progress, blocked, or unclear
- important evidence gathered, including commands, files, PRs, logs, screenshots, or external systems checked
- decisions made and why they matter
- code or config changes made so far, if any
- verification performed and its result
- open blockers, unanswered questions, or risks
- the single most useful next action

If the session contains tool output, cite the relevant command or file path instead of pasting long output. If evidence is missing or ambiguous, say so directly.

## Output Format

Use exactly these sections:

```markdown
**Goal**
<1-2 sentences.>

**Status**
<Done, in progress, blocked, or unclear, plus the reason.>

**What Happened**
<Short bullet list of the important steps and findings.>

**Decisions**
<Short bullet list of decisions made and why they matter, or "None visible.">

**Evidence**
<Short bullet list of concrete files, commands, links, logs, screenshots, or test results.>

**Verification**
<Short bullet list of checks performed and results, or "None visible.">

**Open Items**
<Short bullet list, or "None visible.">

**Next Action**
<One concrete action.>
```

## Style Rules

- Be direct and compact; prefer bullets over paragraphs.
- Avoid generic advice.
- Only describe work visible in the session.
- Focus on orientation rather than implementation unless the user explicitly requests it.
- If the session is too sparse to recap confidently, say what is missing and give the best available summary.
