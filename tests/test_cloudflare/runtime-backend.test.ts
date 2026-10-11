import { describe, expect, it, vi } from "vitest";

import {
  E2B_CLOUD_RUNTIME_BACKEND,
  FREESTYLE_RUNTIME_BACKEND,
  isKnownRuntimeProvider,
  isValidRuntimeBackend,
  KNOWN_RUNTIME_PROVIDERS,
  parsePersistedRuntimeBackend,
  providerForRuntimeBackend,
  resolveDogfoodFreestyleOverride,
  resolveRuntimeBackendForRepoSession,
  runtimeBackendOrNull,
  runtimeProviderOrNull,
  runtimeStateOrNull,
} from "../../apps/control-plane-worker/src/sandbox/runtime-backend";
import { ENVIRONMENT } from "../../shared/constants/environment";

describe("runtime backend config", () => {
  it("parses persisted backend values and rejects malformed values", () => {
    expect(parsePersistedRuntimeBackend(null)).toBe(E2B_CLOUD_RUNTIME_BACKEND);
    expect(parsePersistedRuntimeBackend("")).toBe(E2B_CLOUD_RUNTIME_BACKEND);
    expect(parsePersistedRuntimeBackend(E2B_CLOUD_RUNTIME_BACKEND)).toBe(E2B_CLOUD_RUNTIME_BACKEND);
    expect(parsePersistedRuntimeBackend("freestyle")).toBe("freestyle");
    expect(() => parsePersistedRuntimeBackend("cycloid_self_hosted_e2b")).toThrow(/Invalid runtime backend/);
    expect(() => parsePersistedRuntimeBackend("bogus")).toThrow(/Invalid runtime backend/);
  });

  it("runtimeBackendOrNull returns a known backend or null", () => {
    expect(runtimeBackendOrNull(null)).toBeNull();
    expect(runtimeBackendOrNull("")).toBeNull();
    expect(runtimeBackendOrNull(E2B_CLOUD_RUNTIME_BACKEND)).toBe(E2B_CLOUD_RUNTIME_BACKEND);
    expect(runtimeBackendOrNull("freestyle")).toBe("freestyle");
    expect(runtimeBackendOrNull("cycloid_self_hosted_e2b")).toBeNull();
    expect(runtimeBackendOrNull("bogus")).toBeNull();
  });

  it("isValidRuntimeBackend returns true for valid backends", () => {
    expect(isValidRuntimeBackend(E2B_CLOUD_RUNTIME_BACKEND)).toBe(true);
    expect(isValidRuntimeBackend("freestyle")).toBe(true);
    expect(isValidRuntimeBackend(null)).toBe(false);
    expect(isValidRuntimeBackend("")).toBe(false);
    expect(isValidRuntimeBackend("cycloid_self_hosted_e2b")).toBe(false);
    expect(isValidRuntimeBackend("bogus")).toBe(false);
  });

  it("runtimeProviderOrNull returns a known provider or null", () => {
    expect(runtimeProviderOrNull("e2b")).toBe("e2b");
    expect(runtimeProviderOrNull("freestyle")).toBe("freestyle");
    expect(runtimeProviderOrNull(null)).toBeNull();
    expect(runtimeProviderOrNull("")).toBeNull();
    expect(runtimeProviderOrNull("e2b_cloud")).toBeNull();
    expect(runtimeProviderOrNull("bogus")).toBeNull();
  });

  it("providerForRuntimeBackend derives the honest vendor tag from the backend", () => {
    expect(providerForRuntimeBackend(E2B_CLOUD_RUNTIME_BACKEND)).toBe("e2b");
    expect(providerForRuntimeBackend(FREESTYLE_RUNTIME_BACKEND)).toBe("freestyle");
  });

  it("isKnownRuntimeProvider is the 'has managed runtime' predicate (agrees with runtimeProviderOrNull)", () => {
    expect(isKnownRuntimeProvider("e2b")).toBe(true);
    expect(isKnownRuntimeProvider("freestyle")).toBe(true);
    // A cleared row (NULL) or a session that never had a managed runtime is excluded.
    expect(isKnownRuntimeProvider(null)).toBe(false);
    expect(isKnownRuntimeProvider(undefined)).toBe(false);
    expect(isKnownRuntimeProvider("")).toBe(false);
    // Stale/legacy or backend-shaped values are not providers.
    expect(isKnownRuntimeProvider("e2b_cloud")).toBe(false);
    expect(isKnownRuntimeProvider("modal")).toBe(false);
    expect(isKnownRuntimeProvider("bogus")).toBe(false);
    for (const value of ["e2b", "freestyle", null, "", "e2b_cloud", "modal", "bogus", 42]) {
      expect(isKnownRuntimeProvider(value)).toBe(runtimeProviderOrNull(value) != null);
    }
  });

  it("KNOWN_RUNTIME_PROVIDERS is the single source enumerating every backend's provider", () => {
    // Every backend must map to a member of the known set, and every known provider
    // must be derivable from some backend — so the SQL IN-list and the guards can
    // never drift from the write-derive mapping.
    for (const backend of [E2B_CLOUD_RUNTIME_BACKEND, FREESTYLE_RUNTIME_BACKEND] as const) {
      expect(KNOWN_RUNTIME_PROVIDERS).toContain(providerForRuntimeBackend(backend));
    }
    expect([...KNOWN_RUNTIME_PROVIDERS].sort()).toEqual(["e2b", "freestyle"]);
  });

  it("runtimeStateOrNull returns a known state or null", () => {
    expect(runtimeStateOrNull("running")).toBe("running");
    expect(runtimeStateOrNull("paused")).toBe("paused");
    expect(runtimeStateOrNull("killed")).toBe("killed");
    expect(runtimeStateOrNull(null)).toBeNull();
    expect(runtimeStateOrNull("")).toBeNull();
    expect(runtimeStateOrNull("bogus")).toBeNull();
  });
});

describe("resolveRuntimeBackendForRepoSession", () => {
  it("defaults to cloud when no inherited backend is set", () => {
    expect(resolveRuntimeBackendForRepoSession({})).toBe(E2B_CLOUD_RUNTIME_BACKEND);
    expect(resolveRuntimeBackendForRepoSession({ inheritedRuntimeBackend: null })).toBe(E2B_CLOUD_RUNTIME_BACKEND);
    expect(resolveRuntimeBackendForRepoSession({ inheritedRuntimeBackend: "" })).toBe(E2B_CLOUD_RUNTIME_BACKEND);
  });

  it("uses an inherited cloud backend", () => {
    expect(resolveRuntimeBackendForRepoSession({ inheritedRuntimeBackend: E2B_CLOUD_RUNTIME_BACKEND })).toBe(
      E2B_CLOUD_RUNTIME_BACKEND,
    );
  });

  it("throws when an inherited backend is no longer a valid value", () => {
    expect(() => resolveRuntimeBackendForRepoSession({ inheritedRuntimeBackend: "cycloid_self_hosted_e2b" })).toThrow(
      /Invalid runtime backend/,
    );
  });
});

describe("resolveDogfoodFreestyleOverride", () => {
  it("returns null (fall back to e2b_cloud) for an unset, empty, or whitespace override", () => {
    expect(resolveDogfoodFreestyleOverride(undefined, "42", null, ENVIRONMENT.Production)).toBeNull();
    expect(resolveDogfoodFreestyleOverride(null, "42", null, ENVIRONMENT.Production)).toBeNull();
    expect(resolveDogfoodFreestyleOverride("", "42", null, ENVIRONMENT.Production)).toBeNull();
    expect(resolveDogfoodFreestyleOverride("   ", "42", null, ENVIRONMENT.Production)).toBeNull();
  });

  it("routes every owner to freestyle when the override is 'all' AND the env is local", () => {
    expect(resolveDogfoodFreestyleOverride("all", "42", null, ENVIRONMENT.Local)).toBe(FREESTYLE_RUNTIME_BACKEND);
    // 'all' does not require an owner (local-dev only).
    expect(resolveDogfoodFreestyleOverride("all", null, null, ENVIRONMENT.Local)).toBe(FREESTYLE_RUNTIME_BACKEND);
  });

  it("rejects 'all' outside local: degrades to e2b_cloud and fires the loud-log callback", () => {
    // A fat-fingered 'all' in a deployed [vars] would route ALL customer traffic onto
    // the single shared Freestyle team. Treat it as unset (keep default e2b_cloud) and
    // surface a loud structured error rather than hard-throwing on every session.
    for (const env of [ENVIRONMENT.Production, ENVIRONMENT.Qa, ENVIRONMENT.Development, ENVIRONMENT.Test]) {
      const onReject = vi.fn();
      expect(resolveDogfoodFreestyleOverride("all", "42", "trycycloid", env, onReject)).toBeNull();
      expect(onReject).toHaveBeenCalledTimes(1);
    }
  });

  it("does not fire the reject callback when 'all' is honored in local", () => {
    const onReject = vi.fn();
    expect(resolveDogfoodFreestyleOverride("all", "42", null, ENVIRONMENT.Local, onReject)).toBe(
      FREESTYLE_RUNTIME_BACKEND,
    );
    expect(onReject).not.toHaveBeenCalled();
  });

  it("does not fire the reject callback for non-'all' overrides (callback is 'all'-specific)", () => {
    const onReject = vi.fn();
    expect(
      resolveDogfoodFreestyleOverride("org:trycycloid", "42", "trycycloid", ENVIRONMENT.Production, onReject),
    ).toBe(FREESTYLE_RUNTIME_BACKEND);
    expect(resolveDogfoodFreestyleOverride("7,99", "42", null, ENVIRONMENT.Production, onReject)).toBeNull();
    expect(onReject).not.toHaveBeenCalled();
  });

  it("routes an owner in the comma list to freestyle and others to e2b_cloud (any deployed env)", () => {
    expect(resolveDogfoodFreestyleOverride("7, 42 ,99", "42", null, ENVIRONMENT.Production)).toBe(
      FREESTYLE_RUNTIME_BACKEND,
    );
    expect(resolveDogfoodFreestyleOverride("7,99", "42", null, ENVIRONMENT.Production)).toBeNull();
  });

  it("fails closed to e2b_cloud when an owner-scoped override has no resolvable owner", () => {
    expect(resolveDogfoodFreestyleOverride("7,42", null, null, ENVIRONMENT.Production)).toBeNull();
    expect(resolveDogfoodFreestyleOverride("7,42", undefined, null, ENVIRONMENT.Production)).toBeNull();
    expect(resolveDogfoodFreestyleOverride("7,42", "", null, ENVIRONMENT.Production)).toBeNull();
  });

  it("matches numeric owner ids regardless of string/number representation", () => {
    expect(resolveDogfoodFreestyleOverride("42", "42", null, ENVIRONMENT.Production)).toBe(FREESTYLE_RUNTIME_BACKEND);
  });

  it("disables the whole override when any list entry is malformed (fail closed)", () => {
    // A typo must not silently opt the well-formed entries into the new backend.
    expect(resolveDogfoodFreestyleOverride("42,typo", "42", null, ENVIRONMENT.Production)).toBeNull();
    expect(resolveDogfoodFreestyleOverride("42,,7", "42", null, ENVIRONMENT.Production)).toBeNull();
    expect(resolveDogfoodFreestyleOverride("42,", "42", null, ENVIRONMENT.Production)).toBeNull();
    // 'all' as a comma-list entry (not the standalone literal) is just an invalid entry.
    expect(resolveDogfoodFreestyleOverride("all,42", "42", null, ENVIRONMENT.Production)).toBeNull();
    expect(resolveDogfoodFreestyleOverride("all,42", "42", null, ENVIRONMENT.Local)).toBeNull();
  });

  it("routes sessions on a listed org's repos via org: entries (case-insensitive)", () => {
    expect(resolveDogfoodFreestyleOverride("org:trycycloid", "42", "trycycloid", ENVIRONMENT.Production)).toBe(
      FREESTYLE_RUNTIME_BACKEND,
    );
    expect(resolveDogfoodFreestyleOverride("org:TryCycloid", "42", "trycycloid", ENVIRONMENT.Production)).toBe(
      FREESTYLE_RUNTIME_BACKEND,
    );
    expect(resolveDogfoodFreestyleOverride("org:trycycloid", "42", "TryCycloid", ENVIRONMENT.Production)).toBe(
      FREESTYLE_RUNTIME_BACKEND,
    );
    expect(resolveDogfoodFreestyleOverride("ORG:trycycloid", "42", "trycycloid", ENVIRONMENT.Production)).toBe(
      FREESTYLE_RUNTIME_BACKEND,
    );
  });

  it("keeps sessions on other orgs' repos on e2b_cloud", () => {
    expect(resolveDogfoodFreestyleOverride("org:trycycloid", "42", "some-customer", ENVIRONMENT.Production)).toBeNull();
    expect(resolveDogfoodFreestyleOverride("org:trycycloid", "42", null, ENVIRONMENT.Production)).toBeNull();
    expect(resolveDogfoodFreestyleOverride("org:trycycloid", "42", "", ENVIRONMENT.Production)).toBeNull();
    // org entry never matches on owner id alone
    expect(resolveDogfoodFreestyleOverride("org:42", "42", null, ENVIRONMENT.Production)).toBeNull();
  });

  it("supports mixed owner-id and org entries", () => {
    expect(resolveDogfoodFreestyleOverride("7,org:trycycloid", "42", "trycycloid", ENVIRONMENT.Production)).toBe(
      FREESTYLE_RUNTIME_BACKEND,
    );
    expect(resolveDogfoodFreestyleOverride("42,org:trycycloid", "42", "other-org", ENVIRONMENT.Production)).toBe(
      FREESTYLE_RUNTIME_BACKEND,
    );
    expect(resolveDogfoodFreestyleOverride("7,org:trycycloid", "42", "other-org", ENVIRONMENT.Production)).toBeNull();
  });

  it("disables the whole override on a malformed org entry (fail closed)", () => {
    expect(resolveDogfoodFreestyleOverride("org:", "42", "trycycloid", ENVIRONMENT.Production)).toBeNull();
    expect(resolveDogfoodFreestyleOverride("org:try cycloid", "42", "trycycloid", ENVIRONMENT.Production)).toBeNull();
    expect(resolveDogfoodFreestyleOverride("org:-bad", "42", "trycycloid", ENVIRONMENT.Production)).toBeNull();
    expect(
      resolveDogfoodFreestyleOverride("org:trycycloid,bogus", "42", "trycycloid", ENVIRONMENT.Production),
    ).toBeNull();
  });
});
