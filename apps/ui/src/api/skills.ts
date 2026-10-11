import type { SkillMetadata } from "../../../../shared/skills/index";
import { apiCacheKeys, swr } from "./cache";
import { requestJson } from "./client";

const REPO_SKILLS_CACHE_TTL_MS = 60_000;

export async function fetchRepoSkills(owner: string, repo: string): Promise<SkillMetadata[]> {
  const result = await swr(
    apiCacheKeys.repoSkills(owner, repo),
    () =>
      requestJson<{ skills: SkillMetadata[] }>(
        `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/skills`,
        undefined,
        "Failed to fetch skills",
      ).then((data) => data.skills),
    { staleMs: REPO_SKILLS_CACHE_TTL_MS, serveStale: false },
  );
  return result.value;
}
