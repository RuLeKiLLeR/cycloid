import { describe, expect, it } from "vitest";

import { isReviewLoopSensitivePath } from "../../apps/control-plane-worker/src/session/publish-service";

describe("isReviewLoopSensitivePath (repo-agnostic owner-approval heuristic)", () => {
  describe("flags sensitive changes in an arbitrary customer repo", () => {
    const sensitive = [
      // Database migrations — top-level and nested layouts.
      "migrations/20240101_add_users.sql",
      "db/migrations/0007_add_users_table.sql",
      "services/api/migrations/V3__add_index.sql",
      "prisma/migrations/0001_init/migration.sql",
      "alembic/migration/abc123_add_col.py",
      // CI/CD pipeline config.
      ".github/workflows/deploy.yml",
      "repo/.github/workflows/ci.yaml",
      ".gitlab-ci.yml",
      ".circleci/config.yml",
      "cloudbuild.yaml",
      ".buildkite/pipeline.yml",
      "buildkite.yaml",
      // Infrastructure-as-code.
      "terraform/main.tf",
      "infra/modules/network/variables.tf",
      "deploy/prod.tfvars",
      "k8s/deployment.yaml",
      "helm/chart/values.yaml",
      "Dockerfile",
      "services/web/Dockerfile",
      "docker-compose.yml",
      "wrangler.toml",
      "fly.toml",
      // Dependency lockfiles.
      "package-lock.json",
      "frontend/yarn.lock",
      "pnpm-lock.yaml",
      "Cargo.lock",
      "bun.lock",
      "poetry.lock",
      "go.sum",
      "Gemfile.lock",
      "composer.lock",
      // Auth/secret config.
      ".env",
      ".env.production",
      "config/.env.local",
      ".npmrc",
    ];

    for (const path of sensitive) {
      it(`flags ${path}`, () => {
        expect(isReviewLoopSensitivePath(path)).toBe(true);
      });
    }

    it("tolerates a leading slash and mixed case", () => {
      expect(isReviewLoopSensitivePath("/db/Migrations/0001_init.SQL")).toBe(true);
      expect(isReviewLoopSensitivePath("/DOCKERFILE")).toBe(true);
    });
  });

  describe("does not flag ordinary source files", () => {
    const ordinary = [
      "src/index.ts",
      "src/components/Button.tsx",
      "lib/util/format.go",
      "app/models/user.rb",
      "packages/core/src/migrate-helper.ts", // not a migrations dir
      "docs/migrations-guide.md", // filename contains "migrations" but not a dir segment
      "README.md",
      "package.json", // manifest, not the lockfile
      "tsconfig.json",
      "test/fixtures/sample.env.txt", // not an env file basename
      "src/github-workflows.ts", // not the .github/workflows dir
    ];

    for (const path of ordinary) {
      it(`ignores ${path}`, () => {
        expect(isReviewLoopSensitivePath(path)).toBe(false);
      });
    }

    it("ignores empty/whitespace paths", () => {
      expect(isReviewLoopSensitivePath("")).toBe(false);
      expect(isReviewLoopSensitivePath("   ")).toBe(false);
    });
  });
});
