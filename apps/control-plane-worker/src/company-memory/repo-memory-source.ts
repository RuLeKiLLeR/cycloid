import {
  MEMORY_ROOT_DIR,
  type MemoryFile,
  parseMemoryFile,
  shouldIgnoreMemoryPath,
} from "../../../../shared/memory/parser";
import { getFileContent, listDirectoryContents } from "../memory/github";
import { mapBounded } from "../utils";

const MAX_REPO_MEMORY_FILES = 100;
const CONTENT_FETCH_CONCURRENCY = 10;

export interface RepoMemoryRecord {
  id: string;
  owner: string;
  repo: string;
  path: string;
  status: MemoryFile["status"];
  claim: string;
  sourceTimeMs: number;
  sourceUri: string;
}

export async function loadActiveRepoMemories(input: {
  token: string;
  owner: string;
  repo: string;
  ref: string;
  limit?: number;
}): Promise<RepoMemoryRecord[]> {
  const files = await listMemoryMarkdownFiles(
    input.token,
    input.owner,
    input.repo,
    MEMORY_ROOT_DIR,
    input.ref,
    input.limit,
  );
  // Transient GitHub errors reject the whole load (fail closed, matching
  // getFileContent's contract); missing files resolve null and are skipped.
  const contents = await mapBounded(files, CONTENT_FETCH_CONCURRENCY, (file) =>
    getFileContent(input.token, input.owner, input.repo, file.path, input.ref),
  );
  const records: RepoMemoryRecord[] = [];
  const seenIds = new Set<string>();
  for (const [index, file] of files.entries()) {
    const content = contents[index];
    if (!content) continue;
    const parsed = parseMemoryFile(content);
    if (!parsed || seenIds.has(parsed.id) || parsed.status !== "active") continue;
    seenIds.add(parsed.id);
    records.push({
      id: parsed.id,
      owner: input.owner,
      repo: input.repo,
      path: file.path,
      status: parsed.status,
      claim: buildRepoMemoryClaim(parsed),
      sourceTimeMs: memorySourceTimeMs(parsed),
      sourceUri: `github://${input.owner}/${input.repo}/${file.path}`,
    });
  }
  return records;
}

async function listMemoryMarkdownFiles(
  token: string,
  owner: string,
  repo: string,
  dirPath: string,
  ref: string,
  limit = MAX_REPO_MEMORY_FILES,
  isRoot = true,
): Promise<Array<{ name: string; path: string; sha: string; type: "file" | "dir" }>> {
  const safeLimit = Math.max(1, Math.min(MAX_REPO_MEMORY_FILES, Math.floor(limit)));
  const entries = await listDirectoryContents(token, owner, repo, dirPath, ref, { allowNotFound: !isRoot });
  const files: Array<{ name: string; path: string; sha: string; type: "file" | "dir" }> = [];
  for (const entry of entries) {
    if (files.length >= safeLimit) break;
    if (entry.type === "dir") {
      files.push(
        ...(await listMemoryMarkdownFiles(token, owner, repo, entry.path, ref, safeLimit - files.length, false)),
      );
      continue;
    }
    if (entry.name.endsWith(".md") && !shouldIgnoreMemoryPath(entry.path)) {
      files.push(entry);
    }
  }
  return files.slice(0, safeLimit);
}

function buildRepoMemoryClaim(memory: MemoryFile): string {
  return [memory.context_hint, memory.content]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 1_500);
}

function memorySourceTimeMs(memory: MemoryFile): number {
  const updated = Date.parse(memory.updated_at);
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(memory.created_at);
  return Number.isFinite(created) ? created : 0;
}
