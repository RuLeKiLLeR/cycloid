import { describe, expect, it } from "vitest";

import {
  buildNeonBranchCredentialConfig,
  parseNeonBranchCredentialConfig,
  serializeNeonBranchCredentialConfig,
} from "../../shared/integrations/neon";

describe("Neon branch credential config", () => {
  it("builds config with projectId only", () => {
    expect(buildNeonBranchCredentialConfig({ projectId: "project-123", parentBranchId: null })).toEqual({
      projectId: "project-123",
    });
  });

  it("builds config with optional parentBranchId", () => {
    expect(
      buildNeonBranchCredentialConfig({
        projectId: "project-123",
        parentBranchId: "br-main",
      }),
    ).toEqual({
      projectId: "project-123",
      parentBranchId: "br-main",
    });
  });

  it("returns null when projectId is missing or blank", () => {
    expect(buildNeonBranchCredentialConfig({ projectId: null, parentBranchId: "br-main" })).toBeNull();
    expect(buildNeonBranchCredentialConfig({ projectId: "   ", parentBranchId: "br-main" })).toBeNull();
  });

  it("round-trips through serialize and parse", () => {
    const config = { projectId: "project-123", parentBranchId: "br-main" };
    expect(parseNeonBranchCredentialConfig(serializeNeonBranchCredentialConfig(config))).toEqual(config);
  });

  it("omits parentBranchId from serialized JSON when unset", () => {
    expect(serializeNeonBranchCredentialConfig({ projectId: "project-123" })).toBe('{"projectId":"project-123"}');
  });

  it("returns null for malformed JSON and non-object payloads", () => {
    expect(parseNeonBranchCredentialConfig("not-json")).toBeNull();
    expect(parseNeonBranchCredentialConfig("[]")).toBeNull();
    expect(parseNeonBranchCredentialConfig('{"parentBranchId":"br-main"}')).toBeNull();
    expect(parseNeonBranchCredentialConfig(null)).toBeNull();
    expect(parseNeonBranchCredentialConfig("")).toBeNull();
  });

  it("ignores non-string projectId and parentBranchId fields", () => {
    expect(parseNeonBranchCredentialConfig(JSON.stringify({ projectId: 123 }))).toBeNull();
    expect(parseNeonBranchCredentialConfig(JSON.stringify({ projectId: "project-123", parentBranchId: 456 }))).toEqual({
      projectId: "project-123",
    });
  });
});
