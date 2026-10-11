---
name: dead-code-audit
description: Use when asked to audit the codebase for dead API endpoints, uncalled functions, test-only exports, or orphaned files and delete the confirmed dead code.
user_invocable: true
argument: optional -- "report" to list findings without deleting, or omit to delete dead code directly
---

# Dead code audit

Find and aggressively delete dead code across the codebase. This skill **directly deletes** dead code and commits the result.

## What counts as dead code

1. **API endpoints with no UI callers** -- routes in `apps/control-plane-worker/src/routes/` never called from `apps/ui/src/api/` or any other client (CLI, MCP, webhooks, sandbox-bridge). Internal-only routes called by other workers or Durable Objects are NOT dead.
2. **Exported functions/types with no callers** -- exported but never imported in application code.
3. **Functions whose only callers are tests** -- if the only `import` or usage is inside `tests/`, the function (and its tests) are dead.
4. **Orphaned files** -- source files nothing imports.
5. **Unused variables, parameters, and imports** -- within otherwise-alive files.
6. **Dead feature flags or config** -- constants defined but never read.

## What is NOT dead code

- Webhook handlers (called by external services)
- Durable Object alarm handlers, fetch handlers, scheduled handlers (called by runtime)
- Entry points (`index.ts`, `main.tsx`, `app.py`, `entrypoint.py`, `mcp-server.ts`, `server.ts`)
- Re-exports in barrel files consumed downstream
- Types used only for documentation or schema validation
- Python `__init__.py` files
- Migration files
- Test helpers used by multiple test files

## Step 1: Build the caller graph

Launch **5 parallel Explore agents** to map who calls what:

### Agent 1: API endpoint inventory

1. Read `apps/control-plane-worker/src/routes/table.ts` as the registered-route index.
   Follow every imported/spread route array (for example `...sessionRoutes`) into its source module and inventory the actual `method` + `pattern` entries there.
2. For each inventoried route, grep the codebase for its path string (e.g., `/api/sessions`, `/api/repos`).
3. Classify each route:
   - **UI-called**: path appears in `apps/ui/src/api/` or UI components
   - **CLI-called**: path appears in `apps/cli/`
   - **MCP/runtime-called**: path appears in any MCP/runtime app discovered under `apps/*`
   - **Bridge-called**: path appears in `apps/sandbox-bridge/`
   - **Webhook**: handler registered as a webhook receiver
   - **Internal**: called by Durable Objects or other workers
   - **Dead**: no callers found anywhere
4. Return: dead routes with source module file paths and line numbers.

### Agent 2: control-plane-worker exports

1. Scan every `.ts` file in `apps/control-plane-worker/src/` for exported functions, classes, types, constants.
2. For each export, grep the codebase (excluding the defining file and `tests/`) for imports or references.
3. Also check same-file usage (non-exported usage doesn't count -- the export keyword itself is dead).
4. Return: exports with zero non-test callers, with file paths and line numbers.

### Agent 3: sandbox-bridge + shared exports

1. Same as Agent 2, for `apps/sandbox-bridge/src/` and `shared/`.
2. For shared code, verify callers exist in at least one app (not just tests).
3. Return: dead exports with file paths and line numbers.

### Agent 4: UI dead code

1. Scan `apps/ui/src/` for exported functions, components, types, hooks, constants.
2. For each export, check it's imported/used by another UI file (excluding tests).
3. Check for orphaned files -- `.tsx`/`.ts` files in `apps/ui/src/` nothing imports and that are not entry points.
4. Return: dead exports and orphaned files.

### Agent 5: Runtime app enumeration

1. Enumerate `apps/*` and `shared/` at runtime.
2. Exclude app areas already owned by Agents 1-4 (`control-plane-worker`, `sandbox-bridge`, `ui`) and partition the remaining app directories across this agent.
3. Scan each remaining app directory for dead exports, orphaned entry-adjacent helpers, and stale references from deleted runtime surfaces.
4. For shell/helper files in sandbox or runtime apps, look for orphaned scripts or stale references from deleted runtime surfaces.
5. Return: dead exports with file paths and line numbers.

## Step 2: Cross-reference and validate

After all agents complete:

1. **Merge findings** into a single deduplicated list.
2. **Remove false positives** by checking:
   - Is the function referenced dynamically (string interpolation, `[]` access, `getattr`)?

- Is it a lifecycle method or framework hook (React effects, DO alarms, framework decorators)?
- Is it referenced in config files (`wrangler.toml`, `vite.config.ts`, `pyproject.toml`)?
- Is it an entry point file (check `package.json` `main`/`exports` fields)?
- Is it used by scripts in `scripts/`?

3. **Classify** each finding:
   - `DEAD_ENDPOINT` -- API route with no callers
   - `DEAD_EXPORT` -- exported symbol with no non-test callers
   - `TEST_ONLY` -- function exists only to serve tests
   - `ORPHANED_FILE` -- entire file is unreferenced
   - `DEAD_IMPORT` -- import for something not used in the file
   - `DEAD_CONSTANT` -- constant defined but never read

## Step 3: Present findings

Present a table:

| #   | Type | File | Symbol | Evidence (callers found) |
| --- | ---- | ---- | ------ | ------------------------ |

If argument is `"report"`, stop here. Do not delete anything.

Otherwise, ask the user: "I found N pieces of dead code. Delete all, or review individually?"

## Step 4: Delete dead code

For each confirmed finding:

### DEAD_ENDPOINT

- Remove the route handler function from its route file.
- Remove the route registration from `routes/table.ts`.
- Remove service functions that ONLY served this endpoint (check for other callers first).
- Remove associated DAO functions that ONLY served this service function.

### DEAD_EXPORT

- If the entire function/type is unused (not just the export keyword), delete it.
- If used internally but the `export` is dead, remove only the `export` keyword.
- If removal leaves an import unused, remove that import too.

### TEST_ONLY

- Delete the function from application code.
- Delete the corresponding test file or test cases; if the test file becomes empty, delete it.

### ORPHANED_FILE

- Delete the entire file.
- Remove any imports of it from other files (there shouldn't be any, but check).

### DEAD_IMPORT / DEAD_CONSTANT

- Remove the unused import line or constant definition.

## Step 5: Verify nothing broke

After all deletions:

1. Run root `npm run typecheck` to check all TypeScript workspaces.
2. Run `npm test` to verify tests still pass.
3. If anything breaks, the "dead" code was alive -- revert that specific deletion and drop it from the findings.

## Step 6: Commit

1. Stage all modified and deleted files by name (never `git add -A`).
2. Commit through Graphite with `gt modify -m "Remove dead code: N endpoints, N exports, N files" -m "<why + what changed>" --no-interactive` (fill in actual counts).
3. Present a summary of everything deleted, grouped by type.

## Rules

- **Be aggressive but correct.** Maximize deletion, but never delete code with a real caller -- false positives are worse than missed dead code.
- **Follow the chain.** Deleting a function may make OTHER functions dead (e.g., a helper only it used). Delete those too.
- **Delete tests for dead code.** Tests that only test dead code are themselves dead.
- **Don't refactor.** Only delete. Don't restructure, rename, or "improve" surviving code.
- **Verify before deleting.** Always grep first. Dynamic references (`obj[key]`, template literals, Python `getattr`) can hide callers.
- **Respect entry points.** Never delete entry point files, framework handlers, or webhook receivers.
- **One commit.** All deletions in a single commit so they can be easily reverted.
