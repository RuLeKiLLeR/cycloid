#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SURFACE_RULES = {
  ui: [
    ".github/workflows/qa-gated-prod-deploy.yml",
    ".github/workflows/deploy.yml",
    ".github/workflows/deploy-ui-core.yml",
    ".github/workflows/deploy-frontend-qa.yml",
    "apps/ui/",
    "scripts/detect-deploy-surfaces.mjs",
    "scripts/inspect-ui-public-artifact.mjs",
    "shared/",
    "package.json",
    "package-lock.json",
  ],
  control: [
    ".github/workflows/qa-gated-prod-deploy.yml",
    ".github/workflows/deploy-control-plane.yml",
    ".github/workflows/deploy-control-plane-core.yml",
    ".github/workflows/deploy-control-plane-qa.yml",
    "apps/control-plane-worker/",
    "infra/ssm.tf",
    "scripts/cloudflare-benchmark-gate.mjs",
    "scripts/detect-deploy-surfaces.mjs",
    "shared/",
    "package.json",
    "package-lock.json",
  ],
  sandbox: [
    ".github/workflows/qa-gated-prod-deploy.yml",
    ".github/workflows/deploy-e2b-sandbox.yml",
    ".github/workflows/deploy-e2b-sandbox-core.yml",
    ".github/workflows/deploy-e2b-sandbox-qa.yml",
    "apps/sandbox-e2b/",
    "apps/sandbox-bridge/",
    "scripts/detect-deploy-surfaces.mjs",
    "scripts/e2b-template-build.sh",
    "scripts/ensure-cloudflare-r2-buckets.sh",
    "scripts/publish-bridge-bundle.mjs",
    "shared/",
    "tools/",
    "tools.toml",
    "package.json",
    "package-lock.json",
  ],
  ssm: ["infra/ssm.tf"],
};

function matchesRule(file, rule) {
  return rule.endsWith("/") ? file.startsWith(rule) : file === rule;
}

function runGit(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function parseFiles(stdout) {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function detectSurfacesFromFiles(files, { failOpen = false } = {}) {
  if (failOpen) {
    return { ui: true, control: true, sandbox: true, ssm: true };
  }

  const surfaces = { ui: false, control: false, sandbox: false, ssm: false };
  for (const file of files) {
    if (SURFACE_RULES.ui.some((rule) => matchesRule(file, rule))) surfaces.ui = true;
    if (SURFACE_RULES.control.some((rule) => matchesRule(file, rule))) surfaces.control = true;
    if (SURFACE_RULES.sandbox.some((rule) => matchesRule(file, rule))) surfaces.sandbox = true;
    if (SURFACE_RULES.ssm.some((rule) => matchesRule(file, rule))) surfaces.ssm = true;
  }

  return surfaces;
}

export function detectDeploySurfaces({ markerRef = "prod-deployed", sha, git = runGit }) {
  if (!sha) {
    throw new Error("SHA is required");
  }

  const tip = git(["rev-parse", "origin/main"]);
  const mainTip = tip.ok ? tip.stdout.trim() : "";
  if (!tip.ok || !mainTip) {
    console.log("Could not resolve origin/main; proceeding without tip-of-main skip guard.");
  }
  if (mainTip && mainTip !== sha) {
    console.log(`Commit ${sha} is behind origin/main ${mainTip}; skipping coalesced deploy.`);
    return {
      baseSha: "",
      changedFiles: [],
      failOpen: false,
      skip: true,
      surfaces: detectSurfacesFromFiles([]),
    };
  }

  let failOpen = false;
  let baseSha = "";
  let changedFiles = [];
  const marker = git(["rev-parse", "--verify", `${markerRef}^{commit}`]);
  const lastDeployedSha = marker.ok ? marker.stdout.trim() : "";
  if (!lastDeployedSha) {
    console.log(`Prod deploy marker ${markerRef} is unavailable; fail open and deploy all surfaces.`);
    failOpen = true;
  } else {
    baseSha = lastDeployedSha;
    const diff = git(["diff", "--name-only", lastDeployedSha, sha]);
    if (!diff.ok) {
      throw new Error(`Failed to diff ${lastDeployedSha}..${sha}: ${diff.stderr || diff.stdout}`);
    }
    changedFiles = parseFiles(diff.stdout);
  }

  if (failOpen) {
    const tree = git(["diff-tree", "--no-commit-id", "--name-only", "-r", sha]);
    changedFiles = tree.ok ? parseFiles(tree.stdout) : [];
  }

  return {
    baseSha,
    changedFiles,
    failOpen,
    skip: false,
    surfaces: detectSurfacesFromFiles(changedFiles, { failOpen }),
  };
}

function writeOutputs(outputsPath, surfaces) {
  const output = `ui=${surfaces.ui}\ncontrol=${surfaces.control}\nsandbox=${surfaces.sandbox}\nssm=${surfaces.ssm}\nskip=${surfaces.skip}\nbase_sha=${surfaces.baseSha}\n`;
  if (outputsPath) {
    appendFileSync(outputsPath, output);
  } else {
    process.stdout.write(output);
  }
}

function printSummary(result) {
  console.log("Changed deploy files:");
  if (result.changedFiles.length > 0) {
    console.log(result.changedFiles.join("\n"));
  } else {
    console.log("(none)");
  }
  const { ui, control, sandbox, ssm } = result.surfaces;
  console.log(`Surfaces: ui=${ui} control=${control} sandbox=${sandbox} ssm=${ssm} skip=${result.skip}`);
  if (result.baseSha) {
    console.log(`Deploy range base: ${result.baseSha}`);
  }
}

function main() {
  const result = detectDeploySurfaces({
    markerRef: process.env.PROD_DEPLOYED_REF,
    sha: process.env.SHA,
  });
  printSummary(result);
  writeOutputs(process.env.GITHUB_OUTPUT, { ...result.surfaces, baseSha: result.baseSha, skip: result.skip });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
