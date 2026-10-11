#!/usr/bin/env node
// ARC-1492: fail a prod deploy closed when Freestyle routing is enabled but the
// FREESTYLE_API_KEY that routed sessions will use is missing/CHANGE_ME. This runs on
// EVERY prod deploy (the full secret-sync validation only runs when infra/ssm.tf
// changed), so an app/workflow-only deploy that flips the override on can't ship a
// placeholder key green and then fail every routed session at spawn.
//
// It re-adds the guard that #7017 reverted, without re-causing the outage. The first
// attempt fetched with the *denied* `ssm:GetParameter`, masked the AccessDenied to an
// empty string, and failed closed — blocking every prod deploy. Two rules keep this
// safe:
//   1. Fetch only with `aws ssm get-parameters-by-path --path /cycloid/` (NON-
//      recursive) — the sole SSM read the prod OIDC role is granted
//      (infra/github-oidc.tf: GetParametersByPath allowed; singular GetParameter and
//      recursive path reads are denied). Same call the secret-sync step and the
//      schema-verify fallback already use.
//   2. NEVER treat a fetch failure as an absent key. Any aws error (non-zero exit,
//      binary missing, unparseable output) logs a warning and exits 0. The deploy is
//      only blocked when a *successful* read shows the key definitively absent or a
//      placeholder — a real signal, not a hiccup.
import { spawnSync } from "node:child_process";

import { readWranglerVar, validateControlPlaneSecrets } from "./validate-control-plane-secrets.mjs";

const FREESTYLE_PARAM = "/cycloid/FREESTYLE_API_KEY";

function envArg() {
  const arg = process.argv.find((value) => value.startsWith("--env="));
  return arg ? arg.slice("--env=".length).trim() || "production" : "production";
}

// Log and pass. A fetch that cannot be completed tells us nothing about the key, so
// it must not block the deploy (that regression is the whole point of ARC-1492).
function skip(reason) {
  console.warn(`::warning::Freestyle key guard skipped (deploy not blocked): ${reason}`);
  process.exit(0);
}

const env = envArg();

const fetched = spawnSync(
  "aws",
  [
    "ssm",
    "get-parameters-by-path",
    "--path",
    "/cycloid/",
    "--with-decryption",
    "--query",
    "Parameters[].{Name:Name,Value:Value}",
    "--output",
    "json",
  ],
  { encoding: "utf-8" },
);

if (fetched.error) skip(`aws could not be invoked (${fetched.error.message})`);
if (fetched.status !== 0) {
  skip(`aws exited ${fetched.status}: ${(fetched.stderr || "").trim() || "no stderr"}`);
}

let params;
try {
  params = JSON.parse(fetched.stdout || "[]");
} catch (error) {
  skip(`could not parse SSM output (${error instanceof Error ? error.message : String(error)})`);
}
if (!Array.isArray(params)) skip("unexpected SSM output shape (expected a JSON array)");

// Absent from a *successful* read is a real signal (routing on, no key anywhere), so
// fall through to the validator with an empty value rather than skipping.
const hit = params.find((param) => param && param.Name === FREESTYLE_PARAM);
const bundle = { FREESTYLE_API_KEY: hit ? hit.Value : "" };

// Validate in-process via the shared validator's freestyle-only guarantees. No
// subprocess, so there is no validator spawn that could fail and block the deploy —
// the "a hiccup must never block deploys" rule holds for the whole check, not just the
// fetch (the aws read above is the only external step, and it already skips on error).
// Mirrors the validator's own main() wiring: routing is enabled when the env's wrangler
// override is non-empty; the snapshot id (ARC-1480) is gated under the same condition.
const clean = (value) => (typeof value === "string" ? value.trim() : "");
// readWranglerVar reads the in-repo, committed wrangler.toml — deterministic, not a
// network hiccup. A present-but-unparseable routing var is a real config defect, so it
// must BLOCK the deploy (exit 1), NOT route through skip() (exit 0) which would silently
// disarm this guard. Only the SSM fetch above is allowed to skip on error.
let requireFreestyleKey;
let freestyleSnapshotId;
try {
  requireFreestyleKey = clean(readWranglerVar(env, "FREESTYLE_SANDBOX_BACKEND_OVERRIDE")).length > 0;
  freestyleSnapshotId = clean(readWranglerVar(env, "FREESTYLE_DEFAULT_SNAPSHOT_ID"));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const errors = validateControlPlaneSecrets(bundle, {
  freestyleOnly: true,
  requireFreestyleKey,
  freestyleSnapshotId,
});
if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}
