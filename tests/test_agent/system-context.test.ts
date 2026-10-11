import { afterEach, describe, expect, it, vi } from "vitest";

import { buildSessionStaticBehavioralGuidance } from "../../apps/sandbox-bridge/src/constants/bridge.js";
import {
  formatDiagnosticsReminder,
  measureSystemContextSections,
} from "../../apps/sandbox-bridge/src/utils/system-context.js";
import { estimateTokens } from "../../apps/sandbox-bridge/src/utils/tokens.js";
import type { DiagnosticEntry } from "../../shared/types/sandbox.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

function makeDiagnostic(index: number, message = `message-${index}`): DiagnosticEntry {
  return {
    file: `src/file-${index}.ts`,
    line: index + 1,
    column: 1,
    severity: "error",
    message,
    source: "typescript",
  };
}

describe("formatDiagnosticsReminder", () => {
  it("includes all diagnostics when they fit within the token budget", () => {
    const result = formatDiagnosticsReminder([makeDiagnostic(0), makeDiagnostic(1)], 10_000);

    expect(result).toContain("# Diagnostic Errors From Previous Turn");
    expect(result).toContain("src/file-0.ts(1,1): error");
    expect(result).toContain("src/file-1.ts(2,1): error");
    expect(result).not.toContain("more errors omitted");
  });

  it("keeps newest diagnostics and reports omitted older diagnostics when the token budget is tight", () => {
    const diagnostics = Array.from({ length: 8 }, (_, index) =>
      makeDiagnostic(index, `diagnostic-${index} ${"x".repeat(24)}`),
    );
    const result = formatDiagnosticsReminder(diagnostics, 65);

    expect(estimateTokens(result)).toBeLessThanOrEqual(65);
    expect(result).toContain("src/file-6.ts(7,1): error");
    expect(result).toContain("src/file-7.ts(8,1): error");
    expect(result).toContain("[6 more errors omitted]");
  });

  it("returns an empty reminder when no diagnostics section can fit", () => {
    expect(formatDiagnosticsReminder([makeDiagnostic(0)], 1)).toBe("");
  });
});

describe("measureSystemContextSections", () => {
  it("reconciles per-section token estimates with the rendered payload", () => {
    const measured = measureSystemContextSections([
      {
        name: "diagnostics_reminder",
        content: "# Diagnostic Errors From Previous Turn\n\nFix these errors before continuing with new work.",
        promptPhase: "initial",
        cadence: "conditional",
      },
      {
        name: "memory_section",
        content: "# Memories\n\nNote A",
        promptPhase: "initial",
        cadence: "conditional",
      },
    ]);

    expect(measured.totalTokenCountEstimate).toBe(estimateTokens(measured.text!));
    expect(measured.sections.reduce((sum, section) => sum + section.tokenCountEstimate, 0)).toBe(
      measured.totalTokenCountEstimate,
    );
  });

  it("returns empty measurement for empty input", () => {
    const measured = measureSystemContextSections([]);
    expect(measured.text).toBeUndefined();
    expect(measured.sections).toEqual([]);
    expect(measured.totalTokenCountEstimate).toBe(0);
  });
});

describe("buildSessionStaticBehavioralGuidance (AGENTS.md contents)", () => {
  it("includes durable Cycloid rules", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    expect(guidance).toContain("# Sandbox environment");
    expect(guidance).toContain("# Investigation and checks");
    expect(guidance).toContain("# Task completion");
    expect(guidance).toContain("# Git restrictions");
  });

  it("includes Linked repo guidance and Validation before commit by default", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    expect(guidance).toContain("# Linked repo guidance");
    expect(guidance).toContain("# Validation before commit");
    expect(guidance).toContain("Agent response accuracy is part of the deliverable");
  });

  it("tells the agent to match local conventions (file-scoped rules, placement, build-file idioms)", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    expect(guidance).toContain("# Match local conventions");
    expect(guidance).toContain("Read the file-scoped rule first");
    expect(guidance).toContain("globs:");
    expect(guidance).toContain("invoke tools the way sibling entries already do");
    expect(guidance).toContain("dominant existing pattern");
  });

  it("forcefully forbids standing up a test runner to satisfy an explicit test request on a harness-less surface", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    expect(guidance).toContain("# Tests");
    expect(guidance).toContain("even when the task explicitly says to add a unit test");
    expect(guidance).toContain("Do not install jest/vitest");
    expect(guidance).toContain("a test was skipped because the surface has no test harness");
  });

  it("excludes the implementation-only conventions and test sections from verification (QA) sessions", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "verification" });
    expect(guidance).not.toContain("# Match local conventions");
    expect(guidance).not.toContain("# Tests");
  });

  it("omits the dynamic-tools section when no dynamic tools are available", () => {
    const guidance = buildSessionStaticBehavioralGuidance({ agentRole: "implementation" });
    expect(guidance).not.toContain("# First-party dynamic tools");
    expect(guidance).not.toContain("# Memory recall");
  });

  it("emits the dynamic-tools section when dynamic tools are available", () => {
    const guidance = buildSessionStaticBehavioralGuidance({
      agentRole: "implementation",
      dynamicToolNames: new Set(["linear.get_issue", "datadog.search_datadog_logs"]),
    });
    expect(guidance).toContain("# First-party dynamic tools");
    expect(guidance).toContain("- `datadog.search_datadog_logs`");
    expect(guidance).toContain("- `linear.get_issue`");
  });

  it("frames the dynamic tool as the intended interface, not a degraded raw-API subset", () => {
    const guidance = buildSessionStaticBehavioralGuidance({
      agentRole: "implementation",
      dynamicToolNames: new Set(["datadog.search_datadog_logs"]),
    });
    // The tool is the full surface for the integration.
    expect(guidance).toContain("it is the intended interface to that integration");
    expect(guidance).toContain("not a degraded subset of some richer raw-API access");
    expect(guidance).toContain("treat first-party tools as authoritative integration surfaces");
    expect(guidance).toContain("other local evidence may still be useful for surrounding context");
    expect(guidance).not.toContain("call it before using `bash`");
    expect(guidance).not.toContain("attempting raw `curl` requests");
    // Do not reach for / lament missing raw credentials.
    expect(guidance).toContain("Do not treat the absence of raw API keys or direct API/curl access as a limitation");
    expect(guidance).toContain("Never report missing raw credentials to the user as a blocker.");
    // Go wide within the tool surface instead of stopping at one payload.
    expect(guidance).toContain("Use the tool surface flexibly");
    // Unavailable tool: name the integration and reason, but keep investigating via other sources.
    expect(guidance).toContain("name the specific integration");
    expect(guidance).toContain("Linear, Notion, or Slack search");
    expect(guidance).toContain("sanitized category");
    expect(guidance).toContain("If the tool returns an input or lookup result such as `invalid_input` or `not_found`");
    expect(guidance).toContain("rather than an integration outage");
    expect(guidance).toContain("Do not echo raw provider payloads");
    expect(guidance).toContain(
      "continue the task with other relevant available evidence sources when a viable path remains",
    );
  });

  it("does not emit memory-recall guidance for unrelated dynamic tools", () => {
    const withTools = buildSessionStaticBehavioralGuidance({
      agentRole: "implementation",
      dynamicToolNames: new Set(["linear.get_issue"]),
    });
    expect(withTools).toContain("# First-party dynamic tools");
    expect(withTools).not.toContain("# Memory recall");
    expect(withTools).not.toContain("before broad or risky edits");
  });

  it("emits memory guidance when memory tools are available", () => {
    const withCompanyMemoryTools = buildSessionStaticBehavioralGuidance({
      agentRole: "implementation",
      dynamicToolNames: new Set(["cycloid.memory_context"]),
    });
    expect(withCompanyMemoryTools).toContain("# Memory recall");
    expect(withCompanyMemoryTools).toContain("`cycloid.memory_context`");
    expect(withCompanyMemoryTools).toContain("`cycloid.memory_recall`");
    expect(withCompanyMemoryTools).toContain("`cycloid.company_memory_recall`");
    expect(withCompanyMemoryTools).toContain("`cycloid.company_memory_reasoning_chain`");
  });

  it("does not include deleted vibes-gated sections", () => {
    const guidance = buildSessionStaticBehavioralGuidance({
      agentRole: "implementation",
      dynamicToolNames: new Set(["cycloid.memory_recall", "linear.get_issue"]),
    });
    expect(guidance).not.toContain("# Data boundary verification");
    expect(guidance).not.toContain("# External tools");
    expect(guidance).not.toContain("# External interactions");
    expect(guidance).not.toContain("# SQL and database safety");
    expect(guidance).not.toContain("# Requesting user identity");
    expect(guidance).not.toContain("# Repo identity");
    expect(guidance).not.toContain("# Repo metadata");
  });
});
