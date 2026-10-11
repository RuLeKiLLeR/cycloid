import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildInsertCliTokenSql,
  describeD1Failure,
  githubUserFallbackWarning,
  hashLocalCliToken,
} from "../../scripts/mint-local-cli-token";

const REPO_ROOT = resolve(__dirname, "../..");

describe("mint-local-cli-token", () => {
  it("hashes local tokens with the server SHA-256 helper", async () => {
    await expect(
      hashLocalCliToken("arc_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
    ).resolves.toBe("8d0170281ce943302a0d2baae29811eed8cd9849402f5d219e7375f40398de40");
  });

  it("inserts the full local CLI token column set as a write-scoped token", () => {
    const sql = buildInsertCliTokenSql({
      userId: 123,
      tokenHash: "a".repeat(64),
      tokenPrefix: "arc_abcd",
      createdAt: 456,
      scope: "write",
    });

    expect(sql).toBe(
      "INSERT INTO cli_tokens (user_id, token_hash, token_prefix, created_at, scope, expires_at) VALUES (123, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'arc_abcd', 456, 'write', NULL)",
    );
  });

  it("includes wrangler D1 failure details in thrown errors", () => {
    expect(describeD1Failure({ success: false, error: "UNIQUE constraint failed: cli_tokens.token_hash" }, 0)).toBe(
      "Local D1 command 1 failed: UNIQUE constraint failed: cli_tokens.token_hash",
    );
    expect(describeD1Failure({ success: false }, 1)).toBe("Local D1 command 2 failed.");
  });

  it("warns before falling back when the authenticated GitHub user is not seeded", () => {
    expect(githubUserFallbackWarning(12345)).toBe(
      "warn: GitHub id 12345 not found in local users; falling back to singleton local user check.",
    );
  });

  it("wires worktree setup to mint after worktree ports are written", () => {
    const script = readFileSync(resolve(REPO_ROOT, "scripts/worktree-setup.sh"), "utf8");

    expect(script.indexOf('cat > "$WORKTREE/.worktree-ports" <<EOF')).toBeGreaterThanOrEqual(0);
    expect(script.indexOf("npx tsx scripts/mint-local-cli-token.ts --write-config")).toBeGreaterThan(
      script.indexOf('cat > "$WORKTREE/.worktree-ports" <<EOF'),
    );
  });
});
