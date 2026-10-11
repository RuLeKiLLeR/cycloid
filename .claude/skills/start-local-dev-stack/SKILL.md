---
name: start-local-dev-stack
description: Start Cycloid's local developer stack end to end from a Linux sandbox. Use when Codex needs to boot local API/UI, start dogfood E2E, prepare dogfood auth, run local Cycloid sessions, or verify the local stack is ready.
---

# Start Local Dev Stack

Run these commands from the repo root in a Linux worktree.

## 1. Prepare The Worktree

```bash
bash scripts/worktree-setup.sh
npm run dev:env -- --mode session
```

## 2. Build The E2B Templates

Build the local sandbox templates before starting a real Cycloid session:

```bash
npm run build:e2b-template -- --dev --include-repo-spec-templates
```

## 3. Start The Full Dogfood Stack

Use dogfood for the full local stack: API, UI, tunnel, local D1 seed, dogfood auth, provider preflight, and browser auth state.

```bash
npm run dogfood:e2e
```

Keep this process running. Wait until it prints:

```text
[dogfood:e2e] dogfood ready
```

Use the printed values:

```text
UI=...
API=...
CONTROL_PLANE_URL=...
AUTH_STATE=...
REPOS=...
E2B_TEMPLATE=...
```

## 4. Confirm Readiness

In a second terminal:

```bash
npm run dogfood:preflight
```

The stack is ready when every checklist item is `ok`.

## 5. Run A Real Local Session Smoke

Use the dogfood user and local admin token:

```bash
DOGFOOD_USER_ID="$(cd apps/control-plane-worker && npx wrangler d1 execute DB --local --json --command \
  "SELECT id FROM users WHERE github_id = 900000001;" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[0].results[0].id))")"
ADMIN="$(sed -n 's/^ARCANIST_ADMIN_TOKEN=//p' apps/control-plane-worker/.dev.vars | tail -n 1)"

# Set API from the port recorded by scripts/worktree-setup.sh, or replace it with the API URL printed by scripts/dogfood-e2e.sh.
API="http://localhost:$(sed -n 's/^API_PORT=//p' .worktree-ports)"
ARCANIST_TOKEN="$ADMIN" npm run verify:e2b-session -- \
  --base-url "$API" \
  --owner-user-id "$DOGFOOD_USER_ID" \
  --repo-owner trycycloid \
  --repo-name cycloid \
  --json-out .tmp/dogfood-e2b-smoke.json
```

Passing output includes:

```text
Prod PR smoke test passed
```

## 6. Browser/Auth Use

Use the generated Playwright auth state for browser checks:

```text
/tmp/cycloid-auth/dogfood/storage-state.json
```

For sandbox app-runtime commands inside an E2B agent sandbox:

```bash
cycloid-app start
cycloid-app auth
cycloid-app run <verification command>
```

## 7. Stop

Stop the owning `npm run dogfood:e2e` terminal with `Ctrl-C`.
