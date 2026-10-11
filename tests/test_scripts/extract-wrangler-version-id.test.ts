import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { extractVersionId } from "../../scripts/extract-wrangler-version-id.mjs";

const SCRIPT = resolve("scripts/extract-wrangler-version-id.mjs");

// Run the extractor as the deploy and the PR-time guard do: a child `node`
// process. The guard accepts only exit 0/3 and the deploy runs it under set -e,
// so the exact exit codes are a contract other files depend on - lock them here.
function runCli(args: string[], input?: string) {
  return spawnSync("node", [SCRIPT, ...args], { encoding: "utf8", input });
}

// A version-upload NDJSON record as `wrangler versions upload` emits it. A real
// deploy carries a non-null version_id; a --dry-run emits the same shape with a
// null id.
const uploadRecord = (versionId: string | null) =>
  JSON.stringify({
    type: "version-upload",
    version: 1,
    worker_name: "cycloid-control-plane-production",
    version_id: versionId,
    wrangler_environment: "",
  });

const sessionLine = JSON.stringify({ type: "wrangler-session", version: "4.107.0" });

describe("extractVersionId", () => {
  it("returns the id from a real version-upload record", () => {
    expect(extractVersionId(uploadRecord("abc123def456"))).toEqual({
      sawRecord: true,
      id: "abc123def456",
    });
  });

  it("finds the version-upload record among other NDJSON lines", () => {
    const ndjson = [sessionLine, uploadRecord("def789")].join("\n");
    expect(extractVersionId(ndjson)).toEqual({ sawRecord: true, id: "def789" });
  });

  it("reports a record with a null version_id (deploy fails closed on this)", () => {
    expect(extractVersionId(uploadRecord(null))).toEqual({ sawRecord: true, id: null });
  });

  it("reports no record for empty, blank, or malformed output", () => {
    expect(extractVersionId("")).toEqual({ sawRecord: false, id: null });
    expect(extractVersionId("\n\n  \n")).toEqual({ sawRecord: false, id: null });
    expect(extractVersionId("not json\n{ broken")).toEqual({ sawRecord: false, id: null });
    expect(extractVersionId(sessionLine)).toEqual({ sawRecord: false, id: null });
  });

  it("returns the last id when multiple version-upload records are present", () => {
    const ndjson = [uploadRecord("first"), uploadRecord("second")].join("\n");
    expect(extractVersionId(ndjson)).toEqual({ sawRecord: true, id: "second" });
  });

  it("does not let a later null-id record clobber an earlier non-null id", () => {
    const ndjson = [uploadRecord("keep-me"), uploadRecord(null)].join("\n");
    expect(extractVersionId(ndjson)).toEqual({ sawRecord: true, id: "keep-me" });
  });

  it("skips malformed lines interleaved with a valid record", () => {
    const ndjson = ["garbage", uploadRecord("valid-id"), "{ also broken"].join("\n");
    expect(extractVersionId(ndjson)).toEqual({ sawRecord: true, id: "valid-id" });
  });
});

describe("extract-wrangler-version-id CLI exit-code contract", () => {
  const dir = mkdtempSync(join(tmpdir(), "extract-version-id-"));
  const write = (name: string, contents: string) => {
    const path = join(dir, name);
    writeFileSync(path, contents);
    return path;
  };

  it("exits 0 and prints the id when a version_id is present", () => {
    const result = runCli([write("ok.ndjson", uploadRecord("cli-id-123"))]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("cli-id-123");
  });

  it("exits 3 when a record is present but its version_id is null (dry-run)", () => {
    const result = runCli([write("null.ndjson", uploadRecord(null))]);
    expect(result.status).toBe(3);
  });

  it("exits 4 when no version-upload record is found", () => {
    const result = runCli([write("none.ndjson", sessionLine)]);
    expect(result.status).toBe(4);
  });

  it("exits 5 with a distinct read error when the input file is missing", () => {
    const result = runCli([join(dir, "does-not-exist.ndjson")]);
    expect(result.status).toBe(5);
    expect(result.stderr).toContain("Unable to read wrangler output");
  });

  it("reads NDJSON from stdin when no path argument is given", () => {
    const result = runCli([], uploadRecord("stdin-id"));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("stdin-id");
  });
});
