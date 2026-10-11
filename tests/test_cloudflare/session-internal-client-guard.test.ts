import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SOURCE_ROOT = path.join(process.cwd(), "apps/control-plane-worker/src");
const SESSION_DO_INTERNAL_URL_RE = /https:\/\/internal\/session(?=\/|[?"'`])/;

function listTypeScriptFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      files.push(...listTypeScriptFiles(absolutePath));
    } else if (entry.endsWith(".ts")) {
      files.push(absolutePath);
    }
  }

  return files;
}

describe("SessionDO internal client guard", () => {
  it("keeps production SessionDO self-fetch callers behind the typed client", () => {
    const offenders = listTypeScriptFiles(SOURCE_ROOT)
      .map((filePath) => ({
        filePath,
        text: readFileSync(filePath, "utf8"),
      }))
      .filter(({ text }) => SESSION_DO_INTERNAL_URL_RE.test(text))
      .map(({ filePath }) => path.relative(process.cwd(), filePath));

    expect(offenders).toEqual([]);
  });
});
