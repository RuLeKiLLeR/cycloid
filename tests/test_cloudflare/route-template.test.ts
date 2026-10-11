import { describe, expect, it } from "vitest";

import { parsePattern } from "../../apps/control-plane-worker/src/routes/shared";
import { controlPlaneRoutes } from "../../apps/control-plane-worker/src/routes/table";

describe("route templates", () => {
  it("parsePattern preserves the exact route template", () => {
    const pattern = parsePattern("/api/repos/:owner/:repo");

    expect(pattern).toBeInstanceOf(RegExp);
    expect(pattern.routeTemplate).toBe("/api/repos/:owner/:repo");
    expect("/api/repos/trycycloid/cycloid".match(pattern)?.groups).toEqual({
      owner: "trycycloid",
      repo: "cycloid",
    });
  });

  it("keeps every registered control-plane route tied to a parsePattern template", () => {
    for (const route of controlPlaneRoutes) {
      expect(route.pattern.routeTemplate, `${route.method} ${route.pattern}`).toEqual(expect.any(String));
      expect(route.pattern.routeTemplate.length, `${route.method} ${route.pattern}`).toBeGreaterThan(0);

      const reconstructed = parsePattern(route.pattern.routeTemplate);
      expect(reconstructed.source, `${route.method} ${route.pattern.routeTemplate}`).toBe(route.pattern.source);
      expect(reconstructed.flags, `${route.method} ${route.pattern.routeTemplate}`).toBe(route.pattern.flags);
    }
  });
});
