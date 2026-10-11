# Prod login + screenshot smoke

Manual e2e check that prod Cycloid can make a visible UI change in a writable Cycloid-owned test repo, run the configured preview when explicitly asked, log in, capture a screenshot, state the visual assertion it verified, and open a PR with the screenshot in the body. Exercises prod control plane, GitHub App, runtime preview, login, and optional artifact upload -- which QA cannot prove.

## Prereqs

`cycloid` CLI logged in against `https://api.trycycloid.com` with a write-scoped token (`cycloid auth whoami --json`). `gh` + `jq`.

## Kick off N sessions

```bash
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
for i in 1 2 3; do
  cycloid sessions create https://github.com/trycycloid/<writable-test-repo> \
    "Prod UI screenshot smoke run #$i ($TS). Make a visible application UI change, not a README or docs-only change: rename the hero title on the authenticated dashboard to \"Verified Agent Control Room #$i\". Start the configured runtime preview with /app/scripts/cycloid-docker-preview, inspect the authenticated dashboard with browser tooling, save a screenshot under /tmp/cycloid-evidence, verify the new hero title is visible, and state that final claim as \"Visual assertion: ...\" before finishing." \
    --json | tee /tmp/prod-smoke-$i.json
done
```

## Poll until terminal

**Gotcha**: `phase == "idle"` is **not** terminal. After `prompt_completed` the session is idle while the control plane is still doing push → post-exec verification → PR creation; during that window `{phase: "idle", prUrl: null}` looks identical to "finished without a PR." Terminal is: `prUrl` set, `closedAt` set, or `phase == "failed"`. Typical `create → pr_created`: 60–120s. Cap 25 min.

```zsh
#!/bin/zsh
set -u
IDS=("$@"); TIMEOUT_S=1500; START=$(date +%s)
typeset -A DONE RESULT
while :; do
  NOW=$(date +%s); ELAPSED=$((NOW - START))
  for id in $IDS; do
    [[ -n "${DONE[$id]:-}" ]] && continue
    snap=$(cycloid sessions get "$id" --json 2>/dev/null | jq -c '.session | {phase, closedAt, prUrl}')
    sstate=$(echo "$snap" | jq -r '.phase // "?"')
    closedAt=$(echo "$snap" | jq -r '.closedAt // empty')
    prUrl=$(echo "$snap" | jq -r '.prUrl // empty')
    echo "[+${ELAPSED}s] $id phase=$sstate prUrl=${prUrl:-none}"
    [[ -n "$prUrl" || -n "$closedAt" || "$sstate" == "failed" ]] && { DONE[$id]=1; RESULT[$id]="$snap"; }
  done
  (( ${#DONE[@]} == ${#IDS[@]} )) && break
  (( ELAPSED > TIMEOUT_S )) && { echo "TIMEOUT"; break; }
  sleep 30
done
for id in $IDS; do
  prUrl=$(echo "${RESULT[$id]:-}" | jq -r '.prUrl // empty')
  ss="-"
  [[ -n "$prUrl" ]] && { gh pr view "$prUrl" --json body --jq .body 2>/dev/null \
    | grep -qiE 'https?://[^ )"'"'"']+\.(png|webp|jpe?g)' && ss="yes" || ss="no"; }
  echo "$id -> ${prUrl:-none} screenshot=$ss"
done
```

## Pass criteria

Per session:

- `prUrl` set and PR `state: OPEN`.
- PR body contains a screenshot URL (`github.com/.../releases/download/cycloid-evidence-.../...` or `app.trycycloid.com/.../artifacts/.../*.png` fallback).
- PR body verification includes the optional screenshot evidence.
- PR diff changes the authenticated dashboard UI, not only README/docs content.
- Agent final response or PR body includes the visual assertion: `Verified Agent Control Room #<i>` is visible on the authenticated dashboard.

Any single failure is signal.

## If a run fails

```bash
cycloid sessions events <id> --json --limit 1000 | \
  jq -r '.events[] | select(.type | test("pr_created|push_complete|verification|error|sandbox_disconnected")) | "\(.sequence)\t\(.type)"'
```

Common failure modes:

- **Idle + no push**: post-exec configured tests blocked or the push failed; missing runtime evidence is no longer a publish gate.
- **Push ok + no PR**: control-plane PR call failed — Datadog `env:production script:cycloid-control-plane-production request_id:<id>`.
- **PR missing screenshot**: the prompt did not capture an image under `/tmp/cycloid-evidence`, or artifact upload failed.
- **Screenshot exists but wrong UI**: the agent did not inspect the rendered result or edited a non-visible target. Treat as a failure; this smoke tests visible-change verification, not screenshot plumbing alone.
- **Login failed in-sandbox**: prod `CYCLOID_LOGIN_*` SSM stale — update SSM params and redeploy.

If `pr_created` event exists but `session.prUrl` is null, projection is lagging; re-check after ~60s.

## Cleanup

Close any PRs opened by this smoke manually after inspection.
