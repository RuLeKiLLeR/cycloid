#!/usr/bin/env node
// Split a flat { KEY: value, ... } secrets JSON file into N chunk files of
// up to BATCH_SIZE keys each. The Cloudflare `wrangler secret bulk` endpoint
// rejects requests with more than 25 secrets ([code: 100160]); we chunk to 20
// to leave headroom against further tightening.
//
// Usage:
//   node scripts/chunk-secrets-for-bulk.mjs <input.json> <output-prefix>
//
// Writes one file per batch (<prefix>-0.json, <prefix>-1.json, ...) and prints
// the batch count to stdout so the calling shell can loop over them.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_BATCH_SIZE = 20;

export function chunkSecrets(secrets, batchSize = DEFAULT_BATCH_SIZE) {
  if (secrets === null || typeof secrets !== "object" || Array.isArray(secrets)) {
    throw new Error("expected a flat object of { KEY: value } secrets");
  }
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error("batchSize must be a positive integer");
  }
  const entries = Object.entries(secrets);
  const batches = [];
  for (let i = 0; i < entries.length; i += batchSize) {
    batches.push(Object.fromEntries(entries.slice(i, i + batchSize)));
  }
  return batches;
}

function main() {
  const inputPath = process.argv[2];
  const outputPrefix = process.argv[3];
  if (!inputPath || !outputPrefix) {
    console.error("Usage: node scripts/chunk-secrets-for-bulk.mjs <input.json> <output-prefix>");
    process.exit(2);
  }
  const batchSizeArg = process.env.SECRET_BULK_BATCH_SIZE;
  let batchSize = DEFAULT_BATCH_SIZE;
  if (batchSizeArg) {
    const parsed = Number(batchSizeArg);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      console.error(`SECRET_BULK_BATCH_SIZE must be a positive integer, got "${batchSizeArg}"`);
      process.exit(2);
    }
    batchSize = parsed;
  }

  const secrets = JSON.parse(readFileSync(inputPath, "utf8"));
  const batches = chunkSecrets(secrets, batchSize);
  for (let i = 0; i < batches.length; i++) {
    writeFileSync(`${outputPrefix}-${i}.json`, JSON.stringify(batches[i]));
  }
  // Single line of stdout: the number of batches written. The shell consumes
  // this directly via $(node ...).
  process.stdout.write(String(batches.length));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
