import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

it("keeps changed-file diff resolution in the shared git diff helper", () => {
  const srcRoot = join(__dirname, "..", "..", "apps", "sandbox-bridge", "src");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !full.endsWith(join("services", "git", "diff.ts"))) {
        const source = readFileSync(full, "utf8");
        if (/\["diff",\s*"--name-only",[^\]]*(?:HEAD|\.\.\.)/.test(source))
          offenders.push(full.replace(srcRoot, "src"));
      }
    }
  };
  walk(srcRoot);
  expect(offenders).toEqual([]);
});
