import { describe, expect, it } from "vitest";

import { commandLabel, commandLooksFailed, isRelevantCheckCommand } from "../../shared/command-classification.js";

describe("isRelevantCheckCommand", () => {
  it.each([
    ["npm test", "JS test"],
    ["npm run -w @cycloid/sandbox-bridge typecheck", "npm workspace typecheck"],
    ["npm run --workspace @cycloid/sandbox-bridge lint", "npm workspace lint"],
    ["npm run --workspace=@cycloid/sandbox-bridge build", "npm workspace build"],
    ["pnpm run test:unit", "JS scoped test"],
    ["npx vitest run", "vitest"],
    ["tsc --noEmit", "typecheck"],
    ["npx eslint .", "lint"],
    ["yarn run build", "JS build"],
    ["node --test", "node test runner"],
    ["go test ./...", "Go test"],
    ["go vet ./...", "Go vet"],
    ["golangci-lint run", "Go lint"],
    ["cargo test", "Rust test"],
    ["cargo clippy", "Rust lint"],
    ["pytest tests/", "pytest"],
    ["uv run pytest tests/ -v", "uv pytest"],
    ["uv run ruff check .", "ruff"],
    ["python -m mypy src", "mypy"],
    ["mvn test", "JVM maven"],
    ["./gradlew build", "JVM gradle"],
    ["bundle exec rspec", "Ruby rspec"],
    ["rubocop", "Ruby lint"],
    ["terraform validate", "terraform"],
    ["terragrunt plan", "terragrunt"],
    ["psql -c 'select 1'", "psql"],
    ["alembic upgrade head", "alembic"],
    ["uv run dbt parse", "dbt"],
    ["npx prisma migrate status", "prisma"],
    ["wrangler d1 migrations list DB", "wrangler d1"],
    ["wrangler deploy", "wrangler"],
    ["kubectl apply -f x.yaml --dry-run=server", "kubectl dry-run"],
    ["curl -sf http://localhost:3000/health", "curl smoke"],
  ])("recognizes %s as a relevant check (%s)", (command) => {
    expect(isRelevantCheckCommand(command)).toBe(true);
  });

  it.each([
    ["rg TODO src/", "ripgrep"],
    ["cat package.json", "cat"],
    ["ls -la", "ls"],
    ["git status", "git status"],
    ["git diff HEAD~1", "git diff"],
    ["npm pkg get version", "npm pkg get"],
    ["pnpm list", "pnpm list"],
    ["pwd", "pwd"],
  ])("excludes exploratory command %s (%s)", (command) => {
    expect(isRelevantCheckCommand(command)).toBe(false);
  });

  it("matches a check inside a bash -c wrapper", () => {
    expect(isRelevantCheckCommand('bash -c "cd app && npm test"')).toBe(true);
  });

  it.each([
    ["git diff && npm test", "check after git inspection"],
    ["cat foo.txt; npm run build", "check after cat"],
    ["ls && pytest", "check after ls"],
    ["rg TODO src/ && go test ./...", "check after ripgrep"],
    ["git status | head -5 && cargo test", "check after a pipe"],
  ])("counts a real check chained after an inspection command: %s (%s)", (command) => {
    expect(isRelevantCheckCommand(command)).toBe(true);
  });

  it.each([
    ['grep "npm test" src/', "check token only inside grep arg"],
    ['rg "go test" .', "check token only inside ripgrep arg"],
    ["cat scripts/run-pytest.sh", "filename containing a check name"],
    ["bash -c \"grep 'npm test' src/\"", "check token inside grep arg of a bash -c wrapper"],
    ["bash -c \"rg 'go test' .\"", "check token inside ripgrep arg of a bash -c wrapper"],
  ])("does not count a check token that only appears inside an inspection argument: %s (%s)", (command) => {
    expect(isRelevantCheckCommand(command)).toBe(false);
  });

  it("returns false for empty or undefined input", () => {
    expect(isRelevantCheckCommand(undefined)).toBe(false);
    expect(isRelevantCheckCommand("")).toBe(false);
    expect(isRelevantCheckCommand("   ")).toBe(false);
  });

  it("does not treat an unrecognized command as a check", () => {
    expect(isRelevantCheckCommand("./scripts/do-something.sh")).toBe(false);
  });
});

describe("commandLooksFailed", () => {
  it.each([
    [{ status: "completed" as const, exitCode: 1, summary: "1 passed" }],
    [{ status: "error" as const, exitCode: null }],
    // No numeric exit code available (Codex tool status): still fall back to output scanning.
    [{ status: "completed" as const, exitCode: null, failureOutput: "HTTP/1.1 500 Internal Server Error" }],
    [{ status: "completed" as const, exitCode: null, summary: "ECONNREFUSED http://localhost:3000" }],
  ])("recognizes failed command evidence %#", (command) => {
    expect(commandLooksFailed(command)).toBe(true);
  });

  it.each([
    [{ status: "completed" as const, exitCode: 0, summary: "1 passed" }],
    // A numeric exit 0 is authoritative: benign substrings in passing output no longer fail.
    [{ status: "completed" as const, exitCode: 0, summary: "ECONNREFUSED http://localhost:3000" }],
    [{ status: "completed" as const, exitCode: 0, summary: "PASS 12 tests, logged: Error: expected message handled" }],
    [{ status: "completed" as const, exitCode: 0, summary: "✓ throws Error: not found" }],
    [{ status: "completed" as const, exitCode: 0, failureOutput: "deprecation: Error: legacy api" }],
    [{ status: "completed" as const, exitCode: 0, failureOutput: "HTTP/1.1 500 Internal Server Error" }],
    // The bare "Error:" token no longer trips a command with no exit code either.
    [{ status: "completed" as const, exitCode: null, summary: "✓ throws Error: not found" }],
  ])("does not flag a clean command %#", (command) => {
    expect(commandLooksFailed(command)).toBe(false);
  });
});

describe("commandLabel", () => {
  it.each([
    ["tsc --noEmit", "typecheck"],
    ["python -m mypy src", "typecheck"],
    ["npm test", "tests"],
    ["pytest tests/", "tests"],
    ["cargo test", "tests"],
    ["npx eslint .", "lint"],
    ["uv run ruff check .", "lint"],
    ["rubocop", "lint"],
    ["go fmt ./...", "lint"],
    ["cargo fmt", "lint"],
    ["yarn run build", "build"],
    ["cargo build", "build"],
    ["terraform validate", "infra"],
    ["alembic upgrade head", "migration"],
    ["uv run dbt parse", "migration"],
    ["npx prisma migrate status", "migration"],
    ["wrangler d1 migrations list DB", "migration"],
    ["wrangler deploy", "infra"],
    ["curl -sf http://localhost/health", "smoke"],
  ])("labels %s as %s", (command, expected) => {
    expect(commandLabel(command)).toBe(expected);
  });

  it("falls back to the leading executable token", () => {
    expect(commandLabel("./scripts/do-something.sh --flag")).toBe("./scripts/do-something.sh");
  });

  it("unwraps bash -c when labeling", () => {
    expect(commandLabel('bash -c "npm test"')).toBe("tests");
  });

  it("returns 'command' for empty input", () => {
    expect(commandLabel(undefined)).toBe("command");
    expect(commandLabel("")).toBe("command");
  });
});
