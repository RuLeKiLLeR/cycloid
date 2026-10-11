import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error -- plain .mjs script, no type declarations
import { readWranglerVar } from "../../scripts/validate-control-plane-secrets.mjs";

// ARC-1483 (b): readWranglerVar feeds requireFreestyleKey. Its old single-line
// double-quoted-only regex returned null on any format it did not match (single-quoted
// literal, indentation, ...), silently flipping the routing-on FREESTYLE_API_KEY /
// snapshot guards to "off". The robust reader must tolerate the realistic wrangler var
// formats, return null ONLY on a genuinely-absent key, and THROW (fail closed at the
// deploy gate) when a key is present but its value is in a format it cannot parse.

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeToml(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "wrangler-var-"));
  tempDirs.push(dir);
  const tomlPath = path.join(dir, "wrangler.toml");
  writeFileSync(tomlPath, contents);
  return tomlPath;
}

describe("readWranglerVar (ARC-1483)", () => {
  it("reads a standard double-quoted value from [vars]", () => {
    const toml = writeToml(["[vars]", 'FREESTYLE_SANDBOX_BACKEND_OVERRIDE = "org:trycycloid"', ""].join("\n"));
    expect(readWranglerVar("production", "FREESTYLE_SANDBOX_BACKEND_OVERRIDE", toml)).toBe("org:trycycloid");
  });

  it("reads a single-quoted TOML literal value (regex-fragile case that used to return null)", () => {
    const toml = writeToml(["[vars]", "FREESTYLE_SANDBOX_BACKEND_OVERRIDE = 'org:trycycloid'", ""].join("\n"));
    expect(readWranglerVar("production", "FREESTYLE_SANDBOX_BACKEND_OVERRIDE", toml)).toBe("org:trycycloid");
  });

  it("tolerates leading indentation on the key line", () => {
    const toml = writeToml(["[vars]", '  FREESTYLE_SANDBOX_BACKEND_OVERRIDE = "org:trycycloid"', ""].join("\n"));
    expect(readWranglerVar("production", "FREESTYLE_SANDBOX_BACKEND_OVERRIDE", toml)).toBe("org:trycycloid");
  });

  it("strips a trailing inline comment", () => {
    const toml = writeToml(
      ["[vars]", 'FREESTYLE_SANDBOX_BACKEND_OVERRIDE = "org:trycycloid" # dogfood', ""].join("\n"),
    );
    expect(readWranglerVar("production", "FREESTYLE_SANDBOX_BACKEND_OVERRIDE", toml)).toBe("org:trycycloid");
  });

  it("reads the correct table for the env: [vars] for production, [env.qa.vars] for qa", () => {
    const toml = writeToml(
      [
        "[vars]",
        'FREESTYLE_SANDBOX_BACKEND_OVERRIDE = "org:trycycloid"',
        "",
        "[env.qa.vars]",
        'FREESTYLE_SANDBOX_BACKEND_OVERRIDE = ""',
        "",
      ].join("\n"),
    );
    expect(readWranglerVar("production", "FREESTYLE_SANDBOX_BACKEND_OVERRIDE", toml)).toBe("org:trycycloid");
    expect(readWranglerVar("qa", "FREESTYLE_SANDBOX_BACKEND_OVERRIDE", toml)).toBe("");
  });

  it("does not read a value from a different table (stops at the next table header)", () => {
    const toml = writeToml(
      ["[vars]", 'WORKER_ENV = "production"', "", "[env.qa.vars]", 'ONLY_IN_QA = "qa-value"', ""].join("\n"),
    );
    // ONLY_IN_QA lives in [env.qa.vars]; a production read must not leak it.
    expect(readWranglerVar("production", "ONLY_IN_QA", toml)).toBeNull();
    expect(readWranglerVar("qa", "ONLY_IN_QA", toml)).toBe("qa-value");
  });

  it("returns null when the key is genuinely absent from a present table (legit 'routing off')", () => {
    const toml = writeToml(["[vars]", 'WORKER_ENV = "production"', ""].join("\n"));
    expect(readWranglerVar("production", "FREESTYLE_SANDBOX_BACKEND_OVERRIDE", toml)).toBeNull();
  });

  it("returns null when the table itself is missing", () => {
    const toml = writeToml(["[somethingelse]", 'X = "y"', ""].join("\n"));
    expect(readWranglerVar("production", "FREESTYLE_SANDBOX_BACKEND_OVERRIDE", toml)).toBeNull();
  });

  it("returns null when the file cannot be read", () => {
    expect(readWranglerVar("production", "FREESTYLE_SANDBOX_BACKEND_OVERRIDE", "/no/such/wrangler.toml")).toBeNull();
  });

  it("THROWS on a present-but-unparseable value rather than silently disarming (fail closed)", () => {
    // A key present in a format the reader does not understand (bare token / array)
    // must NOT be treated as absent — that silent null is the exact disarm this guards.
    const bare = writeToml(["[vars]", "FREESTYLE_SANDBOX_BACKEND_OVERRIDE = org:trycycloid", ""].join("\n"));
    expect(() => readWranglerVar("production", "FREESTYLE_SANDBOX_BACKEND_OVERRIDE", bare)).toThrow(
      /unsupported value/i,
    );

    const array = writeToml(["[vars]", 'FREESTYLE_SANDBOX_BACKEND_OVERRIDE = ["org:trycycloid"]', ""].join("\n"));
    expect(() => readWranglerVar("production", "FREESTYLE_SANDBOX_BACKEND_OVERRIDE", array)).toThrow(
      /unsupported value/i,
    );
  });
});
