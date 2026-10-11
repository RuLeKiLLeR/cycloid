import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerDir = path.join(repoRoot, "apps/control-plane-worker");
const entryPath = path.join(workerDir, ".tmp-e2b-bundle-smoke.ts");
const configPath = path.join(workerDir, ".tmp-wrangler-e2b-smoke.toml");
const outDir = path.join(repoRoot, "bundled-e2b-smoke");

try {
  writeFileSync(
    entryPath,
    [
      'import { runE2BCompatSmoke } from "./src/sandbox/e2b-compat";',
      "",
      "export default {",
      "  async fetch(): Promise<Response> {",
      "    return new Response(String(typeof runE2BCompatSmoke));",
      "  },",
      "};",
      "",
    ].join("\n"),
  );

  writeFileSync(
    configPath,
    [
      'name = "cycloid-e2b-bundle-smoke"',
      'main = ".tmp-e2b-bundle-smoke.ts"',
      'compatibility_date = "2025-03-01"',
      'compatibility_flags = ["nodejs_compat"]',
      "",
    ].join("\n"),
  );

  rmSync(outDir, { recursive: true, force: true });
  execFileSync("npx", ["wrangler", "deploy", "--config", configPath, "--dry-run", "--outdir", outDir], {
    cwd: workerDir,
    stdio: "inherit",
  });
} finally {
  rmSync(entryPath, { force: true });
  rmSync(configPath, { force: true });
}
