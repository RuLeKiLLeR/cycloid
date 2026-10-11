# Frictionless Agent Dev Stack

## Goal

Make local Cycloid verification low-friction for agents: one startup path, complete dogfood authorization, fast preflight, and no manual environment repair.

## Target Shape

- `dev:full` remains the canonical developer stack.
- `dogfood:e2e` becomes `dev:full` plus dogfood additions.
- `cycloid-app start/auth/run` remains the sandbox-facing interface.
- agents stop on preflight failure instead of editing D1, `.dev.vars`, ngrok, or E2B state by hand.

## Commands

```bash
npm run dev:env -- --mode session
npm run dogfood:prepare
npm run dogfood:preflight
npm run dogfood:e2e
```

`dev:env` materializes `.dev.vars` from runtime secrets plus safe generated local defaults.

`dogfood:prepare` creates the dogfood user, auth token, model integrations, repo catalog, and readiness file.

`dogfood:preflight` proves API/UI health, public callback health, websocket preflight, dogfood auth, model provider availability, E2B auth, exact default-repo template availability, and GitHub repo access.

`dogfood:e2e` composes those pieces, starts the fixed-port dogfood stack, writes Playwright auth state, and prints the ready values.

## Dogfood Contract

Dogfood must be able to exercise the configured happy paths:

- create repo sessions
- enqueue prompts
- use configured model providers
- spawn E2B sandboxes
- receive sandbox callbacks
- read/write configured repos through the dev GitHub App
- create or update PRs on writable dogfood repos

Supported repos are explicit:

```text
DOGFOOD_REPOS=trycycloid/cycloid,trycycloid/dummy-app
DOGFOOD_DEFAULT_REPO=trycycloid/cycloid
```

Agents choose from `REPOS`; they should not discover safe repos by trial.

## Stop Rule

Preflight failure is terminal for the verification attempt.

Allowed:

- rerun the same startup command once after a transient child-process failure
- follow the printed next action

Disallowed:

- manual D1 edits
- ad hoc `.dev.vars` construction
- repeated ngrok restarts
- E2B credential guessing
- QA escalation only because local setup is broken

## Verification

- script help/failure checks for the new commands
- `npm run dogfood:e2e` reaches `dogfood ready`
- real local session smoke against `DOGFOOD_DEFAULT_REPO`
- invalid E2B key smoke fails fast with a clear checklist
