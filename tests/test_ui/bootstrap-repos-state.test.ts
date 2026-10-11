import { describe, expect, it } from "vitest";

import { resolveBootstrapReposState } from "../../apps/ui/src/utils/repos";
import type { BootstrapRepo, BootstrapResponse } from "../../shared/types/bootstrap";

const REPO: BootstrapRepo = {
  fullName: "acme/widgets",
  url: "https://github.com/acme/widgets",
  private: false,
  defaultBranch: "main",
  ownerType: "Organization",
};

function makeBootstrap(overrides: Partial<BootstrapResponse>): BootstrapResponse {
  return {
    authenticated: true,
    // Only the fields resolveBootstrapReposState reads need to be realistic; the
    // rest are filled minimally to satisfy the type.
    user: {} as BootstrapResponse["user"],
    capabilities: {} as BootstrapResponse["capabilities"],
    models: null,
    repos: null,
    reposPending: false,
    ssoOrgs: [],
    settings: null,
    warnings: [],
    ...overrides,
  };
}

describe("resolveBootstrapReposState", () => {
  it("returns loaded with the repos and default repo when repos are present", () => {
    const state = resolveBootstrapReposState(
      makeBootstrap({ repos: [REPO], settings: { defaultRepo: "acme/widgets" } as BootstrapResponse["settings"] }),
    );
    expect(state).toEqual({ kind: "loaded", repos: [REPO], defaultRepoUrl: "acme/widgets" });
  });

  it("returns pending (not error) when repos are null but reposPending is true", () => {
    const state = resolveBootstrapReposState(
      makeBootstrap({
        repos: null,
        reposPending: true,
        settings: { defaultRepo: "acme/widgets" } as BootstrapResponse["settings"],
      }),
    );
    // Threads the default repo through so a cold pending start still auto-selects it.
    expect(state).toEqual({ kind: "pending", defaultRepoUrl: "acme/widgets" });
  });

  it("returns error when repos are null and not pending (genuine failure)", () => {
    const state = resolveBootstrapReposState(makeBootstrap({ repos: null, reposPending: false }));
    expect(state).toEqual({ kind: "error" });
  });

  it("loaded takes precedence over a stale pending flag", () => {
    const state = resolveBootstrapReposState(makeBootstrap({ repos: [REPO], reposPending: true }));
    expect(state.kind).toBe("loaded");
  });

  it("defaults defaultRepoUrl to null when settings are absent", () => {
    const state = resolveBootstrapReposState(makeBootstrap({ repos: null, reposPending: true, settings: null }));
    expect(state).toEqual({ kind: "pending", defaultRepoUrl: null });
  });
});
