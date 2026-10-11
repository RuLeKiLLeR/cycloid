# Work Trial: Drive the Sandboxed App

The goal: when Cycloid spins up the repo's app in its sandbox, the agent can actually test it - click through the flow it just changed, see what a user would see, and produce evidence good enough to merge on. Today the agent can start the app via the Docker contract, but driving it is wedged through shell subprocesses and prompt text. We want navigate/click/type/screenshot as first-class tools the model calls.

## How this works

One problem, shipped in this repo. Wire a browsing surface into the bridge so the agent can drive the app it just stood up, and pin the evidence to the PR. Small and real beats big and hand-wavy. Write tests.

The pieces are already in the sandbox: Chromium + Playwright + `agent-browser` (`apps/sandbox-e2b/template.ts`, asserted at boot in `apps/sandbox-e2b/ready-check.sh`), and the Docker app contract that gives the agent a running app at a known host:port (`docs/customer-e2e-runtime.md`, `apps/sandbox-bridge/src/bridge.ts`). What's missing is the tool surface and the evidence path.

Out of scope for v1: arbitrary third-party URLs, OAuth/SaaS console drive-through, persistent cross-run auth, captcha, stealth, mobile surfaces, live human viewing or takeover. The session and the evidence at the end are what we trust; nobody needs to babysit the browser in real time.

## The product end-state

What "shipped" looks like, in properties not features:

- **First-class browser tools.** `navigate`, `click`, `type`, `screenshot` are tools the model calls directly, with the same audit trail as every other tool - not a shell subprocess wedged through prompt text. Prefer semantic/DOM actions over pixel-level; we're driving a web app, not Photoshop.
- **Aimed at the sandboxed app.** Scoped to the launcher-provided host:port from the app contract. The agent reaches its own running app without an egress detour or a separate hosted browser.
- **Evidence on the PR.** Screenshots from key steps land on the existing verification PR comment (`apps/control-plane-worker/src/github/verification-comment.ts`) alongside the artifacts the bridge already uploads from `/tmp/cycloid-evidence/`. A reviewer opens the PR and can see what the agent saw.
- **Secrets stay out of the artifact.** Anything injected into the browser never lands in screenshots, traces, transcripts, or the event stream.
- **Honest cost.** Whatever lands in the base image (`docs/sandbox-architecture.md`) is justified against template-size guardrails. Per-repo opt-in is fine.

One end-to-end demo: pick a PR that touches a user-visible flow in a repo we already test, have the agent drive that flow against its own sandboxed app, and show the screenshots landing on the PR with the verification comment.

## The hard parts

Where toy versions die and real ones survive:

- **Tool design.** Semantic actions (`act`/`extract`/`observe`-style) vs raw CDP primitives is a real call. The agent has to be able to recover from a bad selector, not silently lie about clicking.
- **Evidence trust.** A screenshot proves a pixel, not a behavior. Tie each artifact to the tool call that produced it so the reviewer can follow the trail. DOM snapshot alongside a screenshot is cheap and worth defending.
- **Secrets.** Credentials enter the browser, never the artifact. Get this wrong once and it's the whole story.
- **Cost discipline.** Base-image weight is a one-way ratchet shared across every session; per-run compute adds up. Measure both. Per-repo opt-in is a legitimate answer.

## Why this is the wedge

Today the agent can write the diff and start the app. It can't actually use the app. That's the gap between "tests compile" and "the feature works" - the same gap that makes static reviewers (Greptile, CodeRabbit) hit a ceiling. Closing it is what lets verification mean something.

## How we'll judge it

The demo working is table stakes. We're looking at: did you pick the right tool shape and defend it; do the screenshots actually tell a reviewer what happened; is the secret-handling safe or just looks safe.

## Notes

Not goals: arbitrary URLs, OAuth/MFA, live view, take-the-wheel, captcha, stealth, parallel browsers, every primitive. Pick the smallest cut that proves the agent can verify its own sandboxed app and demos once.

If the environment fights you - egress, base-image weight, the bridge prompt machinery - that's a finding, not a failure. Say what you'd do with more time, and what you'd cut if you had less.

Good luck.
