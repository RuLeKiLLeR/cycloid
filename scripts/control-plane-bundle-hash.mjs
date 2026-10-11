#!/usr/bin/env node
// Computes the control-plane deploy-gate hash: sha256 over the dry-run bundle
// (`index.js`) plus the worker's wrangler config. The config is part of the
// hash so binding/var/DO-migration/compat-flag changes force a deploy even
// when the bundled JS is unchanged. The sourcemap is deliberately excluded:
// it is not byte-stable across builds.
//
// Usage: node scripts/control-plane-bundle-hash.mjs <bundle-index.js> <wrangler.toml>

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function computeBundleHash(files) {
  const hash = createHash("sha256");
  for (const content of files) {
    // Length-prefix each part so content cannot shift across part boundaries.
    hash.update(String(content.length));
    hash.update("\0");
    hash.update(content);
  }
  return hash.digest("hex");
}

const isDirectInvocation = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isDirectInvocation) {
  const [bundlePath, configPath] = process.argv.slice(2);
  if (!bundlePath || !configPath) {
    console.error("Usage: control-plane-bundle-hash.mjs <bundle-index.js> <wrangler.toml>");
    process.exit(1);
  }
  try {
    console.log(computeBundleHash([readFileSync(bundlePath), readFileSync(configPath)]));
  } catch (error) {
    console.error(`Failed to compute bundle hash: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
