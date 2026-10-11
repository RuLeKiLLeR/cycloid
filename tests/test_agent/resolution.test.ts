import { describe, expect, it } from "vitest";

import {
  AgentConfigError,
  resolveAgents,
  sanitizeResolvedAgents,
} from "../../apps/control-plane-worker/src/agent/resolution.js";
import type { AgentConfig } from "../../shared/agent/schema.js";

const BASE: Record<string, AgentConfig> = {
  build: {
    name: "build",
    description: "Primary agent",
    mode: "primary",
  },
  review: {
    name: "review",
    description: "Reviewer",
    mode: "primary",
  },
};

describe("resolveAgents", () => {
  it("returns copies of built-in agents when no overrides", () => {
    const result = resolveAgents(BASE);
    expect(result).toEqual(BASE);
    // Verify it's a copy, not the same reference
    expect(result.build).not.toBe(BASE.build);
  });

  it("overrides public metadata from repo config", () => {
    const result = resolveAgents(BASE, {
      build: { description: "Default coding agent" },
    });
    expect(result.build.description).toBe("Default coding agent");
    expect(result.build.mode).toBe("primary");
  });

  it("ignores stale behavior config keys from repo config", () => {
    const repoAgents = {
      build: {
        description: "Default coding agent",
        prompt: "legacy prompt",
        temperature: 0.5,
        steps: 10,
        tools: { bash: false },
        permissions: { bash: "deny" },
        outputLimits: { maxBytes: 1024 },
        options: { legacy: true },
      },
      reviewer: {
        prompt: "legacy prompt",
        steps: 1,
      },
    } as unknown as Record<string, Partial<AgentConfig>>;

    const result = resolveAgents(BASE, repoAgents);

    expect(result.build).toStrictEqual({
      name: "build",
      description: "Default coding agent",
      mode: "primary",
    });
    expect(result.reviewer).toStrictEqual({
      name: "reviewer",
      description: "reviewer",
      mode: "primary",
    });
  });

  it("creates new primary agents from repo config", () => {
    const result = resolveAgents(BASE, {
      reviewer: { description: "Code reviewer", mode: "primary" },
    });
    expect(result.reviewer).toBeDefined();
    expect(result.reviewer.name).toBe("reviewer");
    expect(result.reviewer.description).toBe("Code reviewer");
    expect(result.reviewer.mode).toBe("primary");
  });

  it("new agent defaults to primary mode and name as description", () => {
    const result = resolveAgents(BASE, {
      minimal: {},
    });
    expect(result.minimal.name).toBe("minimal");
    expect(result.minimal.description).toBe("minimal");
    expect(result.minimal.mode).toBe("primary");
  });

  it("rejects non-primary repo agent overrides", () => {
    expect(() =>
      resolveAgents(BASE, {
        reviewer: { description: "Code reviewer", mode: "internal" },
      }),
    ).toThrow(AgentConfigError);
  });

  it("allows legacy helper names as public metadata-only repo agents", () => {
    const result = resolveAgents(BASE, {
      compaction: { description: "Compaction metadata", mode: "primary" },
      title: { description: "Title metadata", mode: "primary" },
    });

    expect(result.compaction).toStrictEqual({
      name: "compaction",
      description: "Compaction metadata",
      mode: "primary",
    });
    expect(result.title).toStrictEqual({
      name: "title",
      description: "Title metadata",
      mode: "primary",
    });
  });

  it("sanitizes resolved agent rows to primary agents", () => {
    const result = sanitizeResolvedAgents({
      build: BASE.build,
      oldExplore: {
        name: "oldExplore",
        description: "Explorer",
        mode: "subagent",
      } as unknown as AgentConfig,
      legacyInternal: { name: "legacyInternal", description: "Internal", mode: "internal" },
    });

    expect(Object.keys(result ?? {})).toEqual(["build"]);
  });

  it("returns null when every resolved agent row is stale", () => {
    const result = sanitizeResolvedAgents({
      oldExplore: {
        name: "oldExplore",
        description: "Explorer",
        mode: "subagent",
      } as unknown as AgentConfig,
      legacyInternal: { name: "legacyInternal", description: "Internal", mode: "internal" },
    });

    expect(result).toBeNull();
  });

  it("does not modify the original built-in agents", () => {
    const original = { ...BASE.build };
    resolveAgents(BASE, { build: { description: "Updated" } });
    expect(BASE.build).toEqual(original);
  });
});
