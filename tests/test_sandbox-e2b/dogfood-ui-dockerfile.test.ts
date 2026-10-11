import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const DOCKERFILE = resolve(REPO_ROOT, "Dockerfile.dogfood-runtime");

describe("dogfood runtime Dockerfile", () => {
  const source = readFileSync(DOCKERFILE, "utf8");

  it("uses a bind-mounted source tree so verifier edits can affect the running app", () => {
    expect(source).toContain("WORKDIR /workspace/repo");
    expect(source).toContain("Dependencies live in");
  });

  it("includes native build tooling for the runtime dependency install", () => {
    expect(source).toContain("build-essential");
    expect(source).toContain("python3");
  });
});
