# Sandbox Templates

Repo-sourced sandbox templates let a repository add packages or environment variables to the E2B template Cycloid uses for sessions.

## Source Files

Source of truth is committed repo files:

- `.cycloid/sandbox.yaml`
- `.cycloid/sandbox.layer.Dockerfile`

The dashboard does not edit Dockerfiles or smoke commands. Workspace settings can choose a default source repo; the CLI builds the committed files.

## Resolution Order

New sessions use the first active template matching the target repo profile:

1. Repo-local sandbox files from the target repo.
2. Workspace default source repo.
3. Cycloid default sandbox.

Failed builds never replace the active template; a previous successful template remains active. If the active artifact pointer is missing despite a completed promotable build, the resolver repairs it on demand (skipping builds whose artifacts are blocked) before falling back; only when repair also fails do sessions fall back to the Cycloid default sandbox.

## Base Templates

Cycloid records currently deployed E2B base templates in `sandbox_base_templates`. Provider layer builds store both the source layer hash and the base template/version they were built from, so history can show `Built from` and stale active artifacts can be found after a base deploy.

Production E2B sandbox deploys register the smoke-tested base templates through `/api/admin/sandbox-base-templates/register`. If the registry is empty, builds fall back to `E2B_SANDBOX_TEMPLATE` plus `SANDBOX_IMAGE_VERSION` or `SENTRY_RELEASE`; that fallback is marked environment-sourced in API, CLI, and settings.

Registration also records the agent runtime backends the image advertises (`capabilities`), sourced from `IMAGE_ADVERTISED_AGENT_RUNTIME_BACKENDS` and printed by `e2b-template-build.sh` as `E2B_SANDBOX_TEMPLATE_AGENT_BACKENDS`. Spawn runs a fail-closed preflight (`assertActiveTemplateSupportsAgentBackend`): opt-in backends (opencode) are rejected unless the active template advertises them. Baseline backends (codex, claude_code) are never gated, so legacy capability-less rows keep spawning. Env fallback advertises no backends outside local dev (cannot prove the image), so opencode requires a registered, opencode-capable template in prod/QA.

## CLI Flow

Create the files:

```bash
cycloid sandbox init
```

Validate local draft files before pushing:

```bash
cycloid sandbox validate
```

Build the pushed source:

```bash
cycloid sandbox build <owner/repo> --wait --follow
```

Build a specific ref (e.g. an admin promoting a layer after merging an onboarding PR - use the repo's default branch):

```bash
cycloid sandbox build <owner/repo> --ref main --wait --follow
```

Inspect recent builds:

```bash
cycloid sandbox history <owner/repo>
```

Sandbox CLI commands default to the authenticated user's business. Pass `--business <business-id>` only when targeting another authorized business.

Preview active templates that would need rebuilding after a base update:

```bash
cycloid sandbox rebuild-stale --dry-run
```

Start a rebuild campaign as a Cycloid internal admin:

```bash
cycloid sandbox rebuild-stale --yes --follow
```

Rebuild campaigns rebuild the currently active source commit against the current base. A rebuilt layer is promoted only if smoke passes and the previous active artifact is still active; failures and slow campaigns leave the previous active template untouched.

Use `--target-repo <owner/repo>` only when building workspace-default coverage for a repo profile that differs from the source repo. Without matching coverage, resolution falls back to the Cycloid default and reports that no active artifact matches the repo profile.

## Onboarding Integration

The onboarding agent authors `.cycloid/sandbox.yaml` + `.cycloid/sandbox.layer.Dockerfile` automatically when a repo needs a toolchain the base sandbox lacks, validating them in-session with `cycloid sandbox validate` and including them in the setup PR (see [prompt-agents.md](prompt-agents.md#onboarding-agent)). It does not build the template; after merge an admin runs `cycloid sandbox build <owner/repo> --ref <default-branch>` from an up-to-date checkout (see [prompt-agents.md](prompt-agents.md#onboarding-agent) for the exact command). Auto-build-on-merge is not yet implemented.

## Supported Layer Instructions

Only `RUN` and `ENV` are supported. `FROM`, `COPY`, `ADD`, `ARG`, and other Dockerfile instructions are rejected because Cycloid owns the base image and startup path.

Keep smoke checks cheap and diagnostic:

```yaml
smoke:
  commands:
    - ["bash", "-lc", "command -v go && go version"]
    - ["bash", "-lc", "python3 --version"]
```

Smoke command failures include the command, exit code, and bounded stdout/stderr in API, CLI, and settings diagnostics. Raw provider logs stay behind explicit log views.

## Workspace Settings

Workspace Settings > Integrations includes a compact Sandbox Environment panel showing what the next session will use, the selected template, and fallback state. Expanded details show resolution, source files, build metadata, and recent build history. Failed build diagnostics stay collapsed until explicitly opened.

Build history attributes each build to the Cycloid user who initiated it; for CLI builds, the owner of the CLI token. API and UI responses expose only the user id, login, and name, never CLI token ids, hashes, prefixes, or token metadata.
