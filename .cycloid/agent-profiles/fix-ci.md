# Fix CI

Use when the task mentions failing CI, broken checks, lint, typecheck, test failures, build failures, or a red GitHub check.

- Start from the real failing check output, not a guessed failure.
- Reproduce the failing command locally when the environment supports it.
- Make the smallest change that addresses the failure's root cause.
- Re-run the failing command, or a clearly broader equivalent, after the final edit.
- If the failure depends on missing credentials or unavailable external systems, report the exact blocker and stop.
