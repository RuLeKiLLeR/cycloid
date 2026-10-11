#!/usr/bin/env node

// Single source of truth for the `wrangler versions upload` version-id parser.
//
// `versions upload` has no --json flag; its machine-readable output is written
// as NDJSON to WRANGLER_OUTPUT_FILE_PATH. The control-plane deploy
// (deploy-control-plane-core.yml) needs the candidate version id to hand to
// `versions deploy`. This parser walks that NDJSON and returns the version_id
// from the last version-upload record with a non-null id.
//
// It lives here (rather than as inline `node -e` duplicated across the prod and
// QA deploy steps) so there is one tested implementation, and so the PR-time
// guard (validate-deploy-commands.yml) exercises the real parser, not a
// lookalike.
//
// CLI exit codes (fail-closed, matching the previous inline behavior):
//   0  a version_id was found -> written to stdout
//   3  a version-upload record exists but its version_id was null/absent
//   4  no version-upload record was found in the NDJSON
//   5  the NDJSON input could not be read (missing/unreadable file)
// The prod/QA deploy needs exit 0. The guard runs against `--dry-run` output,
// which emits a version-upload record with a null id, so it accepts exit 0 or 3
// and fails on anything else (4 = contract broke, 5 = read error, or a crash).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const NO_RECORD_MESSAGE = "no version-upload record found in wrangler output";
export const NULL_ID_MESSAGE = "version-upload record present but its version_id was null";

/**
 * Parse `wrangler versions upload` NDJSON output for the candidate version id.
 * Returns whether any version-upload record was seen and the last non-null id.
 * A later record with a null id does not clobber an earlier non-null id, so the
 * behavior matches the previous inline deploy parser exactly.
 */
export function extractVersionId(ndjson) {
  let sawRecord = false;
  let id = null;
  for (const line of String(ndjson).split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record && record.type === "version-upload") {
      sawRecord = true;
      if (record.version_id) id = record.version_id;
    }
  }
  return { sawRecord, id };
}

function main() {
  const path = process.argv[2];
  let ndjson;
  try {
    // A path argument reads that file; no argument reads stdin (fd 0).
    ndjson = readFileSync(path ?? 0, "utf8");
  } catch (error) {
    console.error(`Unable to read wrangler output: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 5;
    return;
  }
  const { sawRecord, id } = extractVersionId(ndjson);
  if (id) {
    process.stdout.write(id);
    return;
  }
  if (sawRecord) {
    console.error(NULL_ID_MESSAGE);
    process.exitCode = 3;
    return;
  }
  console.error(NO_RECORD_MESSAGE);
  process.exitCode = 4;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
