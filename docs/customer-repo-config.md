# Customer repo config

Files a customer checks into their own repo that Cycloid reads at runtime. Repo-owned: Cycloid runs or reads them, it does not store them.

| File                                | Purpose                                                                                                                      |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `CYCLOID.md`                        | Highest-precedence project-instruction doc the agent auto-loads at session start. See below.                                 |
| `.cycloid/setup.sh`                 | Commands to run at sandbox startup (dependency install, codegen). See below.                                                 |
| `.cycloid.json`                     | App-runtime / e2e preview profile and PR template pointer. See [customer-e2e-runtime.md](customer-e2e-runtime.md) and below. |
| `.cycloid/agent-profiles/*.md`      | Optional prompt guidance profiles. See [prompt-agents.md](prompt-agents.md#repo-local-agent-profiles).                       |
| `.cycloid/sandbox.yaml`             | Optional sandbox layer config (custom Dockerfile, smoke tests). See below.                                                   |
| `.cycloid/sandbox.layer.Dockerfile` | Custom sandbox layer Dockerfile (only `RUN` and `ENV` instructions). See below.                                              |

### `CYCLOID.md` — project-instruction precedence

A repo-root `CYCLOID.md` is the highest-precedence project-instruction doc the agent auto-loads at session start:

- **Precedence:** `CYCLOID.md` > `AGENTS.md` > `CLAUDE.md`. Absent `CYCLOID.md`, behavior is unchanged (`AGENTS.md`, then `CLAUDE.md`).
- **Why:** lets a repo with boilerplate root `AGENTS.md` or scattered rules (e.g. `.cursor/rules/*.mdc`) consolidate authoritative agent rules into one file read first.
- **Non-destructive:** Cycloid surfaces `CYCLOID.md` through the agent runtime's native override slot and never edits customer files; the override artifact stays out of the customer's git diff. A repo shipping its own `AGENTS.override.md` is left untouched.
- **How the agent sees it:** the runtime injects the resolved doc under a fixed `# AGENTS.md instructions` header — the agent obeys `CYCLOID.md`'s **content** but is not shown the literal filename `CYCLOID.md`. Precedence is about which rules win, not which filename the agent reports.
- **Size ceiling:** the resolved doc is truncated at 32 KiB (the runtime's `project_doc_max_bytes`). An over-budget `CYCLOID.md` is surfaced as a warning rather than silently truncated — keep it under 32 KiB.
- **Output style:** Cycloid post-execution surfaces can read topic sections from this same doc for prose style.
  PR body structure still comes from `pr.templatePath` or auto-discovered PR templates; PR summary tone and length can come from a `## PR descriptions`, `## PR description style`, `## PR summary`, `## PR summaries`, `## PR summary style`, `## Pull request descriptions`, or `## Pull request summaries` section.
  These sections are untrusted style guidance only — operational, tool, security, and system directives inside them are ignored.

```markdown
## PR descriptions

Under 100 lines changed: exactly two sentences, plain language, sound like I wrote it.
Larger changes: a short summary plus screenshots and a post-deploy checklist if relevant.
Never include command output, CI check logs, or step-by-step stage tables.
```

### `.cycloid.json` → `pr.templatePath`

Points Cycloid at an explicit PR template instead of `.github/pull_request_template.md` auto-discovery.

- **Field:** `pr.templatePath` — repo-relative path to a markdown (`.md`) file.
- **Precedence:** `pr.templatePath` > auto-discovered `.github` templates > Cycloid's built-in default body.
- **Fail-soft:** a missing, non-markdown, absolute, traversing (`..`), or nonexistent path is ignored; falls back to auto-discovery, then the default body.

```json
{
  "pr": { "templatePath": ".github/PULL_REQUEST_TEMPLATE/cycloid.md" }
}
```

Cycloid fills the template's sections (summary, testing/verification, screenshots, …) from the current session on every publish.

## `.cycloid/setup.sh`

Repo-owned script Cycloid runs in the background at sandbox startup, after clone and before the agent's first prompt. Use for `npm ci`, `uv sync`, `poetry install`, `bundle install`, codegen, etc.

When present, it **replaces** Cycloid's npm/pnpm/yarn auto-detection — the repo owns workspace setup end-to-end.

### Contract

- **Location:** `.cycloid/setup.sh` (a `.cycloid/` directory, not the repo root). Executable bit not required; Cycloid runs it with `bash`.
- **Exit status:** failure is detected from the final exit code. `bash` does not enable strict mode for you — start with `set -euo pipefail` (or check each command), otherwise a failing command followed by another reports success.
- **Failure handling:** non-zero exit or timeout is surfaced in the session UI/transcript as a workspace-setup failure, but the agent still runs (warn-and-continue); the session is not aborted.
- **Timeout:** 540 seconds. Over-limit scripts are killed and reported as a timeout.
- **Idempotency:** runs on **every** sandbox cold start, including resumed sessions. Make it safe to re-run (e.g. `[ -d .venv ] || uv sync`).
- **Network:** runs under the repo's egress policy; installs against external registries fail unless those hosts are allowlisted.
- **Secrets:** Cycloid-owned credentials the install never needs (`SANDBOX_AUTH_TOKEN`, `ARCANIST_TOKEN`, `CODEX_API_KEY`, `OPENAI_API_KEY`) are removed from the script's environment. `GITHUB_CLONE_TOKEN` is kept so authenticated private dependency installs work. The CLI auth file (`~/.cycloid/config.json`) is not written until after setup completes, so untrusted scripts cannot read the token from disk. Do not hardcode secrets; supply repo-specific credentials through Cycloid's repo env-var settings.

### Example

```bash
#!/usr/bin/env bash
set -euo pipefail

# Python deps (idempotent: skip when the venv already exists)
[ -d .venv ] || uv sync

# JS deps
npm ci
```

## `.cycloid/sandbox.yaml`

Optional YAML config for customizing the E2B sandbox environment. Allows repo-owned Docker layers and smoke-test commands.

### Fields

- `layer.dockerfile` — repo-relative path to a Dockerfile for additional sandbox layers.
- `smoke.commands` — list of `[interpreter, args...]` command vectors to verify sandbox readiness.

### Example

```yaml
version: 1
layer:
  dockerfile: .cycloid/sandbox.layer.Dockerfile
smoke:
  commands:
    - ["bash", "-lc", "command -v git && command -v python3"]
```

## `.cycloid/sandbox.layer.Dockerfile`

Optional Dockerfile for adding packages to the sandbox image. Cycloid builds this as a layer on top of the base E2B template.

### Constraints

- Only `RUN` and `ENV` instructions are supported.
- Keep it minimal; large layers slow sandbox startup.

### Example

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends ripgrep && rm -rf /var/lib/apt/lists/*
```
