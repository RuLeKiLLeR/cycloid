import { describe, expect, it } from "vitest";

import type { Repo } from "../../apps/ui/src/types";
import { prioritizeDefaultRepo } from "../../apps/ui/src/utils/repos";

function repo(fullName: string, url?: string): Repo {
  return {
    fullName,
    url: url ?? `https://github.com/${fullName}`,
    private: false,
    defaultBranch: "main",
    ownerType: "Organization",
  };
}

describe("prioritizeDefaultRepo", () => {
  const repoA = repo("org/alpha");
  const repoB = repo("org/beta");
  const repoC = repo("org/charlie");

  it("moves the default repo to the front of the list", () => {
    const result = prioritizeDefaultRepo([repoA, repoB, repoC], repoC.fullName);
    expect(result.repos.map((r) => r.fullName)).toEqual(["org/charlie", "org/alpha", "org/beta"]);
    expect(result.defaultRepo).toBe(repoC);
  });

  it("preserves order of remaining repos when default is moved", () => {
    const result = prioritizeDefaultRepo([repoA, repoB, repoC], repoB.fullName);
    expect(result.repos.map((r) => r.fullName)).toEqual(["org/beta", "org/alpha", "org/charlie"]);
  });

  it("returns the list unchanged when default repo is already first", () => {
    const input = [repoA, repoB, repoC];
    const result = prioritizeDefaultRepo(input, repoA.fullName);
    expect(result.repos).toBe(input); // same reference -- no reallocation
    expect(result.defaultRepo).toBe(repoA);
  });

  it("returns the list unchanged when defaultRepoUrl is null", () => {
    const input = [repoA, repoB];
    const result = prioritizeDefaultRepo(input, null);
    expect(result.repos).toBe(input);
    expect(result.defaultRepo).toBeNull();
  });

  it("returns the list unchanged when defaultRepoUrl is undefined", () => {
    const input = [repoA, repoB];
    const result = prioritizeDefaultRepo(input, undefined);
    expect(result.repos).toBe(input);
    expect(result.defaultRepo).toBeNull();
  });

  it("returns the list unchanged when defaultRepoUrl is not found", () => {
    const input = [repoA, repoB];
    const result = prioritizeDefaultRepo(input, "org/nonexistent");
    expect(result.repos).toBe(input);
    expect(result.defaultRepo).toBeNull();
  });

  it("does not match against url (settings stores fullName, not url)", () => {
    const input = [repoA, repoB];
    const result = prioritizeDefaultRepo(input, "https://github.com/org/alpha");
    expect(result.repos).toBe(input);
    expect(result.defaultRepo).toBeNull();
  });

  it("handles a single-element list where the repo matches", () => {
    const input = [repoA];
    const result = prioritizeDefaultRepo(input, repoA.fullName);
    expect(result.repos).toBe(input);
    expect(result.defaultRepo).toBe(repoA);
  });

  it("handles an empty repo list", () => {
    const input: Repo[] = [];
    const result = prioritizeDefaultRepo(input, repoA.fullName);
    expect(result.repos).toBe(input);
    expect(result.defaultRepo).toBeNull();
  });

  it("handles an empty defaultRepoUrl string", () => {
    const input = [repoA, repoB];
    const result = prioritizeDefaultRepo(input, "");
    expect(result.repos).toBe(input);
    expect(result.defaultRepo).toBeNull();
  });

  it("does not mutate the original array", () => {
    const input = [repoA, repoB, repoC];
    const copy = [...input];
    prioritizeDefaultRepo(input, repoC.fullName);
    expect(input).toEqual(copy);
  });
});
