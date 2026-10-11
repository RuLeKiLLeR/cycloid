# Onboarding agent status

Snapshot of the Cycloid onboarding agent (`--onboarding`) as of 2026-06-23 (ARC-1286): what it currently produces, what is validated, and the known gaps. Behavior spec: [prompt-agents.md](prompt-agents.md#onboarding-agent). Prompt source of truth: `buildOnboardingAgentGuidance()` in `apps/sandbox-bridge/src/constants/bridge.ts` (the layer rungs are `buildSandboxLayerGuidance()`, spliced in), pinned by `tests/test_agent/constants.test.ts`.

## What it produces

A full runtime + test contract, published automatically as a setup PR:

- `.cycloid.json` — `appRuntime` (kind `web`, runner `docker`, compose entry on `service: api`), `composeEnv`, readiness route, `verify`.
- `.cycloid/docker-compose.yml` — the local runtime, built from the repo's own `deploy/Dockerfile*` rather than hand-rewritten.
- `.cycloid/sandbox.layer.Dockerfile` + `sandbox.yaml` — host toolchain layer + smoke checks, only when the base sandbox lacks something (see Detection).
- `.cycloid/setup.sh`, verify scripts, `CYCLOID.md`.

## Runtime strategy (converged)

**Container-first.** Postgres, Redis, and the app run as compose containers built from the repo's authoritative Dockerfiles, so the app's system dependencies (DB extensions, GDAL/proj, etc.) track production automatically. The **host sandbox layer stays thin** — only toolchains that run directly on the host: compiled-language builds the agent invokes outside containers, and CLIs the repo's CI invokes on the host. Tools a service's own image provides stay out of the host layer (replacing the earlier maximal all-host layers that duplicated the containers).

## Detection (what goes in the host layer)

Enumerated across the whole tree from three sources, then reconciled against the base sandbox:

1. toolchain manifests (`go.mod`, `Cargo.toml`, `*.tf`, `pom.xml`, …),
2. **CI workflow run-steps — a first-class detector, and the durable signal when source is stripped** (an IP-safe skeleton keeps its CI workflows but deletes the source a manifest scan keys on),
3. the repo's own Dockerfiles.

A tool already in the base, or provided inside a service's own image, is skipped. Anything else the repo builds/tests/runs/deploys with — a language runtime, a standalone CLI (IaC/cloud/codegen), or a system library a dependency wraps — is a layer entry. The layer is authored and statically validated in-session; it is built post-merge via the handoff command (see [sandbox-templates.md](sandbox-templates.md)).

## Validation (on `openevidence-skeleton-new`)

| Property                                                     | State                                                                                                                            | Evidence                                                                                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Post-merge build handoff uses the repo's real default branch | ✅ emits `--ref main`, never a guessed `master`                                                                                  | cycloid#5520                                                                                                                   |
| CI-only toolchains detected when source is stripped          | ✅ Terraform caught from `terraform-validate.yaml` once the `*.tf` source is absent                                              | cycloid#5566; skeleton-new PR #4 (missed Terraform + gcloud) → PR #5 (caught both, plus the rust/java/gradle already in PR #4) |
| Readiness route                                              | ✅ `/probes/readiness/`, matching the api's CI gate (`merge-queue-python.yaml`)                                                  |                                                                                                                                |
| Container/host boundary                                      | ✅ host layer adds only host-run tools; no false postgis/redis/GDAL host adds                                                    |                                                                                                                                |
| Coverage vs real work                                        | ✅ sufficient for the full spectrum of work on `openevidence-skeleton` (backend / frontend / compose / docs across its open PRs) |                                                                                                                                |

Skeleton validation is static (see gaps) — the table cites detection and PR evidence, not a live boot.

## Known gaps & limitations

- **Transitive system libraries a package wraps** (e.g. `poppler-utils` via the `pdf2image` dependency) have no structural signal in manifests, CI, or Dockerfiles — they surface only by running the code, which a non-bootable skeleton cannot do. This is the residual ~10%; the guidance intentionally does not chase it.
- **Skeleton onboarding caps at static `cycloid sandbox validate`.** An IP-safe skeleton cannot boot, so the runtime/layer are authored from preserved infra and validated statically, not booted or smoke-run in-session. The post-merge `cycloid sandbox build` is the first real build; `ready.timeoutSeconds` (180) is a conservative placeholder until then.
- **Mild over-inclusion.** Broadened detection can pull in deploy-only CLIs (e.g. `gcloud`) that the in-sandbox dev/test loop does not strictly need. Defensible — CI invokes them on the host — but heavier than minimal.

## Fix history (ARC-1286)

- **cycloid#5520** — handoff build command reads the default branch from git instead of guessing `main`/`master`.
- **cycloid#5566** — sandbox-layer detection broadened beyond language runtimes, and CI workflows promoted to a first-class detector, so CI-evident, base-missing tools (e.g. an IaC CLI) are caught even when source manifests are stripped. The Dockerfile `FROM` base image was deliberately excluded as a host signal (it is container-provided).

## References

- Prompt source: `apps/sandbox-bridge/src/constants/bridge.ts`; pins in `tests/test_agent/constants.test.ts`.
- Behavior spec: [prompt-agents.md](prompt-agents.md#onboarding-agent). Templates: [sandbox-templates.md](sandbox-templates.md). Skeleton onboarding: [prepare-skeleton](../.claude/skills/prepare-skeleton/SKILL.md).
