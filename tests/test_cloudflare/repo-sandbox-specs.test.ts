import { describe, expect, it } from "vitest";

import {
  normalizeRepoSandboxSpecs,
  resolveRepoSandboxSpec,
  resolveRuntimeTemplateId,
} from "../../apps/control-plane-worker/src/sandbox/repo-sandbox-specs";
import type { Env } from "../../apps/control-plane-worker/src/types";

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    E2B_SANDBOX_TEMPLATE: "tmpl-prod",
    E2B_SANDBOX_TIMEOUT_MS: "4200000",
    WORKER_ENV: "production",
    ...overrides,
  } as Env;
}

describe("repo sandbox specs", () => {
  it("resolves unlisted repos to the suffixed default 4 GiB template spec", () => {
    expect(resolveRepoSandboxSpec(createEnv(), "Acme", "Widget")).toEqual({
      repoOwner: "acme",
      repoName: "widget",
      source: "default",
      specKey: "default",
      cpuCount: 2,
      memoryMB: 4096,
      sizingExplicit: false,
      timeoutMs: 4_200_000,
      runtimeTemplateId: "tmpl-prod-mem4096-cpu2",
    });
  });

  it("resolves configured non-default repos to suffixed E2B templates", () => {
    expect(resolveRepoSandboxSpec(createEnv(), " TryCycloid ", " Cycloid ")).toEqual({
      repoOwner: "trycycloid",
      repoName: "cycloid",
      source: "repo",
      specKey: "trycycloid/cycloid",
      cpuCount: 4,
      memoryMB: 8192,
      sizingExplicit: true,
      timeoutMs: 4_200_000,
      runtimeTemplateId: "tmpl-prod-mem8192-cpu4",
    });
  });

  it("resolves openevidence/xyla to the bumped 16 GiB / 4 vCPU tier", () => {
    expect(resolveRepoSandboxSpec(createEnv(), "OpenEvidence", "Xyla")).toEqual({
      repoOwner: "openevidence",
      repoName: "xyla",
      source: "repo",
      specKey: "openevidence/xyla",
      cpuCount: 4,
      memoryMB: 16384,
      sizingExplicit: true,
      timeoutMs: 4_200_000,
      runtimeTemplateId: "tmpl-prod-mem16384-cpu4",
    });
  });

  it("resolves mialabs/mia and its test copy to the bumped 8 GiB / 4 vCPU tier", () => {
    for (const [owner, name] of [
      ["mialabs", "mia"],
      ["trycycloid", "mia-copy-4"],
    ] as const) {
      expect(resolveRepoSandboxSpec(createEnv(), owner, name)).toEqual({
        repoOwner: owner,
        repoName: name,
        source: "repo",
        specKey: `${owner}/${name}`,
        cpuCount: 4,
        memoryMB: 8192,
        sizingExplicit: true,
        timeoutMs: 4_200_000,
        runtimeTemplateId: "tmpl-prod-mem8192-cpu4",
      });
    }
  });

  it("omits over-cap repo specs in QA so sessions do not request skipped templates", () => {
    expect(
      resolveRepoSandboxSpec(
        createEnv({
          E2B_SANDBOX_TEMPLATE: "cycloid-sandbox-qa",
          WORKER_ENV: "qa",
        }),
        "OpenEvidence",
        "Xyla",
      ),
    ).toEqual({
      repoOwner: "openevidence",
      repoName: "xyla",
      source: "default",
      specKey: "default",
      cpuCount: 2,
      memoryMB: 4096,
      sizingExplicit: false,
      timeoutMs: 4_200_000,
      runtimeTemplateId: "cycloid-sandbox-qa-mem4096-cpu2",
    });
  });

  it("resolves the former mia-copy bumps to the default tier (only cycloid stays bumped)", () => {
    for (const repo of ["mia-copy", "mia-copy-2"]) {
      expect(resolveRepoSandboxSpec(createEnv(), "TryCycloid", repo)).toMatchObject({
        source: "default",
        specKey: "default",
        cpuCount: 2,
        memoryMB: 4096,
        runtimeTemplateId: "tmpl-prod-mem4096-cpu2",
      });
    }
  });

  it("uses explicit template suffixes even when resource counts match defaults", () => {
    expect(resolveRuntimeTemplateId("tmpl-prod", { cpuCount: 2, memoryMB: 4096, templateSuffix: "special" })).toBe(
      "tmpl-prod-special",
    );
  });

  it("uses the local default template when no base template env is configured", () => {
    expect(
      resolveRepoSandboxSpec(createEnv({ E2B_SANDBOX_TEMPLATE: undefined, WORKER_ENV: "local" }), "acme", "repo"),
    ).toMatchObject({
      runtimeTemplateId: "cycloid-sandbox-dev-local-mem4096-cpu2",
      memoryMB: 4096,
    });
  });

  it("rejects invalid configured specs", () => {
    // Sizing entries are complete (both cpuCount and memoryMB) so each case reaches the
    // value guard under test instead of the partial-sizing rejection.
    expect(() => normalizeRepoSandboxSpecs([{ repo: "Acme/Repo" }, { repo: " acme/repo " }])).toThrow(
      "Duplicate repo sandbox spec",
    );
    expect(() => normalizeRepoSandboxSpecs([{ repo: "acme/repo", cpuCount: 0, memoryMB: 8192 }])).toThrow(
      "Invalid cpuCount",
    );
    expect(() => normalizeRepoSandboxSpecs([{ repo: "acme/repo", cpuCount: 2, memoryMB: 1.5 }])).toThrow(
      "Invalid memoryMB",
    );
    expect(() => normalizeRepoSandboxSpecs([{ repo: "acme/repo", timeoutMs: -1 }])).toThrow("timeoutMs");
    expect(() =>
      normalizeRepoSandboxSpecs([{ repo: "acme/repo", cpuCount: 4, memoryMB: 8192, templateSuffix: "Bad_Suffix" }]),
    ).toThrow("templateSuffix");
    expect(() => normalizeRepoSandboxSpecs([{ repo: "acme/repo", cpuCount: 2, memoryMB: 4096, diskGB: 0 }])).toThrow(
      "Invalid diskGB",
    );
    expect(() => normalizeRepoSandboxSpecs([{ repo: "acme/repo", cpuCount: 2, memoryMB: 4096, diskGB: 12.5 }])).toThrow(
      "Invalid diskGB",
    );
  });

  it("rejects partial sizing so a Freestyle VM is never silently downsized below the snapshot baseline", () => {
    // A lone sizing dimension would ride the 2/4096 defaults for the rest and, sent to
    // Freestyle, SHRINK the VM below the base snapshot's 8 GiB / 4 vCPU.
    expect(() => normalizeRepoSandboxSpecs([{ repo: "acme/repo", memoryMB: 32768 }])).toThrow("Partial sizing");
    expect(() => normalizeRepoSandboxSpecs([{ repo: "acme/repo", cpuCount: 4 }])).toThrow("Partial sizing");
    expect(() => normalizeRepoSandboxSpecs([{ repo: "acme/repo", diskGB: 32 }])).toThrow("Partial sizing");
  });

  it("marks non-sizing entries sizingExplicit:false so timeout-only repos keep the snapshot baseline", () => {
    const [normalized] = normalizeRepoSandboxSpecs([{ repo: "acme/repo", timeoutMs: 7_200_000 }]);
    expect(normalized).toMatchObject({ specKey: "acme/repo", sizingExplicit: false, cpuCount: 2, memoryMB: 4096 });
  });

  it("makes a 32 GiB memory / 32 GB disk Freestyle spec expressible via the disk dimension", () => {
    // The FREESTYLE-BIGSPEC target: memory must be a power-of-two GiB, so 24 GiB is not
    // expressible and 32 GiB (32768 MiB) is the delivered tier; disk is range-bounded, so
    // 32 GB is exact. diskGB rides through normalization without touching the E2B template.
    const [normalized] = normalizeRepoSandboxSpecs([
      { repo: "bigspec/customer", cpuCount: 4, memoryMB: 32768, diskGB: 32 },
    ]);
    expect(normalized).toMatchObject({
      specKey: "bigspec/customer",
      cpuCount: 4,
      memoryMB: 32768,
      sizingExplicit: true,
      diskGB: 32,
    });
    // Disk never enters the E2B template id — E2B disk is fixed per team, so the id stays
    // mem<MB>-cpu<N> and no mem32768 template is required for a Freestyle-only big-spec repo.
    expect(resolveRuntimeTemplateId("tmpl-prod", { cpuCount: 4, memoryMB: 32768 })).toBe("tmpl-prod-mem32768-cpu4");
  });

  it("leaves diskGB unset for repos that omit it (Freestyle keeps the snapshot rootfs)", () => {
    expect(resolveRepoSandboxSpec(createEnv(), "OpenEvidence", "Xyla").diskGB).toBeUndefined();
    expect(resolveRepoSandboxSpec(createEnv(), "Acme", "Widget").diskGB).toBeUndefined();
  });
});
