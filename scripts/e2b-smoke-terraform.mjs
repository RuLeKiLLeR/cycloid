#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_DIR = resolve(ROOT, "infra/e2b-smoke");
const SOURCE_PATH = resolve(CONFIG_DIR, "source.json");
const TARGET_PATH = resolve(CONFIG_DIR, "target.json");
const DEFAULT_SOURCE_DIR = resolve(CONFIG_DIR, ".source");

function usage() {
  console.error(`Usage: node scripts/e2b-smoke-terraform.mjs <status|fetch|init|plan|destroy-plan|show|apply|destroy> [options]

Options:
  --source-dir <path>       Local checkout of the pinned E2B infra repository.
                            Defaults to E2B_INFRA_DIR or infra/e2b-smoke/.source.
  --plan-file <path>        Terraform plan path. Defaults to target.json planFile,
                            or destroyPlanFile for destroy-plan/destroy.
  --terraform-bin <path>    Terraform binary. Defaults to terraform.
  --allow-ref-mismatch      Allow the local E2B checkout to differ from source.json.
`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {
    allowRefMismatch: false,
    sourceDir: process.env.E2B_INFRA_DIR || DEFAULT_SOURCE_DIR,
    terraformBin: process.env.TERRAFORM_BIN || "terraform",
  };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--allow-ref-mismatch") {
      options.allowRefMismatch = true;
    } else if (arg === "--source-dir") {
      options.sourceDir = rest[++i] || "";
    } else if (arg === "--plan-file") {
      options.planFile = rest[++i] || "";
    } else if (arg === "--terraform-bin") {
      options.terraformBin = rest[++i] || "";
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return { command, options };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function run(command, args, options = {}) {
  console.error(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      AWS_DEFAULT_REGION: options.awsRegion || process.env.AWS_DEFAULT_REGION,
      AWS_REGION: options.awsRegion || process.env.AWS_REGION,
    },
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function runOutput(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    return "";
  }
  return result.stdout.trim();
}

function repositoryUrl(source) {
  return `https://github.com/${source.repository}.git`;
}

function defaultPlanFile(command, target) {
  if ((command === "destroy-plan" || command === "destroy") && target.destroyPlanFile) {
    return target.destroyPlanFile;
  }
  return target.planFile;
}

function fetchSource(source, options) {
  const sourceDir = resolve(options.sourceDir);
  const sourceUrl = repositoryUrl(source);
  if (!existsSync(sourceDir)) {
    mkdirSync(dirname(sourceDir), { recursive: true });
    run("git", ["clone", "--no-checkout", sourceUrl, sourceDir]);
  } else if (!existsSync(resolve(sourceDir, ".git"))) {
    throw new Error(`E2B source path exists but is not a git checkout: ${sourceDir}`);
  }

  run("git", ["fetch", "--depth=1", sourceUrl, source.ref], { cwd: sourceDir });
  run("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: sourceDir });
  return sourceDir;
}

function requireSourceDir(source, options) {
  const sourceDir = resolve(options.sourceDir);
  if (!existsSync(sourceDir)) {
    throw new Error(
      `E2B source checkout does not exist: ${sourceDir}. Run "npm run smoke:e2b:terraform -- fetch" first.`,
    );
  }

  const terraformDir = resolve(sourceDir, source.providerAwsPath);
  if (!existsSync(terraformDir)) {
    throw new Error(`E2B provider AWS Terraform path does not exist: ${terraformDir}`);
  }

  const head = runOutput("git", ["rev-parse", "HEAD"], { cwd: sourceDir });
  if (head && head !== source.ref && !options.allowRefMismatch) {
    throw new Error(
      `E2B source checkout is at ${head}, but source.json pins ${source.ref}. ` +
        "Update source.json if this upstream change is intentional, or pass --allow-ref-mismatch for inspection.",
    );
  }

  return { sourceDir, terraformDir };
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const source = readJson(SOURCE_PATH);
  const target = readJson(TARGET_PATH);
  const backendConfig = resolve(CONFIG_DIR, target.backendConfig);
  const varFile = resolve(CONFIG_DIR, target.varFile);
  const planFile = resolve(options.planFile || defaultPlanFile(command, target));

  if (!command || !["status", "fetch", "init", "plan", "destroy-plan", "show", "apply", "destroy"].includes(command)) {
    usage();
    process.exit(2);
  }

  if (!existsSync(backendConfig)) {
    throw new Error(`Backend config does not exist: ${backendConfig}`);
  }
  if (!existsSync(varFile)) {
    throw new Error(`Terraform var file does not exist: ${varFile}`);
  }

  if (command === "status") {
    const sourceDir = resolve(options.sourceDir);
    console.log(
      JSON.stringify(
        {
          source,
          target,
          backendConfig,
          varFile,
          planFile,
          sourceDir,
          sourceDirExists: existsSync(sourceDir),
          sourceHead: existsSync(sourceDir)
            ? runOutput("git", ["rev-parse", "HEAD"], { cwd: sourceDir }) || null
            : null,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "fetch") {
    const sourceDir = fetchSource(source, options);
    console.log(`E2B source checkout is ready at ${sourceDir}`);
    return;
  }

  const { terraformDir } = requireSourceDir(source, options);
  const terraform = options.terraformBin || "terraform";
  const env = { cwd: terraformDir, awsRegion: target.awsRegion };

  if (command === "init") {
    run(terraform, ["init", "-input=false", "-reconfigure", `-backend-config=${backendConfig}`], env);
  } else if (command === "plan") {
    run(
      terraform,
      ["plan", `-var-file=${varFile}`, "-input=false", "-compact-warnings", "-parallelism=20", `-out=${planFile}`],
      env,
    );
  } else if (command === "destroy-plan") {
    run(
      terraform,
      [
        "plan",
        "-destroy",
        `-var-file=${varFile}`,
        "-var=allow_force_destroy=true",
        "-input=false",
        "-compact-warnings",
        "-parallelism=20",
        `-out=${planFile}`,
      ],
      env,
    );
  } else if (command === "show") {
    run(terraform, ["show", "-no-color", planFile], env);
  } else if (command === "apply" || command === "destroy") {
    run(terraform, ["apply", planFile], env);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
