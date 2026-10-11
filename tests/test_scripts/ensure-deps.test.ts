import { describe, expect, it } from "vitest";

import { hashLockfile, needsInstall } from "../../scripts/ensure-deps.mjs";

describe("ensure-deps drift detection", () => {
  it("treats a wiped/never-installed node_modules (no stamp) as drifted", () => {
    expect(needsInstall('{"lockfileVersion":3}', null)).toBe(true);
  });

  it("does nothing when there is no lockfile to enforce", () => {
    expect(needsInstall(null, "any-stamp")).toBe(false);
  });

  it("is in sync when the stamp matches the current lockfile hash", () => {
    const lock = '{"lockfileVersion":3,"packages":{}}';
    expect(needsInstall(lock, hashLockfile(lock))).toBe(false);
  });

  it("tolerates trailing whitespace in the stamp file", () => {
    const lock = '{"lockfileVersion":3,"packages":{}}';
    expect(needsInstall(lock, `${hashLockfile(lock)}\n`)).toBe(false);
  });

  it("flags drift when the lockfile changed since the last install", () => {
    const oldLock = '{"lockfileVersion":3,"packages":{"":{"dependencies":{"a":"1.0.0"}}}}';
    const newLock = '{"lockfileVersion":3,"packages":{"":{"dependencies":{"a":"2.0.0"}}}}';
    expect(needsInstall(newLock, hashLockfile(oldLock))).toBe(true);
  });
});
