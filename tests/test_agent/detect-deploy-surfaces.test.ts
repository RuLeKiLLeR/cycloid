import { describe, expect, it, vi } from "vitest";

import { detectDeploySurfaces, detectSurfacesFromFiles } from "../../scripts/detect-deploy-surfaces.mjs";

function createGit(
  filesByDiff: Record<string, string[]>,
  availableCommits: Set<string>,
  {
    failedDiffs = new Set<string>(),
    mainTip = "sha",
  }: {
    failedDiffs?: Set<string>;
    mainTip?: string;
  } = {},
) {
  return (args: string[]) => {
    if (args[0] === "rev-parse" && args[1] === "origin/main") {
      return { ok: true, stdout: `${mainTip}\n`, stderr: "" };
    }
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      const ref = args[2]?.replace(/\^\{commit\}$/, "") ?? "";
      if (availableCommits.has(ref)) return { ok: true, stdout: `${ref}\n`, stderr: "" };
      return { ok: false, stdout: "", stderr: "missing ref" };
    }
    if (args[0] === "cat-file") {
      const commit = args[2]?.replace(/\^\{commit\}$/, "") ?? "";
      return { ok: availableCommits.has(commit), stdout: "", stderr: "" };
    }
    if (args[0] === "diff") {
      const key = `${args[2]}..${args[3]}`;
      if (failedDiffs.has(key)) {
        return { ok: false, stdout: "", stderr: "fatal: bad revision" };
      }
      return { ok: true, stdout: (filesByDiff[key] ?? []).join("\n"), stderr: "" };
    }
    if (args[0] === "diff-tree") {
      return { ok: true, stdout: (filesByDiff[args.at(-1) ?? ""] ?? []).join("\n"), stderr: "" };
    }
    throw new Error(`Unexpected git command: ${args.join(" ")}`);
  };
}

describe("detectDeploySurfaces", () => {
  it("maps changed files to deploy surfaces", () => {
    expect(detectSurfacesFromFiles(["apps/control-plane-worker/src/index.ts"])).toEqual({
      ui: false,
      control: true,
      sandbox: false,
      ssm: false,
    });
    expect(detectSurfacesFromFiles(["apps/ui/src/main.tsx"])).toEqual({
      ui: true,
      control: false,
      sandbox: false,
      ssm: false,
    });
    expect(detectSurfacesFromFiles(["apps/sandbox-bridge/src/index.ts"])).toEqual({
      ui: false,
      control: false,
      sandbox: true,
      ssm: false,
    });
    expect(detectSurfacesFromFiles(["shared/types.ts"])).toEqual({
      ui: true,
      control: true,
      sandbox: true,
      ssm: false,
    });
    expect(detectSurfacesFromFiles(["docs/deployments.md"])).toEqual({
      ui: false,
      control: false,
      sandbox: false,
      ssm: false,
    });
  });

  it("flags SSM changes as control-plane deploys with secret sync", () => {
    expect(detectSurfacesFromFiles(["infra/ssm.tf"])).toEqual({
      ui: false,
      control: true,
      sandbox: false,
      ssm: true,
    });
  });

  it("keeps deploy workflow and detector changes fail-safe across surfaces", () => {
    for (const file of [".github/workflows/qa-gated-prod-deploy.yml", "scripts/detect-deploy-surfaces.mjs"]) {
      expect(detectSurfacesFromFiles([file]), file).toEqual({
        ui: true,
        control: true,
        sandbox: true,
        ssm: false,
      });
    }
  });

  it("diffs the prod deploy marker to the triggering SHA", () => {
    const git = createGit(
      {
        "before..sha": ["docs/deployments.md"],
        "prod-deployed..sha": ["apps/ui/src/App.tsx"],
      },
      new Set(["before", "prod-deployed"]),
    );

    expect(detectDeploySurfaces({ sha: "sha", git })).toEqual({
      baseSha: "prod-deployed",
      changedFiles: ["apps/ui/src/App.tsx"],
      failOpen: false,
      skip: false,
      surfaces: { ui: true, control: false, sandbox: false, ssm: false },
    });
  });

  it("fails closed when diffing a reachable prod deploy marker fails", () => {
    const git = createGit({}, new Set(["prod-deployed"]), { failedDiffs: new Set(["prod-deployed..sha"]) });

    expect(() => detectDeploySurfaces({ sha: "sha", git })).toThrow(
      "Failed to diff prod-deployed..sha: fatal: bad revision",
    );
  });

  it("fails open when the prod deploy marker is missing or unavailable", () => {
    const git = createGit({ sha: ["docs/deployments.md"] }, new Set());

    expect(detectDeploySurfaces({ sha: "sha", git })).toEqual({
      baseSha: "",
      changedFiles: ["docs/deployments.md"],
      failOpen: true,
      skip: false,
      surfaces: { ui: true, control: true, sandbox: true, ssm: true },
    });
  });

  it("skips when the triggering SHA is behind the current main tip", () => {
    const git = (args: string[]) => {
      if (args[0] === "rev-parse") {
        return { ok: true, stdout: "newer-sha\n", stderr: "" };
      }
      throw new Error(`Unexpected git command after skip: ${args.join(" ")}`);
    };

    expect(detectDeploySurfaces({ sha: "sha", git })).toEqual({
      baseSha: "",
      changedFiles: [],
      failOpen: false,
      skip: true,
      surfaces: { ui: false, control: false, sandbox: false, ssm: false },
    });
  });

  it("logs and continues when origin main cannot be resolved", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const git = (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "origin/main") {
        return { ok: false, stdout: "", stderr: "fatal: bad revision" };
      }
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        return { ok: true, stdout: "prod-deployed\n", stderr: "" };
      }
      if (args[0] === "cat-file") {
        return { ok: true, stdout: "", stderr: "" };
      }
      if (args[0] === "diff") {
        return { ok: true, stdout: "apps/ui/src/App.tsx\n", stderr: "" };
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    };

    expect(detectDeploySurfaces({ sha: "sha", git })).toEqual({
      baseSha: "prod-deployed",
      changedFiles: ["apps/ui/src/App.tsx"],
      failOpen: false,
      skip: false,
      surfaces: { ui: true, control: false, sandbox: false, ssm: false },
    });
    expect(log).toHaveBeenCalledWith("Could not resolve origin/main; proceeding without tip-of-main skip guard.");
    log.mockRestore();
  });
});
