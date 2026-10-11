import { parseSkillMarkdown, SKILL_ROOTS, type SkillInfo } from "../../../../shared/skills/index.js";
import { getValidGithubToken } from "../auth/db";
import { createBoundedTtlMemoryCache } from "../bounded-memory-cache";
import { tracedFetch } from "../observability/wrappers";
import type { Env } from "../types";
import { mapBounded } from "../utils";
import { GITHUB_API, githubHeaders } from "./pr";
import { fetchRepoTreeEntries, type GithubTreeEntry } from "./tree";

const SKILLS_CACHE_SCHEMA_VERSION = 1;
const SKILLS_CACHE_TTL_SECONDS = 300;
const SKILLS_MEMORY_CACHE_MAX_ENTRIES = 500;
const SKILLS_MEMORY_TTL_MS = 60_000;
const DEFAULT_TREE_REF = "HEAD";
const SKILL_BLOB_FETCH_CONCURRENCY = 10;

type SkillsCacheEntry = {
  schemaVersion: number;
  skills: SkillInfo[];
};

const skillsMemoryCache = createBoundedTtlMemoryCache<string, SkillsCacheEntry>(SKILLS_MEMORY_CACHE_MAX_ENTRIES);

function githubContentsUrl(owner: string, repo: string, path: string): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`;
}

function githubBlobUrl(owner: string, repo: string, sha: string): string {
  return `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(sha)}`;
}

function getSkillsCacheKey(userId: string, owner: string, repo: string): string {
  return `repo-skills:v${SKILLS_CACHE_SCHEMA_VERSION}:${userId}:${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

function isUsableSkillsCacheEntry(entry: SkillsCacheEntry | null | undefined): entry is SkillsCacheEntry {
  return Boolean(entry && entry.schemaVersion === SKILLS_CACHE_SCHEMA_VERSION && Array.isArray(entry.skills));
}

async function getCachedSkills(env: Env, cacheKey: string): Promise<SkillsCacheEntry | null> {
  try {
    return (await env.REPOS_CACHE.get(cacheKey, "json")) as SkillsCacheEntry | null;
  } catch {
    return null;
  }
}

async function putCachedSkills(env: Env, cacheKey: string, skills: SkillInfo[]): Promise<void> {
  const entry = { schemaVersion: SKILLS_CACHE_SCHEMA_VERSION, skills };
  skillsMemoryCache.set(cacheKey, entry, SKILLS_MEMORY_TTL_MS);
  try {
    await env.REPOS_CACHE.put(cacheKey, JSON.stringify(entry), { expirationTtl: SKILLS_CACHE_TTL_SECONDS });
  } catch {
    // Cache failures should not block skill discovery.
  }
}

export function resetRepoSkillsMemoryCache(): void {
  skillsMemoryCache.clear();
}

function decodeBase64Content(content: string): string {
  const bytes = Uint8Array.from(atob(content.replace(/\n/g, "")), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function parseSkillPath(path: string): { root: string; dirName: string } | null {
  for (const root of SKILL_ROOTS) {
    const prefix = `${root}/`;
    if (!path.startsWith(prefix)) continue;

    const remainder = path.slice(prefix.length);
    const parts = remainder.split("/");
    if (parts.length !== 2 || parts[1] !== "SKILL.md" || parts[0].length === 0) return null;
    return { root, dirName: parts[0] };
  }
  return null;
}

function skillFromRawMarkdown(raw: string, dirName: string, path: string): SkillInfo {
  const parsed = parseSkillMarkdown(raw);
  return {
    name: parsed.name || dirName,
    description: parsed.description,
    ...(parsed.argument ? { argument: parsed.argument } : {}),
    content: parsed.content,
    path,
  };
}

async function fetchRepoSkillRoot(token: string, owner: string, repo: string, root: string): Promise<SkillInfo[]> {
  const dirRes = await tracedFetch(
    githubContentsUrl(owner, repo, root),
    { headers: githubHeaders(token) },
    "github.skillsDir",
  );
  if (!dirRes.ok) return [];

  const entries = (await dirRes.json()) as Array<{ name: string; type: string }>;
  const dirs = entries.filter((e) => e.type === "dir");
  if (dirs.length === 0) return [];

  const results = await Promise.allSettled(
    dirs.map(async (dir) => {
      const fileRes = await tracedFetch(
        githubContentsUrl(owner, repo, `${root}/${dir.name}/SKILL.md`),
        { headers: githubHeaders(token) },
        "github.skillFile",
      );
      if (!fileRes.ok) return null;

      const file = (await fileRes.json()) as { content?: string; encoding?: string };
      if (!file.content || file.encoding !== "base64") return null;

      return skillFromRawMarkdown(decodeBase64Content(file.content), dir.name, `${root}/${dir.name}/SKILL.md`);
    }),
  );

  const skills: SkillInfo[] = [];
  for (const result of results) {
    if (result.status !== "fulfilled" || result.value === null) continue;
    skills.push(result.value);
  }
  return skills;
}

async function fetchSkillBlob(
  token: string,
  owner: string,
  repo: string,
  entry: GithubTreeEntry,
  dirName: string,
): Promise<SkillInfo | null> {
  if (!entry.sha) return null;

  const fileRes = await tracedFetch(
    githubBlobUrl(owner, repo, entry.sha),
    { headers: githubHeaders(token) },
    "github.skillBlob",
  );
  if (!fileRes.ok) return null;

  const file = (await fileRes.json()) as { content?: string; encoding?: string };
  if (!file.content || file.encoding !== "base64") return null;

  return skillFromRawMarkdown(decodeBase64Content(file.content), dirName, entry.path);
}

async function fetchRepoSkillsFromTree(token: string, owner: string, repo: string): Promise<SkillInfo[] | null> {
  const data = await fetchRepoTreeEntries(token, owner, repo, DEFAULT_TREE_REF);
  if (data.truncated) return null;

  const matchedEntries = data.tree
    .filter((entry) => entry.type === "blob")
    .map((entry) => ({ entry, parsedPath: parseSkillPath(entry.path) }))
    .filter((item): item is { entry: GithubTreeEntry; parsedPath: { root: string; dirName: string } } =>
      Boolean(item.parsedPath),
    );
  if (matchedEntries.length === 0) return [];

  const skillsByPath = await mapBounded(matchedEntries, SKILL_BLOB_FETCH_CONCURRENCY, async ({ entry, parsedPath }) => {
    let skill: SkillInfo | null = null;
    try {
      skill = await fetchSkillBlob(token, owner, repo, entry, parsedPath.dirName);
    } catch {
      skill = null;
    }
    return { root: parsedPath.root, skill };
  });
  if (skillsByPath.some((result) => result.skill === null)) return null;

  const skills = SKILL_ROOTS.flatMap((root) =>
    skillsByPath.flatMap((result) => (result.root === root && result.skill !== null ? [result.skill] : [])),
  );
  return skills;
}

async function fetchRepoSkillsFromContentsFallback(token: string, owner: string, repo: string): Promise<SkillInfo[]> {
  const skillLists = await Promise.allSettled(SKILL_ROOTS.map((root) => fetchRepoSkillRoot(token, owner, repo, root)));
  if (!skillLists.some((result) => result.status === "fulfilled")) {
    throw new Error("GitHub skill discovery failed for all configured roots");
  }
  return skillLists.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
}

/** Fetch configured agent skills in a GitHub repo. Returns an empty array if no skill root exists. */
export async function fetchRepoSkills(env: Env, userId: string, owner: string, repo: string): Promise<SkillInfo[]> {
  const cacheKey = getSkillsCacheKey(userId, owner, repo);
  const now = Date.now();
  const memoryCached = skillsMemoryCache.get(cacheKey, now);
  if (isUsableSkillsCacheEntry(memoryCached)) {
    return memoryCached.skills;
  }

  const kvCached = await getCachedSkills(env, cacheKey);
  if (isUsableSkillsCacheEntry(kvCached)) {
    skillsMemoryCache.set(cacheKey, kvCached, SKILLS_MEMORY_TTL_MS, now);
    return kvCached.skills;
  }

  const token = await getValidGithubToken(env.DB, userId, env);
  if (!token) return [];

  const byName = new Map<string, SkillInfo>();
  let discoveredSkills: SkillInfo[] | null;
  try {
    discoveredSkills = await fetchRepoSkillsFromTree(token, owner, repo);
  } catch {
    discoveredSkills = null;
  }
  discoveredSkills ??= await fetchRepoSkillsFromContentsFallback(token, owner, repo);
  for (const skill of discoveredSkills) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }

  const skills = Array.from(byName.values());
  await putCachedSkills(env, cacheKey, skills);
  return skills;
}
