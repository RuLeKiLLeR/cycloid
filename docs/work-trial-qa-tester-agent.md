# Work Trial: QA Tester Agent

Your source of truth for the two days. It's supervised and in-person, so ask freely. Especially "is this intentional?" about anything that looks off. Good questions count for you.

## The task

Build a QA Tester agent. Your way, standalone. Point it at the two PRs below (code you didn't write) and give an honest verdict plus evidence good enough to act on.

You're not wiring into our codebase. Use this repo as reference for what good looks like, not something to plug into.

## Target

Run it against both repos. One is easy to hardcode to. Two forces it to generalize, and that's part of what we're testing.

- **Cycloid (this repo).** Run path: `bash scripts/worktree-setup.sh`, then `npm run dev:full`. PR: https://github.com/trycycloid/cycloid/pull/4636 (adds PR creation/update timestamps to the session UI, files under `apps/ui/`, tests under `tests/test_ui/`). User-visible, so run the app and check it actually renders. It already has a CodeRabbit review on it, so you can see what a static reviewer caught and what it couldn't.
- **mia-copy (a customer app copied into our org).** Foreign code, closer to the real product. PR: https://github.com/trycycloid/mia-copy/pull/210 (adds `normalize_email` + tests in `core/src/lib/utils/text.py`). Python/`uv`: `cd core && uv run pytest tests/lib/utils/test_normalize_email.py` and `uv run ruff check .`. It's a pure utility, so you can run and probe it without standing up the whole app. Good for pushing on evidence: which edge cases did the tests miss?

We pinned these so you spend your time on verification, not on fighting a build. If the environment fights you, that's a finding, not a failure. How an agent bootstraps a run env for a repo it's never seen is the genuinely hard part here. Put that thinking in the proposal, don't grind on it during the build.

## What we want by the end

Both of these, not one or the other:

1. A working agent you can demo against the PRs. Your stack, your architecture. Small and real beats big and hand-wavy. We expect tests.
2. A one-page proposal: how you'd integrate it into Cycloid, what you'd build next, the biggest unknown.

We weight engineering and product thinking about equally. The build shows the first, the proposal the second. We want both.

## What QA testing is

Cycloid is a background coding agent: task in, sandbox writes code, PR opened as the user. **QA testing** is handled by a separate, QA-only agent that runs after a PR exists. It doesn't write code. It looks at the PR, runs the right checks, gathers evidence (screenshots, test output, logs), and returns a verdict: `CONCLUSIVE` (merge-ready) or `INCONCLUSIVE` (needs-work). The verdict gets posted as a comment on the PR.

**Why it matters:** we want to QA test both Cycloid PRs and PRs we did not write. A company already running its own coding agent (Cursor, Devin, in-house, even a human) can hire us just as a QA testing layer, without taking our codegen. That decouples our agent from our QA testing and grows our TAM a lot. QA testing as its own product.

## What makes it hard (the real signal)

This is what separates a toy from the real thing. Get these right:

- **Honest verdicts.** The verdict has to match the evidence. A confident "looks good" with no real testing behind it is worse than useless.
- **Sufficient evidence.** Enough to actually merge on. "Tests pass" isn't evidence the feature works. Did you exercise it like a user would?
- **Verifying code it didn't write.** No author to lean on, just the PR. What does the agent need to reach a trustworthy verdict from scratch?
- **QA-only.** It tests and reports. Never edits, commits, or pushes. The moment it "helpfully fixes" something, you can't trust the verdict.

## Prior art and what to integrate

Don't build everything from scratch. Cheap signals from existing tools can be a first pass.

**Greptile** scores a PR 1-5 and flags issues inline. Solid static reviewer ("this code looks wrong, this branch is unhandled"). Worth wiring in: pull its score and flagged issues as candidate problems your agent confirms or dismisses with real evidence.

Its ceiling is the whole reason this product exists: **Greptile can't run the app.** Pure static analysis never tells you "broken when you click the button" or "500s on an empty body." Only that the code reads wrong. That gap is our wedge: a QA Tester agent **runs the code and produces runtime evidence**. Lean on static signals for free candidates. The value you add, and what we're judging, is the runtime verdict on top. (CodeRabbit, Diamond, GitHub's reviewer: same bucket, same ceiling.)

## How it works today (reference)

You don't need to match this, but it's useful context.

```
CGA (codegen agent) opens a PR
  → QTA (QA Tester agent) is spawned at publish and runs IN PARALLEL,
    returning merge-ready | needs-work, posted as a PR comment (advisory)
  → review loop (in parallel) fixes red CI + addresses reviewer comments;
    needs-work findings fold back in as items to address
  → QA reruns are capped and non-blocking (a cap/infra failure is a DM, not a block)
  → PR is mergeable when CI is green and the loop is caught up
```

Three players hand off through shared PR state and the PR comment, never direct calls. **CGA** writes code, **QTA** is QA-only and reports via the comment (advisory — the verdict does not gate merge-ready), **RLA** (the review loop) turns feedback into fix prompts. Deep dive if you want it: `docs/design/rla-v2.md`. How we shape a verdict and evidence today: `shared/agent/verification-result.ts`.

## Ideas to pick from

Seeds, not a menu. Your own idea is welcome. Pick a focus, scope it down hard (two days goes fast), tell us why before you start.

- **A. Verify a PR you didn't write.** Point the agent at a real PR with no context beyond the PR itself. The core problem.
- **B. Evidence honesty scoring.** Measure "did the verdict match the evidence" and "was it enough to merge" across real PRs. A QA tester you can trust is one you can measure.
- **C. Surface classification.** Decide what evidence to gather from what changed (UI vs backend vs DB). Wrong guess = wrong evidence = false confidence.
- **D. Smarter recovery.** When the agent hits an environment blocker, how far can it self-repair (without editing the repo) before giving up?
- **E. Comment UX.** The PR comment is the whole product surface for a QA-test-any-PR customer. What makes a stranger trust the verdict?

## How we'll judge it

More about how you think than how much you ship. Roughly in order:

1. **A working agent.** Runs against both PRs, verdict + evidence, demoable, tested. Generalizes, not hardcoded to one repo.
2. **Verification judgment.** Honest verdicts, sufficient evidence, handles code it didn't write. The real signal.
3. **Understanding.** You can explain our approach and where your design agrees or differs.
4. **The proposal.** Integration into Cycloid, what's next, biggest unknown.
5. **Judgment and communication.** Scoped something achievable, said why, made calls when things were fuzzy, wrote down what you found.

Not goals: integrating into our codebase, a complete feature, production polish.

## How to start

1. Read `docs/design/rla-v2.md` and `docs/prompt-agents.md` for context.
2. Look at how we shape a verdict and evidence today (files above). Borrow or improve on it.
3. Pick a focus, write down why and scope. You're targeting both repos, so design for generality from the start.
4. Build on your own stack. Get to a demoable verdict + evidence on both PRs.
5. Write the proposal, including how the agent would bootstrap an unfamiliar repo's run env.

Good luck, have fun with it.
