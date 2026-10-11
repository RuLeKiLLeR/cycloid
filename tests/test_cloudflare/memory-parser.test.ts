import { describe, expect, it } from "vitest";

import {
  type MemoryFile,
  memoryFilename,
  memoryPathForFile,
  parseMemoryFile,
  serializeMemoryFile,
  shouldIgnoreMemoryPath,
  toRuntimeMemory,
} from "../../shared/memory/parser";

const validMemory = `---
id: mem_20260508_bridge_text_delta_flush
vertical: engineering
memory_type: action
action_type: procedure
level: gotcha
primitive: gotcha
engineering_domains:
  - runtime_behavior
  - data_persistence
subjects:
  - session-replay
symbols:
  - SessionDO
tags:
  - event-ordering
status: active
confidence: high
authority: reviewed
owner: control-plane
applies_to:
  - apps/sandbox-bridge/src/**
  - apps/control-plane-worker/src/session/**
context_hint: When adding bridge event persistence
source_pr_urls:
  - https://github.com/org/repo/pull/42
source_session_ids:
  - sess-xyz
evidence:
  - type: file
    ref: docs/bridge.md
enforcement: warn
triggers:
  tools:
    - apply_patch
  path_globs:
    - apps/sandbox-bridge/src/**
  command_patterns: []
  forbidden_patterns: []
  mcp_tools: []
supersedes: []
contradicts: []
created_at: 2026-05-08
updated_at: 2026-05-08
---

# Flush Text Deltas Before Critical Persistence

When adding a critical persistence handler, flush pending text deltas first.
`;

function parsedValid(): MemoryFile {
  const parsed = parseMemoryFile(validMemory);
  expect(parsed).not.toBeNull();
  return parsed!;
}

describe("memory parser", () => {
  it("parses a valid V2 memory file", () => {
    const result = parsedValid();

    expect(result.id).toBe("mem_20260508_bridge_text_delta_flush");
    expect(result.memory_type).toBe("action");
    expect(result.action_type).toBe("procedure");
    expect(result.level).toBe("gotcha");
    expect(result.engineering_domains).toEqual(["runtime_behavior", "data_persistence"]);
    expect(result.applies_to).toEqual(["apps/sandbox-bridge/src/**", "apps/control-plane-worker/src/session/**"]);
    expect(result.confidence).toBe("high");
    expect(result.authority).toBe("reviewed");
    expect(result.enforcement).toBe("warn");
    expect(result.triggers?.tools).toEqual(["apply_patch"]);
    expect(result.content).toContain("flush pending text deltas");
  });

  it("parses memory files with CRLF line endings", () => {
    const result = parseMemoryFile(validMemory.replace(/\n/g, "\r\n"));

    expect(result).not.toBeNull();
    expect(result?.id).toBe("mem_20260508_bridge_text_delta_flush");
    expect(result?.content).toContain("flush pending text deltas");
  });

  it("returns null for missing frontmatter", () => {
    expect(parseMemoryFile("No frontmatter here")).toBeNull();
  });

  it("returns null for malformed YAML frontmatter", () => {
    expect(parseMemoryFile('---\nid: "unterminated\n---\nbody')).toBeNull();
  });

  it("returns null for missing required fields", () => {
    const noId = validMemory.replace("id: mem_20260508_bridge_text_delta_flush\n", "");
    expect(parseMemoryFile(noId)).toBeNull();
  });

  it("rejects invalid enum values", () => {
    expect(parseMemoryFile(validMemory.replace("confidence: high", "confidence: certain"))).toBeNull();
    expect(
      parseMemoryFile(
        validMemory.replace("engineering_domains:\n  - runtime_behavior", "engineering_domains:\n  - cycloid_only"),
      ),
    ).toBeNull();
  });

  it("requires action_type for action memories", () => {
    expect(parseMemoryFile(validMemory.replace("action_type: procedure\n", ""))).toBeNull();
  });

  it("rejects invalid memory type and primitive combinations", () => {
    expect(parseMemoryFile(validMemory.replace("memory_type: action", "memory_type: factual"))).toBeNull();
  });

  it("requires triggers for warning or blocking enforcement", () => {
    const withoutTriggers = validMemory.replace(
      `triggers:
  tools:
    - apply_patch
  path_globs:
    - apps/sandbox-bridge/src/**
  command_patterns: []
  forbidden_patterns: []
  mcp_tools: []
`,
      "",
    );

    expect(parseMemoryFile(withoutTriggers)).toBeNull();
  });

  it("requires a command or forbidden pattern for blocking enforcement", () => {
    const blockWithOnlyToolAndPath = validMemory.replace("enforcement: warn", "enforcement: block");

    expect(parseMemoryFile(blockWithOnlyToolAndPath)).toBeNull();

    const blockWithCommandPattern = blockWithOnlyToolAndPath.replace(
      "  command_patterns: []",
      '  command_patterns:\n    - "wrangler\\\\s+deploy"',
    );

    expect(parseMemoryFile(blockWithCommandPattern)?.enforcement).toBe("block");
  });
});

describe("memory serializer", () => {
  it("round-trips through parse and serialize with stable field order", () => {
    const serialized = serializeMemoryFile(parsedValid());
    const parsed = parseMemoryFile(serialized);

    expect(parsed).not.toBeNull();
    expect(parsed!.id).toBe("mem_20260508_bridge_text_delta_flush");
    expect(serialized.indexOf("id:")).toBeLessThan(serialized.indexOf("vertical:"));
    expect(serialized.indexOf("vertical:")).toBeLessThan(serialized.indexOf("memory_type:"));
    expect(serialized).toContain("triggers:");
  });
});

describe("toRuntimeMemory", () => {
  it("converts MemoryFile to the runtime ranking shape", () => {
    const runtime = toRuntimeMemory(parsedValid());

    expect(runtime.id).toBe("mem_20260508_bridge_text_delta_flush");
    expect(runtime.memory_type).toBe("action");
    expect(runtime.action_type).toBe("procedure");
    expect(runtime.type).toBe("action");
    expect(runtime.status).toBe("active");
    expect(runtime.confidence).toBe("high");
    expect(runtime.authority).toBe("reviewed");
    expect(runtime.applies_to).toEqual(["apps/sandbox-bridge/src/**", "apps/control-plane-worker/src/session/**"]);
    expect(runtime.subjects).toEqual(["session-replay"]);
    expect(runtime.symbols).toEqual(["SessionDO"]);
    expect(runtime.tags).toEqual(["event-ordering"]);
    expect(runtime.source_pr_urls).toEqual(["https://github.com/org/repo/pull/42"]);
    expect(runtime.source_pr_number).toBe(42);
    expect(runtime.source_session_ids).toEqual(["sess-xyz"]);
    expect(runtime.referenced_files).toBe(JSON.stringify(runtime.applies_to));
  });
});

describe("memory path helpers", () => {
  it("strips mem prefix and adds .md", () => {
    expect(memoryFilename("mem_abc123")).toBe("abc123.md");
  });

  it("places engineering memories in semantic directories", () => {
    expect(memoryPathForFile(parsedValid())).toBe(
      ".cycloid/memory/engineering/gotchas/20260508-bridge-text-delta-flush-flush-text-deltas-before-critical-persistence.md",
    );
  });

  it("keeps index and README files ignored as memory records", () => {
    expect(shouldIgnoreMemoryPath(".cycloid/memory/index.md")).toBe(true);
    expect(shouldIgnoreMemoryPath(".cycloid/memory/engineering/README.md")).toBe(true);
    expect(shouldIgnoreMemoryPath(".cycloid/memory/engineering/gotchas/mem-1.md")).toBe(false);
  });
});
