import { execFileSync } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = join(import.meta.dirname, "../../apps/sandbox-e2b/scripts/repo-context.sh");
const TMP_DIR = join(import.meta.dirname, ".tmp-repo-context-test");

function writeFixture(relativePath: string, content: string): void {
  const fullPath = join(TMP_DIR, relativePath);
  const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
}

function runScript(): string {
  return execFileSync("bash", [SCRIPT_PATH], {
    cwd: TMP_DIR,
    encoding: "utf-8",
    timeout: 10_000,
    env: { ...process.env, PATH: process.env.PATH },
  });
}

describe("repo-context.sh", () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    // Init a git repo so the git section doesn't fail
    execFileSync("git", ["init"], { cwd: TMP_DIR, encoding: "utf-8" });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
      cwd: TMP_DIR,
      encoding: "utf-8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@test.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@test.com",
      },
    });
  });

  afterEach(() => {
    if (existsSync(TMP_DIR)) {
      rmSync(TMP_DIR, { recursive: true, force: true });
    }
  });

  it("completes without errors on an empty repo", () => {
    const output = runScript();
    expect(output).toContain("## Repository Context");
    expect(output).toContain("### Project Type");
    expect(output).toContain("Detected: Unknown");
    // New sections should NOT appear when no config files exist
    expect(output).not.toContain("### Package Manager");
    expect(output).not.toContain("### Runtime Versions");
    expect(output).not.toContain("### Monorepo Workspaces");
    expect(output).not.toContain("### Test Commands");
    expect(output).not.toContain("### Code Quality Tools");
    expect(output).not.toContain("### PR Template");
    expect(output).not.toContain("### Environment Variables");
  });

  // ---------------------------------------------------------------------------
  // Package manager detection
  // ---------------------------------------------------------------------------

  it("detects pnpm when pnpm-lock.yaml exists", () => {
    writeFixture("package.json", '{"name":"test"}');
    writeFixture("pnpm-lock.yaml", "lockfileVersion: 5");
    const output = runScript();
    expect(output).toContain("### Package Manager");
    expect(output).toContain("Detected: **pnpm**");
    expect(output).toContain("`pnpm install`");
  });

  it("detects yarn when yarn.lock exists", () => {
    writeFixture("package.json", '{"name":"test"}');
    writeFixture("yarn.lock", "");
    const output = runScript();
    expect(output).toContain("Detected: **yarn**");
  });

  it("detects npm when only package-lock.json exists", () => {
    writeFixture("package.json", '{"name":"test"}');
    writeFixture("package-lock.json", "{}");
    const output = runScript();
    expect(output).toContain("Detected: **npm**");
    // npm is the default, so no "instead of npm" instruction
    expect(output).not.toContain("instead of npm");
  });

  it("detects bun when bun.lockb exists", () => {
    writeFixture("package.json", '{"name":"test"}');
    writeFixture("bun.lockb", "");
    const output = runScript();
    expect(output).toContain("Detected: **bun**");
  });

  it("pnpm wins over yarn when both lockfiles exist", () => {
    writeFixture("package.json", '{"name":"test"}');
    writeFixture("pnpm-lock.yaml", "");
    writeFixture("yarn.lock", "");
    const output = runScript();
    expect(output).toContain("Detected: **pnpm**");
  });

  it("uses $PKG_RUN in Available Commands output", () => {
    writeFixture(
      "package.json",
      JSON.stringify({
        name: "test",
        scripts: { build: "tsc", dev: "vite" },
      }),
    );
    writeFixture("pnpm-lock.yaml", "");
    const output = runScript();
    expect(output).toContain("pnpm run build");
    expect(output).toContain("pnpm run dev");
    // Ensure "npm run" doesn't appear as a command prefix (ignore the "instead of npm" instruction)
    expect(output).not.toMatch(/- npm run /);
  });

  // ---------------------------------------------------------------------------
  // Runtime version constraints
  // ---------------------------------------------------------------------------

  it("detects Node.js version from .nvmrc", () => {
    writeFixture(".nvmrc", "20.11.0\n");
    const output = runScript();
    expect(output).toContain("### Runtime Versions");
    expect(output).toContain("Node.js: 20.11.0 (from .nvmrc)");
  });

  it("detects Python version from .python-version", () => {
    writeFixture(".python-version", "3.12.1\n");
    const output = runScript();
    expect(output).toContain("Python: 3.12.1 (from .python-version)");
  });

  it("detects Go version from go.mod", () => {
    writeFixture("go.mod", "module example.com/foo\n\ngo 1.22.0\n");
    const output = runScript();
    expect(output).toContain("Go: 1.22.0 (from go.mod)");
  });

  it("detects multiple runtime versions", () => {
    writeFixture(".nvmrc", "18.19.0\n");
    writeFixture(".python-version", "3.11.7\n");
    const output = runScript();
    expect(output).toContain("Node.js: 18.19.0");
    expect(output).toContain("Python: 3.11.7");
  });

  // ---------------------------------------------------------------------------
  // Monorepo workspaces
  // ---------------------------------------------------------------------------

  it("detects workspaces from package.json", () => {
    writeFixture(
      "package.json",
      JSON.stringify({
        name: "monorepo",
        workspaces: ["packages/*", "apps/*"],
      }),
    );
    const output = runScript();
    expect(output).toContain("### Monorepo Workspaces");
    expect(output).toContain("packages/*");
    expect(output).toContain("apps/*");
  });

  it("detects turbo.json as monorepo indicator", () => {
    writeFixture("package.json", '{"name":"test"}');
    writeFixture("turbo.json", "{}");
    const output = runScript();
    expect(output).toContain("### Monorepo Workspaces");
    expect(output).toContain("turbo.json");
  });

  // ---------------------------------------------------------------------------
  // Test commands
  // ---------------------------------------------------------------------------

  it("detects test scripts from package.json", () => {
    writeFixture(
      "package.json",
      JSON.stringify({
        name: "test",
        scripts: { test: "vitest", "test:e2e": "playwright test" },
      }),
    );
    const output = runScript();
    expect(output).toContain("### Test Commands");
    expect(output).toContain("`npm run test`");
    expect(output).toContain("`npm run test:e2e`");
  });

  it("uses correct package manager prefix in test commands", () => {
    writeFixture(
      "package.json",
      JSON.stringify({
        name: "test",
        scripts: { test: "vitest" },
      }),
    );
    writeFixture("yarn.lock", "");
    const output = runScript();
    expect(output).toContain("`yarn test`");
  });

  it("detects pytest from pyproject.toml", () => {
    writeFixture("pyproject.toml", "[tool.pytest.ini_options]\ntestpaths = ['tests']\n");
    const output = runScript();
    expect(output).toContain("### Test Commands");
    expect(output).toContain("`pytest`");
  });

  it("detects cargo test for Rust projects", () => {
    writeFixture("Cargo.toml", '[package]\nname = "test"\n');
    const output = runScript();
    expect(output).toContain("`cargo test`");
  });

  // ---------------------------------------------------------------------------
  // Code quality tools
  // ---------------------------------------------------------------------------

  it("detects ESLint from .eslintrc.json", () => {
    writeFixture(".eslintrc.json", "{}");
    const output = runScript();
    expect(output).toContain("### Code Quality Tools");
    expect(output).toContain("ESLint");
  });

  it("detects ESLint flat config", () => {
    writeFixture("eslint.config.js", "export default {};");
    const output = runScript();
    expect(output).toContain("ESLint");
  });

  it("detects Prettier", () => {
    writeFixture(".prettierrc", "{}");
    const output = runScript();
    expect(output).toContain("Prettier");
  });

  it("detects Biome", () => {
    writeFixture("biome.json", "{}");
    const output = runScript();
    expect(output).toContain("Biome");
  });

  it("detects multiple tools", () => {
    writeFixture(".eslintrc.json", "{}");
    writeFixture(".prettierrc", "{}");
    writeFixture(".editorconfig", "root = true\n");
    const output = runScript();
    expect(output).toContain("ESLint");
    expect(output).toContain("Prettier");
    expect(output).toContain("EditorConfig");
  });

  it("detects Ruff from ruff.toml", () => {
    writeFixture("ruff.toml", "[lint]\nselect = ['E']\n");
    const output = runScript();
    expect(output).toContain("Ruff");
  });

  it("detects Ruff from pyproject.toml", () => {
    writeFixture("pyproject.toml", "[tool.ruff]\nline-length = 100\n");
    const output = runScript();
    expect(output).toContain("Ruff");
  });

  // ---------------------------------------------------------------------------
  // PR template
  // ---------------------------------------------------------------------------

  it("detects PR template", () => {
    writeFixture(".github/PULL_REQUEST_TEMPLATE.md", "## Description\n");
    const output = runScript();
    expect(output).toContain("### PR Template");
    expect(output).toContain(".github/PULL_REQUEST_TEMPLATE.md");
    expect(output).toContain("Read it before creating PRs");
  });

  it("detects PR template directory", () => {
    // Create the directory with a file inside so it exists
    writeFixture(".github/PULL_REQUEST_TEMPLATE/feature.md", "## Feature\n");
    const output = runScript();
    expect(output).toContain("### PR Template");
    expect(output).toContain("Multiple PR templates");
  });

  // ---------------------------------------------------------------------------
  // Environment variable template
  // ---------------------------------------------------------------------------

  it("detects .env.example and lists variable names", () => {
    writeFixture(".env.example", "DATABASE_URL=postgres://localhost/db\nAPI_KEY=your-key-here\nDEBUG=false\n");
    const output = runScript();
    expect(output).toContain("### Environment Variables");
    expect(output).toContain("Template: `.env.example`");
    expect(output).toContain("DATABASE_URL");
    expect(output).toContain("API_KEY");
    expect(output).toContain("DEBUG");
    // Must not include values
    expect(output).not.toContain("postgres://");
    expect(output).not.toContain("your-key-here");
  });

  it("caps env variables at 30", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `VAR_${i}=value`).join("\n");
    writeFixture(".env.example", lines);
    const output = runScript();
    expect(output).toContain("VAR_0");
    expect(output).toContain("VAR_29");
    expect(output).not.toContain("VAR_30");
  });
});
