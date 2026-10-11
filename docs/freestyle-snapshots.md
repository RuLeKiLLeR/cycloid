# Freestyle Snapshots (Base + Prebaked Repo Images)

How Freestyle-routed sessions get their VM images, how to rebuild/rotate them safely, and the landmines already paid for. E2B has a parallel image system (templates via `deploy-e2b-sandbox.yml`); this doc is the Freestyle side plus the shared boot script.

## Model

- Every session VM boots FROM a snapshot (frozen disk image). Two kinds exist:
  - **Base** (`base-<date>`, `FREESTYLE_DEFAULT_SNAPSHOT_ID`): the toolchain — OS, node, agent CLIs (codex/claude_code/opencode), browser, docker, egress wrappers, `ready-check.sh`, the sandbox helper scripts, and baked fallback copies of `start-bridge.sh` + the **bridge bundle**. No repo.
  - **Prebaked repo** (`<repo>-sha-<commit8>`; customer repos keep the owner: `openevidence-xyla-sha-…`): base + the repo cloned + deps installed. Mapped per repo in `FREESTYLE_REPO_SNAPSHOT_MAP_JSON` (wrangler `[vars]`; same shape as `E2B_REPO_SNAPSHOT_MAP_JSON`).
- The prebaked image is NOT a separate code path. `start-bridge.sh` adapts to disk state: repo present → `git fetch` + `checkout -B <branch> FETCH_HEAD` (code is always current); `node_modules` present AND lockfile sha256 matches `node_modules/.cycloid-lockfile-hash` → reuse; else install. Effect: cycloid cold boot ~66s → ~17s.
- Per-session secrets are injected at boot (bridge start command env), never baked. The repo builder deletes its clone token inside the clone script and fails the build if any credential-shaped string survives.
- The per-repo id travels on `E2BCreateSandboxRequest.freestyleSnapshotId` — never the `template` slot (that carries E2B ids the Freestyle client must ignore).
- Resolution + the opencode capability gate happen at the spawn boot-strategy step in `durable-object.ts` (repo visibility/branch resolve too late for the early preflight). Snapshot ids must be in `FREESTYLE_SNAPSHOT_ADVERTISED_AGENT_RUNTIME_BACKENDS` (`base-template-service.ts`) or opencode fails closed.
- **Kill switch**: empty the repo's map entry (or the var) and redeploy → sessions fall back to the base snapshot's clone path. Used live 2026-07-08.

## The rule that bites: rebuild-only baked content ships ONLY via rotation

The sandbox helper scripts under `apps/sandbox-e2b/scripts`, the egress wrappers, `ready-check.sh`, and the pinned CLI/toolchain versions are frozen inside the base snapshot. **Merging a change to any of them ships nothing to Freestyle sessions** until the base is rebuilt and rotated. The drift-gate test that enforced this (`tests/test_scripts/freestyle-base-manifest.test.ts`) was removed while Freestyle is benched; `apps/sandbox-e2b/freestyle-base-manifest.json` and the base builder are retained, so re-add the drift gate when Freestyle comes back off the bench.

`start-bridge.sh` and the bridge bundle are different: deploys publish fresh copies to R2 and `startCommand` injects them before launch, with the baked snapshot copies kept only as fallback. That means they no longer require a base rotation to ship, but an injection failure can still temporarily fall back to the baked copy until the next successful session start.

## Runbooks

### Rebuild + rotate the base (~12 min)

1. `npm run bundle -w @cycloid/sandbox-bridge`
2. `FREESTYLE_API_KEY=… node scripts/freestyle-build-base-snapshot.mjs --verify` — full-parity build, smokes, verify boot; writes the manifest.
3. One PR: `FREESTYLE_DEFAULT_SNAPSHOT_ID` (wrangler) + a capability-map entry for the new id (keep the old id mapped while sessions that booted from it are in flight) + the regenerated manifest.
4. Rebuild dependent prebaked repo snapshots from the new base and re-map them (they inherit the old base's rebuild-only files otherwise).
5. Retire the old base later: delete by exact id, drop its capability entry (ARC-1505).

### Build + register a prebaked repo snapshot (~2 min)

1. `GITHUB_TOKEN=$(gh auth token) FREESTYLE_API_KEY=… node scripts/freestyle-build-repo-snapshot.mjs --repo <owner>/<name> --verify`
   - `--disk-gb` pins a disk FLOOR every booting session inherits; if the repo also has an explicit `REPO_SANDBOX_SPECS` sizing entry, its `diskGB` must be ≥ the floor (ARC-1510).
   - `--verify` boots a throwaway VM and checks prebaked preconditions + sanitize invariants + tokenless-fetch-denied. It does NOT yet run start-bridge (ARC-1504) — a green build does not prove a bootable session.
2. One PR: map entry (`{"snapshotId": …, "allowPrivate": true}` for private repos) + capability-map entry.
3. Rebuild on lockfile drift: boots self-heal (hash gate → reinstall) but pay full install until the snapshot is rebuilt.

## Staleness model (what can go stale, per layer)

| Layer                       | Detector                                                                                                        | Failure mode                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Repo code                   | none needed — fetched every boot                                                                                | never stale                                                                                       |
| Dependencies                | lockfile-hash marker → reinstall on drift                                                                       | slow boot only, never wrong                                                                       |
| Rebuild-only scripts / pins | manifest CI gate                                                                                                | blocked at PR time                                                                                |
| `start-bridge.sh`           | control-plane startCommand inject/fallback logs                                                                 | injected fresh at session start from R2; baked copy is fallback only                              |
| Bridge bundle               | runtime report `bridgeBundleSha256` / `bridgeBundleSource` + `arcanist.freestyle.bridge_bundle_fallback` metric | injected fresh at session start from R2 (published each prod deploy); baked copy is fallback only |

## Dashboard reading rules

- Named snapshots are ours; **unnamed ones are Freestyle-derived layers** (created on first boot of a configured snapshot; running VMs report derived ids, not configured ids). Never delete them — one backs every live boot path.
- The FIRST boot of a freshly minted snapshot can stall in state `building` for minutes (derived-layer materialization) and blow the 3-min warm connect timeout; `--verify`'s boot usually pre-materializes (ARC-1506).
- No rename API: the name minted at build time is permanent.

## Landmines (all hit live; do not relearn)

- **Snapshots capture `/tmp`.** A snapshot minted by one build carries that build's detached-script markers; a later build reusing the same names replays them and fake-succeeds. Builders use per-run unique names and scrub `/tmp/cycloid-build-*` (boot + pre-snapshot).
- **`vm.exec` shell-parses the command string.** Embedded scripts must be `shellSingleQuote`d (`freestyle-build-common.mjs`) — `JSON.stringify` quoting deterministically syntax-errors. A single exec dies after ~5 min regardless of `timeoutMs`; long steps run detached (write script → setsid → poll `.rc`).
- **start-bridge's own git must bypass the agent policy wrapper.** The wrapper denies `checkout -B` (agent branch creation); the prebaked path requires it. `start-bridge.sh` defines a `git()` function resolving the real binary (`ARCANIST_REAL_GIT_PATH` → `/usr/local/lib/cycloid/real-bin/git` → PATH). Agent processes still get the wrapper.
- **Never `npm ci` on a prebaked drift path** — it deletes `node_modules` before installing (failed reinstall = zero deps). Drift uses `npm install` + restores a rewritten lockfile and reports failure instead of dirtying the checkout.
- **Shared prod Freestyle account**: one builder VM at a time; delete by exact id; never bulk list-and-delete; never snapshot a live session VM (baked credentials/dirty state).
- SDK quirks: `vm.exec` returns `statusCode`; fs writes cap at 8MB (gzip the bundle); `vms.get` is a no-op (use untyped `vm.getInfo()`); deletion is a boolean `deleted` field; sizing knobs (`memSizeGb` pow2 / `vcpuCount` pow2 ≤32 / `rootfsSizeGb`) are untyped and forwarded under `template`.

## Measuring boots (Datadog us5)

- Bridge `@event:sandbox.spawn` (service `cycloid-sandbox-bridge`): `spawn_duration_ms`, `repo_prep_path` (clone|fetch), `repo_prep_ms` (also aliased as `clone_ms`/`fetch_ms`), `spawn_path`, `runtime_backend`, `repo`.
- Install window: `@event:prompt.dispatch @step:workspace_setup_timing` → `setup_kind` (`npm`|`repo_setup_script`|`*_skip_existing`) + `setup_execution_ms`. No repo tag — join via `session_id`.
- A healthy prebaked boot: `repo_prep_path:fetch` + `setup_kind:npm_skip_existing` + spawn ~15–20s.
