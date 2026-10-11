---
name: prepare-skeleton
description: Produce an IP-safe skeleton + manifest of a customer repo so Cycloid can be verified against their stack without us seeing their source. The customer runs the script on their own machine; they review and send back the skeleton. Use when onboarding an IP-sensitive customer who will not share their repo.
user_invocable: true
argument: optional customer/repo label for the handoff notes
---

# Prepare an IP-safe repo skeleton

For a customer who will **not** let us see or run Cycloid on their repo. We hand them one self-contained script; run locally, it emits an IP-safe skeleton (build/dep/CI config kept, source bodies stripped, secrets redacted, env values removed) plus a reviewable `MANIFEST.txt`. They review, zip, send. We run an onboarding session on the skeleton to produce a completable runtime config + fill-in checklist they finalize against their real code.

Inverse of `copy-customer-repo` (repos we already control); here the audience is the **customer**, on **their** machine.

## What the customer receives

One file: `scripts/make-skeleton.mjs` — zero-dependency (Node built-ins only, Node 18+), plain JavaScript they can read end-to-end before running. Send the file plus the quickstart below.

## What it does (so you can explain it)

Every tracked path (`git ls-files`) is classified into exactly one bucket; anything unrecognized is **skipped, never copied**:

| Bucket             | Examples                                                     | Treatment                                          |
| ------------------ | ------------------------------------------------------------ | -------------------------------------------------- |
| Allowlisted config | `package.json`, lockfiles, `Dockerfile`, CI yaml, `tsconfig` | copied verbatim, then secret-scanned               |
| Recognized source  | `.ts .py .go .java .kt .rb .rs .cs` …                        | stubbed: imports + signatures kept, bodies removed |
| Binary             | images, fonts, blobs                                         | name + size only                                   |
| Everything else    | docs, `.sql`, `.graphql`, fixtures, sample data              | skipped by default (`--include-text` to opt in)    |

Safety properties:

- Env files become **keys only**; values are never read.
- Verbatim files pass a secret scan (token assignments, PEM blocks, JWTs, `user:pass@` URLs, high-entropy strings) → redacted to `__REDACTED__`. Key/cert/credential files are never copied.
- Stubbing is **fail-safe**: every line is dropped unless it is an import or declaration header; kept declaration headers have string/number literals scrubbed. Kept import lines retain the module path (path disclosure, see below) but embedded credentials (`user:pass@` URLs, JWTs, high-entropy tokens) are scrubbed. Bodies, comments, and docstrings never survive, so logic does not leak.
- Reads tracked files only, from a clean worktree by default; symlinks are never followed (including under `--scan-local-env`).
- If residual secret-like content is detected, the script **does not produce the zip** and exits non-zero; the skeleton directory is still written for review. Re-run with `--accept-redactions --force` (`--force` needed because the directory now exists) to produce the zip anyway.

## Customer quickstart (copy-pastable)

```text
1. Save make-skeleton.mjs at the root of your repo.
2. From the repo root, run:
     node make-skeleton.mjs
   (commit or stash local changes first, or add --allow-dirty to skip modified files)
3. Review ./cycloid-skeleton/MANIFEST.txt — every file and exactly what was done to it.
   Review ./cycloid-skeleton/env-keys.txt — variable NAMES only, no values.
   Spot-check a few stubbed source files to confirm no logic remains.
4. (Optional) make the skeleton compile without restoring logic: open Claude Code inside
   ./cycloid-skeleton/ and paste prompt.md.
5. Send us ./cycloid-skeleton.zip (or zip the ./cycloid-skeleton/ directory yourself).
```

Useful flags: `--exclude <glob>` (drop sensitive paths), `--include-text <glob>` (include extra text files as stubs), `--no-zip`, `--force`, `--help`.

## Our side, after they send it

1. Unzip into a throwaway dir; skim `MANIFEST.txt` and `repo-stats.json` for scale and treatment.
2. Run `copy-customer-repo` semantics to push it private under `trycycloid` (the skeleton has no real IP), or point a local Cycloid session at it.
3. Drive an onboarding session to author the real runtime config (reconstructed from preserved infra) and a fill-in checklist for the customer. The skeleton cannot build/boot (stubbed bodies), so the session produces a completable handoff, not a green stack.

## Honest limits (state to the customer)

- Real services (DB/queue/external APIs) and real secret values are not reproduced.
- Private-registry deps need their credential at install time (we never receive it).
- Scale is approximated by `repo-stats.json`, not perfectly reproduced.
- File/directory **paths are preserved** and can themselves reveal naming; `--exclude` drops them.

## Out of scope

BYO/self-hosted sandbox so the repo never leaves the customer boundary — the real long-term answer for IP-sensitive customers, tracked separately.
