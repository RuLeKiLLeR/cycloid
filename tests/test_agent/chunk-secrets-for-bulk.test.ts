/**
 * Cloudflare's `wrangler secret bulk` endpoint rejects requests with more
 * than 25 secrets ([code: 100160]). We have 59. scripts/chunk-secrets-for-bulk.mjs
 * splits the flat secret JSON into <=20-key batches so the deploy workflow can
 * upload them in sequence. This test exercises the pure chunking helper
 * (`chunkSecrets`) plus the CLI entry-point that the deploy workflow calls.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { chunkSecrets } from "../../scripts/chunk-secrets-for-bulk.mjs";

const tempDirs: string[] = [];
const scriptPath = path.resolve(import.meta.dirname, "../../scripts/chunk-secrets-for-bulk.mjs");

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(n: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    out[`SECRET_${i.toString().padStart(3, "0")}`] = `value-${i}`;
  }
  return out;
}

describe("chunkSecrets (pure)", () => {
  it("splits 59 secrets into 3 batches of <=20 with no key loss or duplication", () => {
    const input = fixture(59);
    const batches = chunkSecrets(input, 20);
    expect(batches).toHaveLength(3);
    expect(Object.keys(batches[0]!)).toHaveLength(20);
    expect(Object.keys(batches[1]!)).toHaveLength(20);
    expect(Object.keys(batches[2]!)).toHaveLength(19);
    const union: Record<string, string> = {};
    for (const b of batches) Object.assign(union, b);
    expect(union).toEqual(input);
  });

  it("returns a single batch when the input fits", () => {
    const input = fixture(5);
    const batches = chunkSecrets(input, 20);
    expect(batches).toEqual([input]);
  });

  it("returns an empty array for an empty input", () => {
    expect(chunkSecrets({}, 20)).toEqual([]);
  });

  it("rejects arrays and non-objects", () => {
    expect(() => chunkSecrets([] as unknown as Record<string, string>, 20)).toThrow();
    expect(() => chunkSecrets(null as unknown as Record<string, string>, 20)).toThrow();
    expect(() => chunkSecrets("x" as unknown as Record<string, string>, 20)).toThrow();
  });

  it("rejects non-positive batch sizes", () => {
    expect(() => chunkSecrets({ A: "1" }, 0)).toThrow();
    expect(() => chunkSecrets({ A: "1" }, -1)).toThrow();
    expect(() => chunkSecrets({ A: "1" }, 1.5)).toThrow();
  });
});

describe("chunk-secrets-for-bulk CLI", () => {
  it("writes N batch files and prints the batch count to stdout", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "chunk-secrets-"));
    tempDirs.push(dir);
    const inputPath = path.join(dir, "secrets.json");
    const prefix = path.join(dir, "batch");
    writeFileSync(inputPath, JSON.stringify(fixture(59)));

    const stdout = execFileSync("node", [scriptPath, inputPath, prefix], { encoding: "utf8" });
    expect(stdout.trim()).toBe("3");

    const batchFiles = readdirSync(dir)
      .filter((f) => f.startsWith("batch-"))
      .sort();
    expect(batchFiles).toEqual(["batch-0.json", "batch-1.json", "batch-2.json"]);

    const union: Record<string, string> = {};
    for (const f of batchFiles) {
      const chunk = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
      for (const k of Object.keys(chunk)) {
        // No key should appear in more than one batch.
        expect(union[k]).toBeUndefined();
        union[k] = chunk[k];
      }
    }
    expect(union).toEqual(fixture(59));
  });

  it("exits 2 with a named-env error when SECRET_BULK_BATCH_SIZE is not a positive integer", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "chunk-secrets-"));
    tempDirs.push(dir);
    const inputPath = path.join(dir, "secrets.json");
    writeFileSync(inputPath, JSON.stringify(fixture(5)));

    for (const bad of ["abc", "0", "-3", "2.5", ""]) {
      let caught: { status: number | null; stderr: string } | null = null;
      try {
        execFileSync("node", [scriptPath, inputPath, path.join(dir, "batch")], {
          encoding: "utf8",
          // Empty string disables the env override path (script falls back to
          // the default 20), so we only assert the non-empty bad cases.
          env:
            bad === ""
              ? { ...process.env, SECRET_BULK_BATCH_SIZE: undefined }
              : { ...process.env, SECRET_BULK_BATCH_SIZE: bad },
        });
      } catch (err) {
        const e = err as { status?: number | null; stderr?: string | Buffer };
        caught = { status: e.status ?? null, stderr: String(e.stderr ?? "") };
      }
      if (bad === "") {
        // Empty string: script ignored override, used default — no failure.
        expect(caught).toBeNull();
      } else {
        expect(caught, `expected failure for SECRET_BULK_BATCH_SIZE=${bad}`).not.toBeNull();
        expect(caught!.status).toBe(2);
        expect(caught!.stderr).toContain("SECRET_BULK_BATCH_SIZE");
      }
    }
  });

  it("honors SECRET_BULK_BATCH_SIZE env override", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "chunk-secrets-"));
    tempDirs.push(dir);
    const inputPath = path.join(dir, "secrets.json");
    writeFileSync(inputPath, JSON.stringify(fixture(10)));

    const stdout = execFileSync("node", [scriptPath, inputPath, path.join(dir, "batch")], {
      encoding: "utf8",
      env: { ...process.env, SECRET_BULK_BATCH_SIZE: "3" },
    });
    // 10 keys / 3 = ceil(10/3) = 4 batches.
    expect(stdout.trim()).toBe("4");
  });
});
