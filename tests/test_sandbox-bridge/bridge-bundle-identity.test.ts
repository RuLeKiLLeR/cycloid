import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { resolveBridgeBundleIdentity } from "../../apps/sandbox-bridge/src/utils/bridge-bundle-identity";

describe("resolveBridgeBundleIdentity", () => {
  it("passes through the injected sha and source from env", () => {
    const identity = resolveBridgeBundleIdentity({
      env: {
        ARCANIST_BRIDGE_BUNDLE_SHA256: "abc123",
        ARCANIST_BRIDGE_BUNDLE_SOURCE: "injected",
      },
      bundlePath: "/app/bridge/bundle.js",
      readBundle: () => {
        throw new Error("should not read the file when the sha env is present");
      },
    });
    expect(identity).toEqual({ bridgeBundleSha256: "abc123", bridgeBundleSource: "injected" });
  });

  it("defaults source to injected when only the sha env is present", () => {
    const identity = resolveBridgeBundleIdentity({
      env: { ARCANIST_BRIDGE_BUNDLE_SHA256: "  deadbeef  " },
    });
    expect(identity).toEqual({ bridgeBundleSha256: "deadbeef", bridgeBundleSource: "injected" });
  });

  it("self-hashes the running bundle and reports baked when the sha env is absent", () => {
    const contents = "console.log('bridge');";
    const expected = createHash("sha256").update(contents).digest("hex");
    const readBundle = vi.fn(() => contents);
    const identity = resolveBridgeBundleIdentity({
      env: {},
      bundlePath: "/app/bridge/bundle.js",
      readBundle,
    });
    expect(readBundle).toHaveBeenCalledWith("/app/bridge/bundle.js");
    expect(identity).toEqual({ bridgeBundleSha256: expected, bridgeBundleSource: "baked" });
  });

  it("prefers ARCANIST_BRIDGE_BUNDLE_PATH over the argv bundlePath for self-hashing", () => {
    const readBundle = vi.fn(() => "x");
    resolveBridgeBundleIdentity({
      env: { ARCANIST_BRIDGE_BUNDLE_PATH: "/env/path/bundle.js" },
      bundlePath: "/argv/bundle.js",
      readBundle,
    });
    expect(readBundle).toHaveBeenCalledWith("/env/path/bundle.js");
  });

  it("reports unknown sha (never throws) when reading the bundle fails", () => {
    const identity = resolveBridgeBundleIdentity({
      env: {},
      bundlePath: "/app/bridge/bundle.js",
      readBundle: () => {
        throw new Error("ENOENT");
      },
    });
    expect(identity).toEqual({ bridgeBundleSha256: "unknown", bridgeBundleSource: "baked" });
  });

  it("reports unknown sha when no bundle path can be resolved", () => {
    const identity = resolveBridgeBundleIdentity({ env: {} });
    expect(identity).toEqual({ bridgeBundleSha256: "unknown", bridgeBundleSource: "baked" });
  });

  it("keeps an explicit baked source even on the self-hash error path", () => {
    const identity = resolveBridgeBundleIdentity({
      env: { ARCANIST_BRIDGE_BUNDLE_SOURCE: "baked" },
      bundlePath: "/app/bridge/bundle.js",
      readBundle: () => {
        throw new Error("boom");
      },
    });
    expect(identity).toEqual({ bridgeBundleSha256: "unknown", bridgeBundleSource: "baked" });
  });
});
