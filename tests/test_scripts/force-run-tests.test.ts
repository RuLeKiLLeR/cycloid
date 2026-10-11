import { describe, expect, it } from "vitest";

type ForceRunTestsModule = {
  getRepoFiles: () => string[];
  loadManifest: () => Array<{ source: string[]; tests: string[] }>;
  resolveGlob: (glob: string, repoFiles?: string[]) => string[];
  selectForcedTests: (
    changedFiles: string[],
    manifest: Array<{ source: string[]; tests: string[] }>,
    repoFiles: string[],
  ) => string[];
};

const { getRepoFiles, loadManifest, resolveGlob, selectForcedTests } =
  // @ts-expect-error The executable .mjs helper intentionally has no declaration file.
  (await import("../../scripts/force-run-tests.mjs")) as ForceRunTestsModule;

describe("force-run tests manifest", () => {
  it("keeps every manifest glob resolving to existing files", () => {
    const repoFiles = getRepoFiles();
    const manifest = loadManifest();

    for (const entry of manifest) {
      for (const sourceGlob of entry.source) {
        expect(resolveGlob(sourceGlob, repoFiles), `${sourceGlob} should resolve`).not.toHaveLength(0);
      }
      for (const testGlob of entry.tests) {
        expect(resolveGlob(testGlob, repoFiles), `${testGlob} should resolve`).not.toHaveLength(0);
      }
    }
  });

  it("selects schema validation when migrations change", () => {
    const selected = selectForcedTests(
      ["apps/control-plane-worker/migrations/9999_scratch.sql"],
      loadManifest(),
      getRepoFiles(),
    );

    expect(selected).toContain("tests/test_cloudflare/schema-validation.test.ts");
  });

  it("selects forced tests for source-side rename paths", () => {
    const selected = selectForcedTests(
      [".github/workflows/typecheck.yml", "docs/typecheck-workflow.yml"],
      loadManifest(),
      getRepoFiles(),
    );

    expect(selected).toContain("tests/test_agent/typecheck-workflow.test.ts");
  });

  it("treats question mark globs as one non-separator character", () => {
    const repoFiles = ["apps/migrations/0007_init.sql", "apps/migrations/00_init.sql", "apps/migrations/000/init.sql"];

    expect(resolveGlob("apps/migrations/000?_init.sql", repoFiles)).toEqual(["apps/migrations/0007_init.sql"]);
  });

  it("selects the meta-test when the scanner or manifest changes", () => {
    const selected = selectForcedTests(["scripts/force-run-tests.mjs"], loadManifest(), getRepoFiles());

    expect(selected).toEqual(["tests/test_scripts/force-run-tests.test.ts"]);
  });
});
