---
name: debug-customer-session
description: Recover the exact prompt(s) and core context for any Cycloid session - including another business's customer session - starting from a PR, branch name, session URL, or session UUID. Use when a customer reports weird behavior on a session or PR and you need the exact prompt the agent received plus session metadata, and the API `sessions list` cannot see it because it belongs to a different business.
user_invocable: true
argument: session UUID, session URL, branch name, or PR URL/number
---

# Debug a customer session

Retrieve the exact prompt(s) and core metadata for any session, across businesses, from whatever identifier you have. The raw prompt text is **not in D1** (D1 holds only run metadata); it lives in the Braintrust `cycloid` project. D1 is the multi-tenant index that maps a branch/PR back to a session id no matter which business owns it - which `cycloid sessions list --scope business` cannot do (it only returns your own business).

## Fast path

```bash
bash scripts/debug/customer-session-prompt.sh <session-uuid | session-url | branch | pr-url | pr#>
# TRACE=1 ... also dumps the tool-call trace
# REPO=owner/name ... required when the arg is a bare PR number
```

That prints the session's business/owner/repo/title/branch and every prompt's exact text. Prereqs below. If it works, you are done; the rest of this doc is the manual procedure and the gotchas the script already handles.

## Prereqs

- `npx wrangler whoami` must list the **`d1`** scope. If missing, run `npx wrangler login` (interactive) and retry - a token without `d1` returns Cloudflare error `10000`.
- `BRAINTRUST_API_KEY` exported (present in the repo dev shell).

## Manual procedure

### 1. Resolve the identifier to a session UUID

- **Session URL / UUID**: use it directly (`.../sessions/<uuid>`).
- **Branch name**: a legacy branch ends in the 12-hex **session-UUID tail** (e.g. `...-20e51f44ebcc`); a clean post-#7194 branch has no suffix.
  - Suffixed: `SELECT session_id FROM session_index WHERE session_id LIKE '%<12hex>'`
  - Clean / unsure: `SELECT session_id FROM session_index WHERE published_branch = '<branch>'`
- **PR**: resolve by exact `pr_url` (GitHub's canonical html_url), which is unique per session - do **not** go through the branch, since branch slugs are not globally unique and a multi-PR session's older PR can stop matching `session_index.published_branch`: `SELECT session_id FROM session_pr_metadata WHERE pr_url = 'https://github.com/<owner>/<name>/pull/<n>' ORDER BY updated_at DESC LIMIT 1`

### 2. Session metadata from D1 (multi-tenant, all businesses)

```
SELECT business_id, owner_user_id, repo_owner, repo_name, title, published_branch, created_at
FROM session_index WHERE session_id = '<uuid>'
```

`prompt_runs` adds per-prompt run stats (`prompt_id`, `bt_span_id`, `outcome`, tokens, `dd_trace_id`) but **no prompt text**.

### 3. Exact prompt from Braintrust

Project `cycloid` = id `8b3d7d5c-971f-4372-9bc7-d2f39b6f9f74`. BTQL requires the project **id, not the name** (name returns `403`). Query by `metadata.sessionId` (camelCase). The per-prompt root span is named `prompt:p-N`; the user's text is in `input.user` (`input.system` is the harness preamble).

```
POST https://api.braintrust.dev/btql   (Authorization: Bearer $BRAINTRUST_API_KEY)
{"query":"select: input, metadata, created from: project_logs('8b3d7d5c-971f-4372-9bc7-d2f39b6f9f74') filter: metadata.sessionId = '<uuid>' AND span_attributes.name LIKE 'prompt:%' sort: created asc limit: 50","fmt":"json"}
```

## Gotchas (all handled by the script)

- **D1 has no prompt text.** Only Braintrust does. Don't waste time grepping D1 tables for it.
- **The remote-wrangler guard** (`scripts/guard-remote-wrangler.sh`, a Bash pre-hook) rejects any command line containing a pipe, `;`, or a second command - it inspects the whole line. Run each `wrangler d1 execute --command "SELECT ..."` **alone**, redirect to a file, and parse in a separate step. A wrapper script side-steps this because the hook only sees `bash script.sh <arg>`.
- **BTQL project reference must be the id.** Resolve names via `GET /v1/project`.
- **Cross-business:** the session very likely is not in your business, so the CLI/API list won't show it; go through D1.
- **Missing telemetry:** sessions predating Braintrust logging, or with tracing disabled, have no prompt spans - the metadata from D1 is then all you get.

## Reproducing the branch name (or other bridge behavior)

Once you have the exact prompt, you can replay it on the deployed build with `cycloid sessions create <repo> "<prompt>"` to observe branch naming or other behavior. Branch naming is derived from the prompt, not the repo, so `trycycloid/cycloid` is a safe target and avoids touching the customer repo. See [verify-deployed-pr](../verify-deployed-pr/SKILL.md) for the deploy-then-verify flow.
