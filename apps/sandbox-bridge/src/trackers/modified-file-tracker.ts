import path from "node:path";

/**
 * Tracks files modified by edit tools for targeted git staging and readiness
 * evidence.
 */
export class ModifiedFileTracker {
  readonly modifiedFiles = new Set<string>();

  recordModifiedFile(filePath: string): void {
    this.modifiedFiles.add(path.resolve(filePath));
  }

  recordModifiedFiles(filePaths: Iterable<string>): void {
    for (const filePath of filePaths) {
      this.recordModifiedFile(filePath);
    }
  }
}

/**
 * Extract all file paths from an apply_patch input string.
 * Parses the patch grammar directives: `*** Update File:`, `*** Add File:`,
 * `*** Delete File:`, and `*** Move to:`.
 */
export function extractApplyPatchPaths(patch: string): string[] {
  return [...patch.matchAll(/^\*{3}\s+(?:Update File|Add File|Delete File|Move to):\s*(.+)$/gm)]
    .map((m) => m[1].trim())
    .filter(Boolean);
}
