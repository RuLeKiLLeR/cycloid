import { beforeEach, describe, expect, it, vi } from "vitest";

import { GitHubRequestError } from "../../apps/control-plane-worker/src/github/errors";

const mockGetFileContent = vi.hoisted(() => vi.fn());
const mockListDirectoryContents = vi.hoisted(() => vi.fn());

vi.mock("../../apps/control-plane-worker/src/memory/github", () => ({
  getFileContent: (...args: unknown[]) => mockGetFileContent(...args),
  listDirectoryContents: (...args: unknown[]) => mockListDirectoryContents(...args),
}));

import { loadActiveRepoMemories } from "../../apps/control-plane-worker/src/company-memory/repo-memory-source";

function memoryMarkdown(id: string, status = "active"): string {
  return [
    "---",
    `id: ${id}`,
    "vertical: engineering",
    "memory_type: action",
    "action_type: procedure",
    "level: tactical",
    "primitive: procedure",
    "engineering_domains:",
    "  - testing",
    `status: ${status}`,
    "confidence: high",
    "authority: reviewed",
    "applies_to:",
    "  - README.md",
    `context_hint: hint for ${id}`,
    "source_pr_urls: []",
    "source_session_ids: []",
    "evidence: []",
    "enforcement: suggest",
    "supersedes: []",
    "contradicts: []",
    "created_at: 2026-06-11",
    "updated_at: 2026-06-11",
    "---",
    "",
    `Body for ${id}.`,
  ].join("\n");
}

function fileEntry(name: string) {
  return { name, path: `.cycloid/memory/${name}`, sha: `sha-${name}`, type: "file" as const };
}

const input = { token: "tok", owner: "acme", repo: "repo", ref: "main" };

describe("loadActiveRepoMemories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches file contents in parallel and keeps listing order", async () => {
    mockListDirectoryContents.mockResolvedValue([fileEntry("a.md"), fileEntry("b.md"), fileEntry("c.md")]);
    const resolvers = new Map<string, (value: string) => void>();
    mockGetFileContent.mockImplementation(
      (_token: string, _owner: string, _repo: string, path: string) =>
        new Promise<string>((resolve) => resolvers.set(path, resolve)),
    );

    const pending = loadActiveRepoMemories(input);
    // All three fetches are in flight before any resolves: parallel, not sequential.
    await vi.waitFor(() => expect(resolvers.size).toBe(3));
    // Resolve out of order; records must still follow listing order.
    resolvers.get(".cycloid/memory/c.md")!(memoryMarkdown("mem-c"));
    resolvers.get(".cycloid/memory/a.md")!(memoryMarkdown("mem-a"));
    resolvers.get(".cycloid/memory/b.md")!(memoryMarkdown("mem-b"));

    const records = await pending;
    expect(records.map((record) => record.id)).toEqual(["mem-a", "mem-b", "mem-c"]);
    expect(mockListDirectoryContents).toHaveBeenCalledWith("tok", "acme", "repo", ".cycloid/memory", "main", {
      allowNotFound: false,
    });
  });

  it("skips missing files and non-active memories, deduping by first occurrence", async () => {
    mockListDirectoryContents.mockResolvedValue([
      fileEntry("missing.md"),
      fileEntry("first.md"),
      fileEntry("dupe.md"),
      fileEntry("retired.md"),
    ]);
    mockGetFileContent.mockImplementation(async (_token: string, _owner: string, _repo: string, path: string) => {
      if (path.endsWith("missing.md")) return null;
      if (path.endsWith("retired.md")) return memoryMarkdown("mem-retired", "deprecated");
      if (path.endsWith("dupe.md")) return memoryMarkdown("mem-1");
      return memoryMarkdown("mem-1");
    });

    const records = await loadActiveRepoMemories(input);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: "mem-1", path: ".cycloid/memory/first.md" });
  });

  it("fails closed when any content fetch hits a transient error", async () => {
    mockListDirectoryContents.mockResolvedValue([fileEntry("a.md"), fileEntry("b.md")]);
    mockGetFileContent.mockImplementation(async (_token: string, _owner: string, _repo: string, path: string) => {
      if (path.endsWith("b.md")) throw new Error("GitHub get file failed (500): boom");
      return memoryMarkdown("mem-a");
    });

    await expect(loadActiveRepoMemories(input)).rejects.toThrow("GitHub get file failed");
  });

  it("fails closed when the repo-memory root directory lookup returns 404", async () => {
    mockListDirectoryContents.mockRejectedValueOnce(new GitHubRequestError("GitHub list directory", 404, "Not Found"));

    await expect(loadActiveRepoMemories(input)).rejects.toThrow("GitHub list directory failed (404): Not Found");
  });
});
