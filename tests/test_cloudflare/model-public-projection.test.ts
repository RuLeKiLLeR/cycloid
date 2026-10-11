import { describe, expect, it } from "vitest";

import { toBootstrapModelGroup } from "../../apps/control-plane-worker/src/services/bootstrap";
import { PUBLIC_SESSION_START_MODEL_PROVIDER_GROUPS } from "../../shared/constants/models";

const FORBIDDEN_PUBLIC_MODEL_KEYS = new Set([
  "pricing",
  "flex",
  "inputPerMillion",
  "outputPerMillion",
  "cacheReadPerMillion",
  "cacheWritePerMillion",
]);

function collectForbiddenKeys(value: unknown, path = "$"): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => collectForbiddenKeys(item, `${path}[${index}]`));

  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (FORBIDDEN_PUBLIC_MODEL_KEYS.has(key)) found.push(childPath);
    found.push(...collectForbiddenKeys(child, childPath));
  }
  return found;
}

describe("public model projections", () => {
  it("does not expose internal pricing fields in provider group DTOs", () => {
    expect(collectForbiddenKeys(PUBLIC_SESSION_START_MODEL_PROVIDER_GROUPS)).toEqual([]);
  });

  it("does not expose internal pricing fields in bootstrap model serialization", () => {
    const bootstrapGroups = PUBLIC_SESSION_START_MODEL_PROVIDER_GROUPS.map(toBootstrapModelGroup);
    expect(collectForbiddenKeys(bootstrapGroups)).toEqual([]);
  });
});
