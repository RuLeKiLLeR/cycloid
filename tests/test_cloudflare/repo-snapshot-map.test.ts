import { describe, expect, it } from "vitest";

import { lookupRepoSnapshotMap } from "../../apps/control-plane-worker/src/sandbox/repo-snapshot-map";

const ARGS = {
  varName: "E2B_REPO_SNAPSHOT_MAP_JSON",
  repoOwner: "acme",
  repoName: "widget",
  branch: null,
  repoPrivate: false as boolean | undefined,
};

describe("lookupRepoSnapshotMap", () => {
  it("returns no snapshot for an unset or blank var", () => {
    expect(lookupRepoSnapshotMap(undefined, ARGS)).toEqual({ snapshotId: null });
    expect(lookupRepoSnapshotMap("   ", ARGS)).toEqual({ snapshotId: null });
  });

  it("resolves a string entry for a public repo", () => {
    const raw = JSON.stringify({ "acme/widget": "snap-1" });
    expect(lookupRepoSnapshotMap(raw, ARGS)).toEqual({ snapshotId: "snap-1", key: "acme/widget" });
  });

  it("prefers the branch-qualified key over the repo key", () => {
    const raw = JSON.stringify({ "acme/widget@main": "snap-branch", "acme/widget": "snap-repo" });
    expect(lookupRepoSnapshotMap(raw, { ...ARGS, branch: "main" })).toEqual({
      snapshotId: "snap-branch",
      key: "acme/widget@main",
    });
    expect(lookupRepoSnapshotMap(raw, { ...ARGS, branch: "other" })).toEqual({
      snapshotId: "snap-repo",
      key: "acme/widget",
    });
  });

  it("falls through a branch-qualified miss to the repo key when no branch is known", () => {
    const raw = JSON.stringify({ "acme/widget@main": "snap-branch" });
    expect(lookupRepoSnapshotMap(raw, ARGS)).toEqual({ snapshotId: null });
  });

  it("never matches a string entry for a private or unknown-visibility repo", () => {
    const raw = JSON.stringify({ "acme/widget": "snap-1" });
    expect(lookupRepoSnapshotMap(raw, { ...ARGS, repoPrivate: true })).toEqual({ snapshotId: null });
    expect(lookupRepoSnapshotMap(raw, { ...ARGS, repoPrivate: undefined })).toEqual({ snapshotId: null });
  });

  it("matches object entries with allowPrivate for private and unknown-visibility repos", () => {
    const raw = JSON.stringify({ "acme/widget": { snapshotId: "snap-1", allowPrivate: true } });
    expect(lookupRepoSnapshotMap(raw, { ...ARGS, repoPrivate: true })).toEqual({
      snapshotId: "snap-1",
      key: "acme/widget",
    });
    expect(lookupRepoSnapshotMap(raw, { ...ARGS, repoPrivate: undefined })).toEqual({
      snapshotId: "snap-1",
      key: "acme/widget",
    });
  });

  it("skips object entries without allowPrivate for private repos but matches public ones", () => {
    const raw = JSON.stringify({ "acme/widget": { snapshotId: "snap-1" } });
    expect(lookupRepoSnapshotMap(raw, { ...ARGS, repoPrivate: true })).toEqual({ snapshotId: null });
    expect(lookupRepoSnapshotMap(raw, ARGS)).toEqual({ snapshotId: "snap-1", key: "acme/widget" });
  });

  it("skips blank and non-string snapshot ids and trims matched ones", () => {
    expect(lookupRepoSnapshotMap(JSON.stringify({ "acme/widget": "   " }), ARGS)).toEqual({ snapshotId: null });
    expect(lookupRepoSnapshotMap(JSON.stringify({ "acme/widget": { snapshotId: 7 } }), ARGS)).toEqual({
      snapshotId: null,
    });
    expect(lookupRepoSnapshotMap(JSON.stringify({ "acme/widget": " snap-1 " }), ARGS)).toEqual({
      snapshotId: "snap-1",
      key: "acme/widget",
    });
  });

  it("labels malformed JSON errors with the caller's var name", () => {
    const result = lookupRepoSnapshotMap("{not json", { ...ARGS, varName: "FREESTYLE_REPO_SNAPSHOT_MAP_JSON" });
    expect(result.snapshotId).toBeNull();
    expect(result.error).toMatch(/^invalid FREESTYLE_REPO_SNAPSHOT_MAP_JSON: /);
  });

  it("rejects non-object roots", () => {
    for (const raw of [JSON.stringify(["snap-1"]), JSON.stringify("snap-1"), "null"]) {
      const result = lookupRepoSnapshotMap(raw, ARGS);
      expect(result.snapshotId).toBeNull();
      expect(result.error).toBe("E2B_REPO_SNAPSHOT_MAP_JSON must be an object");
    }
  });
});
