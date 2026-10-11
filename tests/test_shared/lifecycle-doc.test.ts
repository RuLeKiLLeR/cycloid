import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CORRELATION_ENV_VAR, CORRELATION_HEADER } from "../../shared/correlation.js";
import { type Phase, PHASES } from "../../shared/events/schema.js";
import {
  createLogger,
  LOG_CORRELATION_FIELD_NAMES,
  LOG_LEVEL_ORDINALS,
  LOG_PARENT_SPAN_FIELD_NAME,
  LOG_TRACE_FIELD_NAMES,
  phaseLogFields,
} from "../../shared/observability/logger.js";

const REPO_ROOT = join(__dirname, "../..");

function readDoc(name: string): string {
  return readFileSync(join(REPO_ROOT, "docs", name), "utf-8");
}

describe("lifecycle documentation guardrails", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists every canonical phase from the shared event schema", () => {
    const lifecycle = readDoc("lifecycle.md");
    const phaseRows = Array.from(lifecycle.matchAll(/^\|\s*`([^`]+)`\s*\|/gm))
      .map((match) => match[1])
      .filter((phase): phase is Phase => (PHASES as readonly string[]).includes(phase));

    expect(phaseRows).toHaveLength(PHASES.length);
    expect(new Set(phaseRows)).toEqual(new Set(PHASES));
  });

  it("keeps correlation transport names in the lifecycle doc synced with shared code", () => {
    const lifecycle = readDoc("lifecycle.md");

    expect(lifecycle).toContain(CORRELATION_HEADER);
    expect(lifecycle).toContain(CORRELATION_ENV_VAR);
  });

  it("documents the trace and correlation fields emitted by the shared logger", () => {
    const docs = readDoc("lifecycle.md");
    const entries: Record<string, unknown>[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger({
      minLevel: LOG_LEVEL_ORDINALS.debug,
      traceProvider: () => ({ traceId: "trace-doc", spanId: "span-doc" }),
      correlationProvider: () => ({
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        parentSpanId: "c".repeat(16),
        sessionId: "session-doc",
        promptId: "prompt-doc",
        sandboxId: "sandbox-doc",
      }),
      entrySink: (entry) => entries.push(entry),
    });

    log.info(phaseLogFields("prompt.complete", { step: "execution", phase_status: "completed" }), "doc guardrail");

    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    const documentedFields = [
      ...LOG_TRACE_FIELD_NAMES,
      ...LOG_CORRELATION_FIELD_NAMES,
      "event",
      "step",
      "phase_status",
    ];

    for (const field of documentedFields) {
      expect(entry).toHaveProperty(field);
      expect(docs).toContain(field);
    }
    expect(entry).not.toHaveProperty("status");
    expect(docs).toContain(LOG_PARENT_SPAN_FIELD_NAME);
  });
});
