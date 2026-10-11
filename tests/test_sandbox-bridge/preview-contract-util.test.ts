import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  parsePreviewContractJson,
  readConfiguredPreviewContract,
  readPreviewContractFromFiles,
} from "../../apps/sandbox-bridge/src/utils/preview-contract.js";

const validContract = (overrides: Record<string, unknown> = {}) => ({
  cwd: "/workspace/repo",
  kind: "web",
  runner: "docker",
  entry: { type: "compose", files: ["docker-compose.yml"], service: "web" },
  url: { hostPort: 4173 },
  ...overrides,
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "preview-contract-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readPreviewContractFromFiles", () => {
  it("reads the explicit contractPath first", () => {
    const contractPath = join(dir, "explicit.json");
    writeFileSync(contractPath, JSON.stringify(validContract({ cwd: "/explicit" })));
    writeFileSync(join(dir, "preview-contract.json"), JSON.stringify(validContract({ cwd: "/evidence" })));
    const result = readPreviewContractFromFiles({ contractPath, evidenceDir: dir });
    expect(result?.cwd).toBe("/explicit");
  });

  it("falls back to <evidenceDir>/preview-contract.json", () => {
    writeFileSync(join(dir, "preview-contract.json"), JSON.stringify(validContract({ cwd: "/from-preview" })));
    const result = readPreviewContractFromFiles({ contractPath: join(dir, "missing.json"), evidenceDir: dir });
    expect(result?.cwd).toBe("/from-preview");
  });

  it("falls back to <evidenceDir>/contract.json", () => {
    writeFileSync(join(dir, "contract.json"), JSON.stringify(validContract({ cwd: "/from-contract" })));
    const result = readPreviewContractFromFiles({ contractPath: join(dir, "missing.json"), evidenceDir: dir });
    expect(result?.cwd).toBe("/from-contract");
  });

  it("does NOT glob arbitrary *.json files in the evidence dir", () => {
    // A valid contract in an unexpected file name must be ignored (the removed glob fallback).
    writeFileSync(join(dir, "something-else.json"), JSON.stringify(validContract({ cwd: "/should-not-load" })));
    const result = readPreviewContractFromFiles({ contractPath: join(dir, "missing.json"), evidenceDir: dir });
    expect(result).toBeUndefined();
  });

  it("skips invalid JSON / invalid contracts and continues to the next candidate", () => {
    const contractPath = join(dir, "explicit.json");
    writeFileSync(contractPath, "{ not valid json");
    writeFileSync(join(dir, "preview-contract.json"), JSON.stringify({ kind: "web" })); // missing fields
    writeFileSync(join(dir, "contract.json"), JSON.stringify(validContract({ cwd: "/recovered" })));
    const warnings: Array<Record<string, unknown>> = [];
    const result = readPreviewContractFromFiles({
      contractPath,
      evidenceDir: dir,
      log: { warn: (obj) => warnings.push(obj) },
    });
    expect(result?.cwd).toBe("/recovered");
    // Both invalid candidates warn before the valid contract.json is reached: explicit.json for the
    // JSON parse error, preview-contract.json for failing schema validation.
    expect(warnings.some((w) => String(w.path).endsWith("explicit.json"))).toBe(true);
    expect(warnings.some((w) => String(w.path).endsWith("preview-contract.json"))).toBe(true);
    expect(warnings).toHaveLength(2);
  });

  it("returns undefined when no candidate exists", () => {
    expect(readPreviewContractFromFiles({ contractPath: join(dir, "x.json"), evidenceDir: dir })).toBeUndefined();
  });
});

describe("parsePreviewContractJson / readConfiguredPreviewContract", () => {
  it("parses a valid contract from a JSON string", () => {
    expect(parsePreviewContractJson(JSON.stringify(validContract()))?.kind).toBe("web");
  });

  it("parses generated compose env specs", () => {
    const result = parsePreviewContractJson(
      JSON.stringify(
        validContract({
          generatedComposeEnv: {
            DOGFOOD_SESSION_TOKEN: { type: "hex", bytes: 32 },
          },
        }),
      ),
    );

    expect(result?.generatedComposeEnv).toEqual({
      DOGFOOD_SESSION_TOKEN: { type: "hex", bytes: 32 },
    });
  });

  it("returns undefined for invalid/empty input", () => {
    expect(parsePreviewContractJson(undefined)).toBeUndefined();
    expect(parsePreviewContractJson("not json")).toBeUndefined();
    expect(parsePreviewContractJson(JSON.stringify({ kind: "web" }))).toBeUndefined();
  });

  it("reads ARCANIST_PREVIEW_CONTRACT_JSON from the provided env", () => {
    const env = {
      ARCANIST_PREVIEW_CONTRACT_JSON: JSON.stringify(validContract({ cwd: "/from-env" })),
    } as NodeJS.ProcessEnv;
    expect(readConfiguredPreviewContract(env)?.cwd).toBe("/from-env");
    expect(readConfiguredPreviewContract({} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});
