import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getValidGithubToken: vi.fn(),
  tracedFetch: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/auth/db", () => ({
  getValidGithubToken: (...args: unknown[]) => mocks.getValidGithubToken(...args),
}));

vi.mock("../../apps/control-plane-worker/src/observability/wrappers", () => ({
  tracedFetch: (...args: unknown[]) => mocks.tracedFetch(...args),
}));

import { fetchRepoSkills, resetRepoSkillsMemoryCache } from "../../apps/control-plane-worker/src/github/skills";

function createEnv(): Parameters<typeof fetchRepoSkills>[0] {
  const kv = new Map<string, string>();
  return {
    DB: {},
    TOKEN_ENCRYPTION_KEY: "test-encryption-key",
    REPOS_CACHE: {
      get: vi.fn(async (key: string, type?: string) => {
        const value = kv.get(key) ?? null;
        return type === "json" && value ? JSON.parse(value) : value;
      }),
      put: vi.fn(async (key: string, value: string) => {
        kv.set(key, value);
      }),
    },
  } as unknown as Parameters<typeof fetchRepoSkills>[0];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function skillFile(raw: string): Response {
  return jsonResponse({
    content: Buffer.from(raw, "utf-8").toString("base64"),
    encoding: "base64",
  });
}

function treeResponse(paths: Array<{ path: string; sha: string }>, truncated = false): Response {
  return jsonResponse({
    truncated,
    tree: paths.map(({ path, sha }) => ({ path, sha, type: "blob" })),
  });
}

function skillMarkdown(name: string, description: string, body = "# Skill", argument?: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n${argument ? `argument: ${argument}\n` : ""}---\n\n${body}\n`;
}

describe("fetchRepoSkills", () => {
  let env: Parameters<typeof fetchRepoSkills>[0];

  beforeEach(() => {
    vi.clearAllMocks();
    resetRepoSkillsMemoryCache();
    env = createEnv();
    mocks.getValidGithubToken.mockResolvedValue("github-token");
  });

  it("returns Claude and Codex skills, preferring Claude on duplicate names", async () => {
    mocks.tracedFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/git/trees/HEAD?recursive=1")) {
        return treeResponse([
          { path: ".claude/skills/shared/SKILL.md", sha: "sha-claude-shared" },
          { path: ".claude/skills/claude-only/SKILL.md", sha: "sha-claude-only" },
          { path: ".claude/skills/nested/docs/SKILL.md", sha: "sha-nested" },
          { path: ".claude/skills/not-a-skill/README.md", sha: "sha-readme" },
          { path: ".agents/skills/shared/SKILL.md", sha: "sha-agents-shared" },
          { path: ".agents/skills/codex-only/SKILL.md", sha: "sha-codex-only" },
        ]);
      }
      if (url.endsWith("/git/blobs/sha-claude-shared")) {
        return skillFile(skillMarkdown("shared", "Claude shared skill", "# Claude Shared"));
      }
      if (url.endsWith("/git/blobs/sha-agents-shared")) {
        return skillFile(skillMarkdown("shared", "Codex shared skill", "# Codex Shared"));
      }
      if (url.endsWith("/git/blobs/sha-claude-only")) {
        return skillFile(skillMarkdown("claude-only", "Claude-only skill"));
      }
      if (url.endsWith("/git/blobs/sha-codex-only")) {
        return skillFile(skillMarkdown("codex-only", "Codex-only skill"));
      }
      return jsonResponse({}, 404);
    });

    const skills = await fetchRepoSkills(env, "user-1", "owner", "repo");

    expect(skills).toEqual([
      {
        name: "shared",
        description: "Claude shared skill",
        content: "# Claude Shared",
        path: ".claude/skills/shared/SKILL.md",
      },
      {
        name: "claude-only",
        description: "Claude-only skill",
        content: "# Skill",
        path: ".claude/skills/claude-only/SKILL.md",
      },
      {
        name: "codex-only",
        description: "Codex-only skill",
        content: "# Skill",
        path: ".agents/skills/codex-only/SKILL.md",
      },
    ]);
    expect(mocks.tracedFetch).toHaveBeenCalledTimes(5);
    expect(mocks.tracedFetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.github.com/repos/owner/repo/git/trees/HEAD?recursive=1",
      "https://api.github.com/repos/owner/repo/git/blobs/sha-claude-shared",
      "https://api.github.com/repos/owner/repo/git/blobs/sha-claude-only",
      "https://api.github.com/repos/owner/repo/git/blobs/sha-agents-shared",
      "https://api.github.com/repos/owner/repo/git/blobs/sha-codex-only",
    ]);
    expect(mocks.tracedFetch.mock.calls.some(([url]) => String(url).includes("/contents/"))).toBe(false);
  });

  it("returns an empty list when neither skill root exists", async () => {
    mocks.tracedFetch.mockResolvedValue(treeResponse([]));

    const skills = await fetchRepoSkills(env, "user-1", "owner", "repo");

    expect(skills).toEqual([]);
    expect(mocks.getValidGithubToken).toHaveBeenCalledWith(env.DB, "user-1", env);
    expect(mocks.tracedFetch).toHaveBeenCalledTimes(1);
  });

  it("returns skill argument metadata", async () => {
    mocks.tracedFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/git/trees/HEAD?recursive=1")) {
        return treeResponse([{ path: ".claude/skills/verify-pr-before-merge/SKILL.md", sha: "sha-verify" }]);
      }
      if (url.endsWith("/git/blobs/sha-verify")) {
        return skillFile(skillMarkdown("verify-pr-before-merge", "Verify PR", "# Verify", "PR URL or number"));
      }
      return jsonResponse({}, 404);
    });

    const skills = await fetchRepoSkills(env, "user-1", "owner", "repo");

    expect(skills).toEqual([
      {
        name: "verify-pr-before-merge",
        description: "Verify PR",
        argument: "PR URL or number",
        content: "# Verify",
        path: ".claude/skills/verify-pr-before-merge/SKILL.md",
      },
    ]);
  });

  it("decodes GitHub base64 skill content as UTF-8 text", async () => {
    mocks.tracedFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/git/trees/HEAD?recursive=1")) {
        return treeResponse([{ path: ".claude/skills/utf8/SKILL.md", sha: "sha-utf8" }]);
      }
      if (url.endsWith("/git/blobs/sha-utf8")) {
        return skillFile(skillMarkdown("utf8", "Résumé skill", "# Café\n\nnaïve"));
      }
      return jsonResponse({}, 404);
    });

    const skills = await fetchRepoSkills(env, "user-1", "owner", "repo");

    expect(skills).toEqual([
      {
        name: "utf8",
        description: "Résumé skill",
        content: "# Café\n\nnaïve",
        path: ".claude/skills/utf8/SKILL.md",
      },
    ]);
  });

  it("serves repeated lookups from cache", async () => {
    mocks.tracedFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/git/trees/HEAD?recursive=1")) {
        return treeResponse([{ path: ".claude/skills/review-spec/SKILL.md", sha: "sha-review-spec" }]);
      }
      if (url.endsWith("/git/blobs/sha-review-spec")) {
        return skillFile(skillMarkdown("review-spec", "Review a spec"));
      }
      return jsonResponse({}, 404);
    });

    await expect(fetchRepoSkills(env, "user-1", "owner", "repo")).resolves.toHaveLength(1);
    await expect(fetchRepoSkills(env, "user-1", "owner", "repo")).resolves.toHaveLength(1);

    expect(mocks.getValidGithubToken).toHaveBeenCalledTimes(1);
    expect(mocks.tracedFetch).toHaveBeenCalledTimes(2);
  });

  it("falls back to Contents API discovery when one matched blob request fails", async () => {
    mocks.tracedFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/git/trees/HEAD?recursive=1")) {
        return treeResponse([
          { path: ".claude/skills/claude-only/SKILL.md", sha: "sha-claude-only" },
          { path: ".agents/skills/codex-only/SKILL.md", sha: "sha-codex-only" },
        ]);
      }
      if (url.endsWith("/git/blobs/sha-codex-only")) {
        throw new Error("GitHub API failed");
      }
      if (url.endsWith("/git/blobs/sha-claude-only")) {
        return skillFile(skillMarkdown("claude-only", "Claude-only skill"));
      }
      if (url.endsWith("/contents/.claude/skills")) {
        return jsonResponse([{ name: "claude-only", type: "dir" }]);
      }
      if (url.endsWith("/contents/.agents/skills")) {
        return jsonResponse([{ name: "codex-only", type: "dir" }]);
      }
      if (url.endsWith("/contents/.claude/skills/claude-only/SKILL.md")) {
        return skillFile(skillMarkdown("claude-only", "Claude-only skill"));
      }
      if (url.endsWith("/contents/.agents/skills/codex-only/SKILL.md")) {
        return skillFile(skillMarkdown("codex-only", "Codex-only skill"));
      }
      return jsonResponse({}, 404);
    });

    const skills = await fetchRepoSkills(env, "user-1", "owner", "repo");

    expect(skills).toEqual([
      {
        name: "claude-only",
        description: "Claude-only skill",
        content: "# Skill",
        path: ".claude/skills/claude-only/SKILL.md",
      },
      {
        name: "codex-only",
        description: "Codex-only skill",
        content: "# Skill",
        path: ".agents/skills/codex-only/SKILL.md",
      },
    ]);
  });

  it("falls back to Contents API discovery when every matched blob request fails", async () => {
    mocks.tracedFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/git/trees/HEAD?recursive=1")) {
        return treeResponse([
          { path: ".claude/skills/review-spec/SKILL.md", sha: "sha-review-spec" },
          { path: ".agents/skills/audit-docs/SKILL.md", sha: "sha-audit-docs" },
        ]);
      }
      if (url.endsWith("/git/blobs/sha-review-spec") || url.endsWith("/git/blobs/sha-audit-docs")) {
        throw new Error("GitHub blob API failed");
      }
      if (url.endsWith("/contents/.claude/skills")) {
        return jsonResponse([{ name: "review-spec", type: "dir" }]);
      }
      if (url.endsWith("/contents/.agents/skills")) {
        return jsonResponse([]);
      }
      if (url.endsWith("/contents/.claude/skills/review-spec/SKILL.md")) {
        return skillFile(skillMarkdown("review-spec", "Review a spec"));
      }
      return jsonResponse({}, 404);
    });

    const skills = await fetchRepoSkills(env, "user-1", "owner", "repo");

    expect(skills).toEqual([
      {
        name: "review-spec",
        description: "Review a spec",
        content: "# Skill",
        path: ".claude/skills/review-spec/SKILL.md",
      },
    ]);
    expect(mocks.tracedFetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.github.com/repos/owner/repo/git/trees/HEAD?recursive=1",
      "https://api.github.com/repos/owner/repo/git/blobs/sha-review-spec",
      "https://api.github.com/repos/owner/repo/git/blobs/sha-audit-docs",
      "https://api.github.com/repos/owner/repo/contents/.claude/skills",
      "https://api.github.com/repos/owner/repo/contents/.agents/skills",
      "https://api.github.com/repos/owner/repo/contents/.claude/skills/review-spec/SKILL.md",
    ]);
  });

  it("falls back to Contents API skill discovery when the recursive tree is truncated", async () => {
    mocks.tracedFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/git/trees/HEAD?recursive=1")) {
        return treeResponse([{ path: ".claude/skills/missed/SKILL.md", sha: "sha-missed" }], true);
      }
      if (url.endsWith("/contents/.claude/skills")) {
        return jsonResponse([{ name: "review-spec", type: "dir" }]);
      }
      if (url.endsWith("/contents/.agents/skills")) {
        return jsonResponse([]);
      }
      if (url.endsWith("/contents/.claude/skills/review-spec/SKILL.md")) {
        return skillFile(skillMarkdown("review-spec", "Review a spec"));
      }
      return jsonResponse({}, 404);
    });

    const skills = await fetchRepoSkills(env, "user-1", "owner", "repo");

    expect(skills).toEqual([
      {
        name: "review-spec",
        description: "Review a spec",
        content: "# Skill",
        path: ".claude/skills/review-spec/SKILL.md",
      },
    ]);
    expect(mocks.tracedFetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.github.com/repos/owner/repo/git/trees/HEAD?recursive=1",
      "https://api.github.com/repos/owner/repo/contents/.claude/skills",
      "https://api.github.com/repos/owner/repo/contents/.agents/skills",
      "https://api.github.com/repos/owner/repo/contents/.claude/skills/review-spec/SKILL.md",
    ]);
  });

  it("throws and does not cache when every skill root request fails", async () => {
    mocks.tracedFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/git/trees/HEAD?recursive=1") || url.includes("/contents/")) {
        throw new Error("GitHub API failed");
      }
      return jsonResponse({}, 404);
    });

    await expect(fetchRepoSkills(env, "user-1", "owner", "repo")).rejects.toThrow(
      "GitHub skill discovery failed for all configured roots",
    );

    const cachePut = env.REPOS_CACHE.put as unknown as ReturnType<typeof vi.fn>;
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("does not query GitHub without a connected user token", async () => {
    mocks.getValidGithubToken.mockResolvedValue(null);

    const skills = await fetchRepoSkills(env, "user-1", "owner", "repo");

    expect(skills).toEqual([]);
    expect(mocks.tracedFetch).not.toHaveBeenCalled();
  });
});
