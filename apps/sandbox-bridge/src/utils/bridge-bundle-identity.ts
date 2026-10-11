import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { BridgeBundleIdentity, BridgeBundleSource } from "../../../../shared/types/sandbox.js";

// ARC-1512: the sandbox bridge bundle is baked into the Freestyle base snapshot and
// goes silently stale. The control plane injects a fresh bundle at Freestyle session
// start and records the injected bundle's identity in the session env:
//   ARCANIST_BRIDGE_BUNDLE_SHA256 — sha256 of the raw injected bundle (absent when no
//                                   injection happened, e.g. E2B or the baked path)
//   ARCANIST_BRIDGE_BUNDLE_SOURCE — "injected" | "baked" (absent on E2B / old paths)
// When the sha is absent we self-hash the running bundle file so the runtime report
// still identifies which build is executing. All errors degrade to "unknown" rather
// than throwing — bundle identity is observability, never a boot gate.
export type ResolveBridgeBundleIdentityEnv = {
  ARCANIST_BRIDGE_BUNDLE_SHA256?: string;
  ARCANIST_BRIDGE_BUNDLE_SOURCE?: string;
  ARCANIST_BRIDGE_BUNDLE_PATH?: string;
};

export type ResolveBridgeBundleIdentityDeps = {
  env: ResolveBridgeBundleIdentityEnv;
  /** Path to the running bundle; the bridge passes `process.argv[1]`. */
  bundlePath?: string;
  /** Injectable file reader for tests; defaults to `fs.readFileSync`. */
  readBundle?: (path: string) => Buffer | string;
};

function normalizeSource(value: string | undefined): BridgeBundleSource | undefined {
  return value === "injected" || value === "baked" ? value : undefined;
}

function normalizeSha(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveBridgeBundleIdentity(deps: ResolveBridgeBundleIdentityDeps): BridgeBundleIdentity {
  const { env } = deps;
  const envSource = normalizeSource(env.ARCANIST_BRIDGE_BUNDLE_SOURCE);
  const envSha = normalizeSha(env.ARCANIST_BRIDGE_BUNDLE_SHA256);

  // Control plane injected a fresh bundle and told us its sha: trust it verbatim.
  if (envSha) {
    return { bridgeBundleSha256: envSha, bridgeBundleSource: envSource ?? "injected" };
  }

  // No injection env: we are running the baked bundle. Self-hash it so the report
  // still carries an identity for the running build.
  const source = envSource ?? "baked";
  const bundlePath = env.ARCANIST_BRIDGE_BUNDLE_PATH || deps.bundlePath;
  if (!bundlePath) {
    return { bridgeBundleSha256: "unknown", bridgeBundleSource: source };
  }
  try {
    const read = deps.readBundle ?? ((path: string) => readFileSync(path));
    const sha = createHash("sha256").update(read(bundlePath)).digest("hex");
    return { bridgeBundleSha256: sha, bridgeBundleSource: source };
  } catch {
    return { bridgeBundleSha256: "unknown", bridgeBundleSource: source };
  }
}
