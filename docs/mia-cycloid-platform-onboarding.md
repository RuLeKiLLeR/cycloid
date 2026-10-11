# Mia Copy Onboarding Checklist

Source-of-truth checklist for onboarding `mia-copy` into Cycloid. Use the exact Mia examples as the reference shape for future client repos.

## A. Changes In Their Repo

### `.cycloid.json`

`mia-copy` added this runtime and verification contract:

```json
{
  "appRuntime": {
    "kind": "web",
    "runner": "docker",
    "entry": {
      "type": "compose",
      "files": [".cycloid/docker-compose.yml"],
      "service": "web"
    },
    "url": {
      "hostPort": 3300,
      "path": "/auth/sign-in"
    },
    "portMapping": {
      "containerPort": 3000
    },
    "additionalPorts": [
      {
        "service": "api",
        "hostPort": 18000,
        "containerPort": 8000
      }
    ],
    "ready": {
      "path": "/auth/sign-in",
      "timeoutSeconds": 1200
    },
    "open": {
      "path": "/auth/sign-in"
    },
    "auth": {
      "command": "node .cycloid/scripts/auth.mjs",
      "validatePath": "/admin/org-select"
    }
  },
  "verify": {
    "test": {
      "timeoutSeconds": 900,
      "rules": [
        {
          "name": "dashboard-typecheck",
          "paths": ["dashboard/**", ".cycloid.json", ".cycloid/**"],
          "command": "sh .cycloid/scripts/dashboard-typecheck.sh"
        },
        {
          "name": "core-ruff",
          "paths": [
            "core/src/**",
            "core/tests/**",
            "core/pyproject.toml",
            "core/uv.lock",
            ".cycloid.json",
            ".cycloid/**"
          ],
          "command": "cd core && uv run ruff check ."
        }
      ]
    }
  }
}
```

Details to copy/adapt:

- `entry.service` is `web`, the Compose service Cycloid opens.
- Browser traffic: host port `3300`, container port `3000`.
- API declared as extra port: service `api`, host `18000`, container `8000`.
- `ready.timeoutSeconds` is long: cold boot runs migrations, seeds data, builds/installs frontend deps, starts multiple services.
- `auth.command` writes Playwright storage state; `auth.validatePath` confirms authenticated state reaches `/admin/org-select`.
- `verify.test.rules` are path-scoped: dashboard changes run dashboard typecheck; core API changes run core Ruff.
- `verify.test.timeoutSeconds` is repo-specific; size from measured command duration.

### Adjacent Cycloid Files

`mia-copy` added these files around `.cycloid.json`:

| File                                      | Actual responsibility in `mia-copy`                                                                                                                                                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.cycloid/docker-compose.yml`             | Defines `db`, `redis`, `api`, and `web`. The API builds from `../core/Dockerfile`, waits for Postgres/Redis, runs `alembic upgrade head`, seeds the dev user and integrations, then starts `src/main.py`. The web service runs Node from `dashboard`, mounts the repo, and exposes `3300:3000`.  |
| `.cycloid/scripts/auth.mjs`               | Calls `/user/login` on API port `18000`, fetches the first organization, and writes cookies for `Authorization`, `currOrgId`, `currOrgName`, `currDivision`, `currDivisionId`, `orgIndustry`, and `orgOpenCallMgmt`. Defaults to `dev-app@mia.inc` / `Hello1234!`, overridable through env vars. |
| `.cycloid/scripts/api-loopback-proxy.mjs` | Listens on `127.0.0.1:18000` and forwards requests to Docker service `api:8000`, so dashboard browser calls hit the API correctly.                                                                                                                                                               |
| `.cycloid/scripts/dashboard-dev.sh`       | Runs `npm ci` if dashboard deps are missing, starts the API loopback proxy, then runs `npm run dev:cycloid`.                                                                                                                                                                                     |
| `.cycloid/scripts/dashboard-typecheck.sh` | Finds the repo root, enters `dashboard`, runs `npm ci` when deps are missing/stale, then runs `npm run typecheck`.                                                                                                                                                                               |
| `.cycloid/python/sitecustomize.py`        | Cycloid-only Python shim loaded through `PYTHONPATH`; disables Azure Key Vault fetches, points Redis at `REDIS_URL`, and forces stable Uvicorn worker defaults.                                                                                                                                  |
| `.cycloid/verify/baseline.md`             | Human/agent verification expectations for UI, backend, migrations, DAO/data, and infra changes.                                                                                                                                                                                                  |

### Compose Runtime Details

- `db`: `postgres:14-alpine`, database `local-psql-db-api-main-mia-01`, healthchecked with `pg_isready`, persistent volume `cycloid-postgres-data`.
- `redis`: `redis:7-alpine`.
- `api`: builds from existing product Dockerfile at `core/Dockerfile`; no custom API Dockerfile.
- `api` command sequence:
  - activate `/usr/src/app/.venv`
  - `uv run alembic upgrade head`
  - `uv run python src/dev_tools/setup_dev_user.py user`
  - `uv run python src/dev_tools/setup_dev_user.py integration --create-all`
  - `uv run python src/main.py`
- `api` env: local service URLs, placeholder secrets, 2FA disabled, local DB/Redis/PostHog/Twilio/Postmark/voice-token values.
- `api` mounts `.cycloid/python` into `/usr/src/app/.cycloid-python:ro` and prepends it to `PYTHONPATH`.
- `web`: `node` image, working dir `dashboard`, command `sh ../.cycloid/scripts/dashboard-dev.sh`, volume-mounted repo, persistent `dashboard-node-modules`, `NEXT_PUBLIC_API_URL=http://127.0.0.1:18000`.

### Minimal Product File Changes

- `dashboard/package.json`
  - add `dev:cycloid`: run Next.js on `0.0.0.0:3000`
  - add `typecheck`: alias the repo's existing TypeScript check
- `core/.dockerignore`
  - exclude local virtualenvs, caches, coverage output, logs, and editor files (local Python artifacts can overwrite or pollute Docker builds)

## B. Changes In Our Repo

- Make Cycloid's sandbox capable of running the repo's normal workflows: frontend dev server and typecheck, Python tests, database/migration checks, Docker Compose runtime, infra validation, browser screenshots.
- Add a repo resource override for `trycycloid/mia-copy` (default sandbox too small).
- Put repo-specific verification in `.cycloid.json` `verify.test` rules using `mia-copy` examples: `just` test/check targets, `uv` Python test commands, dbt parse/build/test, Alembic/migration validation, Dagster validation, Docker/Terraform/Terragrunt/actionlint-style infra checks.
- Support `.cycloid.json verify.test.rules` in `apps/sandbox-bridge/src/utils/pre-publish-tests.ts` so pre-publish verification runs the command matching changed paths instead of one global command.
- Skip configured verification for docs-only changes.
- Redact configured-test output and fail if a verification command mutates tracked files.
- Bootstrap repo-declared hooks before publishing, especially pre-commit hooks.
- Run git commit hooks with Cycloid secrets removed from the hook environment.
- Support repo-owned `.cycloid/setup.sh` for dependency setup or codegen when lockfile autodetection is not enough.
- Make setup and verification timeouts configurable for slow repos; size from measured cold-start/check duration, not a shared default.
- Add Cycloid tests for every new path bucket, proof command, sandbox tool, and setup/hook behavior learned from `mia-copy`.

## Checklist For The Next Client

- Can the app start from `.cycloid.json` without external production services?
- Can Cycloid authenticate into a seeded/local test account?
- Are changed files classified into the right buckets?
- Are the repo's normal verification commands accepted as evidence?
- Do pre-publish rules run the narrowest useful command for each changed path?
- Does the sandbox have the tools and resources needed to run those commands?
- Do repo setup scripts and hooks run before publish without exposing secrets?
- Are readiness, auth, setup, and verification timeouts based on observed repo speed?
