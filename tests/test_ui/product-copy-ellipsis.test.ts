import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const COPY_FILES = [
  "apps/ui/src/components/Layout.tsx",
  "apps/ui/src/components/Transcript.tsx",
  "apps/ui/src/pages/SupportViewAdminPage.tsx",
  "apps/ui/src/components/settings/sandboxLayerShared.ts",
];

describe("product copy ellipses", () => {
  it("uses the ellipsis glyph in the audited user-facing strings", () => {
    for (const path of COPY_FILES) {
      const source = readFileSync(join(process.cwd(), path), "utf8");
      expect(source, path).not.toMatch(
        /(?:Loading models|Starting|Loading customers|Searching|Debugging customer session|Retrying provider|slice\(0, 12\)}`)\.\.\./,
      );
    }
  });
});
