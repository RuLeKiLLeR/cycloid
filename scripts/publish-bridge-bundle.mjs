#!/usr/bin/env node
// Publishes the runtime-injected Freestyle boot artifacts to an R2 bucket:
//   * the built sandbox-bridge bundle (ARC-1512)
//   * apps/sandbox-e2b/start-bridge.sh (ARC-1566)
// Freestyle base snapshots bake both files and go silently stale between rebuilds;
// publishing on every deploy that can change them keeps R2 authoritative at session
// start, with the baked copies remaining fallback-only.
//
// Uploads are content-addressed: the raw bundle's sha256 names the blob at
// `bridge/<sha256>.js.gz`, and a small `bridge/current.json` pointer records which
// blob is current. The blob is immutable, so a matching key is skipped (the pointer
// is always rewritten). Fails loudly — a deploy that ships without publishing would
// silently recreate the staleness bug.
//
// Usage:
//   node scripts/publish-bridge-bundle.mjs --bucket <name>
//     [--file <bundle-path>] [--start-bridge-file <script-path>]
// Auth: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (same as the deploy workflow).

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

export const BRIDGE_KEY_PREFIX = "bridge/";
export const POINTER_KEY = "bridge/current.json";
export const DEFAULT_BUNDLE_PATH = "apps/sandbox-bridge/dist/bundle.js";
export const START_BRIDGE_KEY_PREFIX = "start-bridge/";
export const START_BRIDGE_POINTER_KEY = "start-bridge/current.json";
export const DEFAULT_START_BRIDGE_PATH = "apps/sandbox-e2b/start-bridge.sh";

export function computeSha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** Content-addressed R2 key for a raw-bundle sha256. Blob is gzip-encoded. */
export function contentAddressedKey(sha256) {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`Expected a 64-char hex sha256, got: ${sha256}`);
  }
  return `${BRIDGE_KEY_PREFIX}${sha256}.js.gz`;
}

/** Content-addressed R2 key for a raw start-bridge.sh sha256. Blob is gzip-encoded. */
export function contentAddressedStartBridgeKey(sha256) {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`Expected a 64-char hex sha256, got: ${sha256}`);
  }
  return `${START_BRIDGE_KEY_PREFIX}${sha256}.sh.gz`;
}

/** Pointer object written to bridge/current.json. Shape is the injection contract (PR 2). */
export function buildPointer({ sha256, key, bytes, gzBytes, builtAt, gitSha }) {
  return { sha256, key, bytes, gzBytes, builtAt, gitSha };
}

function resolveGitSha() {
  // Prefer the checked-out commit: on manual dispatches the deployed ref can differ
  // from the workflow event's GITHUB_SHA, and the pointer must record the commit the
  // bundle was actually built from.
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return process.env.GITHUB_SHA || "unknown";
  }
}

function r2ObjectPut(bucket, key, file, { contentType } = {}) {
  const args = ["wrangler", "r2", "object", "put", `${bucket}/${key}`, "--remote", "--file", file];
  if (contentType) args.push("--content-type", contentType);
  const result = spawnSync("npx", args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`wrangler r2 object put failed for ${bucket}/${key} (exit ${result.status})`);
  }
}

function uploadArtifact(bucket, key, pointerKey, contentType, pointerContentType, bytes, gz, sha256, gitSha, builtAt) {
  const workDir = mkdtempSync(path.join(tmpdir(), "bridge-bundle-"));
  try {
    const blobPath = path.join(workDir, path.basename(key));
    writeFileSync(blobPath, gz);
    console.log(`Uploading ${key} (raw ${bytes}B, gz ${gz.length}B) to ${bucket}`);
    r2ObjectPut(bucket, key, blobPath, { contentType });

    const pointerPath = path.join(workDir, `${path.basename(pointerKey)}.json`);
    writeFileSync(
      pointerPath,
      JSON.stringify(
        buildPointer({
          sha256,
          key,
          bytes,
          gzBytes: gz.length,
          builtAt,
          gitSha,
        }),
      ),
    );
    console.log(`Updating pointer ${pointerKey} -> ${sha256}`);
    r2ObjectPut(bucket, pointerKey, pointerPath, { contentType: pointerContentType });
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
}

function publish({ bucket, bundlePath, startBridgePath }) {
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set to publish Freestyle boot artifacts");
  }
  const builtAt = new Date().toISOString();
  const gitSha = resolveGitSha();

  const bundleBuf = readFileSync(bundlePath);
  const bundleSha256 = computeSha256(bundleBuf);
  const bundleGz = gzipSync(bundleBuf);
  uploadArtifact(
    bucket,
    contentAddressedKey(bundleSha256),
    POINTER_KEY,
    "application/gzip",
    "application/json",
    bundleBuf.length,
    bundleGz,
    bundleSha256,
    gitSha,
    builtAt,
  );

  const startBridgeBuf = readFileSync(startBridgePath);
  const startBridgeSha256 = computeSha256(startBridgeBuf);
  const startBridgeGz = gzipSync(startBridgeBuf);
  uploadArtifact(
    bucket,
    contentAddressedStartBridgeKey(startBridgeSha256),
    START_BRIDGE_POINTER_KEY,
    "application/gzip",
    "application/json",
    startBridgeBuf.length,
    startBridgeGz,
    startBridgeSha256,
    gitSha,
    builtAt,
  );

  console.log(`Published bridge bundle ${bundleSha256} and start-bridge.sh ${startBridgeSha256} to ${bucket}`);
}

function parseArgs(argv) {
  let bucket;
  let bundlePath = DEFAULT_BUNDLE_PATH;
  let startBridgePath = DEFAULT_START_BRIDGE_PATH;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--bucket" || argv[i] === "--file" || argv[i] === "--start-bridge-file") {
      if (i + 1 >= argv.length) throw new Error(`${argv[i]} requires a value`);
      if (argv[i] === "--bucket") bucket = argv[i + 1];
      else if (argv[i] === "--file") bundlePath = argv[i + 1];
      else startBridgePath = argv[i + 1];
      i += 1;
    }
  }
  return { bucket, bundlePath, startBridgePath };
}

const isDirectInvocation = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isDirectInvocation) {
  const { bucket, bundlePath, startBridgePath } = parseArgs(process.argv.slice(2));
  if (!bucket) {
    console.error(
      "Usage: publish-bridge-bundle.mjs --bucket <name> [--file <bundle-path>] [--start-bridge-file <script-path>]",
    );
    process.exit(1);
  }
  try {
    publish({ bucket, bundlePath, startBridgePath });
  } catch (error) {
    console.error(
      `Failed to publish Freestyle boot artifacts: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
