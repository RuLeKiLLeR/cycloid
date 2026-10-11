#!/usr/bin/env tsx
/**
 * Export agent traces with REAL tool output from harness session transcripts.
 *
 * The agent-trace JSONL we hand downstream (Braintrust ingestion) is normally
 * sourced from Braintrust spans, which only store the tool STATUS ("completed")
 * - not the tool output. This script instead reads the harness's own on-disk
 * session transcript (Codex rollout JSONL or Claude Code project JSONL), which
 * records the real stdout/stderr of every tool call, and emits the same trace
 * shape with `tools[].output` populated. Output is secret-scrubbed and truncated
 * before it is written.
 *
 * Usage:
 *   tsx scripts/export-agent-traces.ts \
 *     --in <transcript.jsonl> [--in <transcript2.jsonl> ...] \
 *     --out <out.jsonl> \
 *     [--meta <meta.json>] [--format codex|claude] [--max-output-chars N]
 *     [--allow-unscrubbed]
 *
 * `--meta` is a JSON object (or array, one per `--in`) of session-identity
 * overrides Cycloid knows but the transcript does not: sessionId, repo, env,
 * agent, agentRole, branch, model, provider.
 *
 * Before writing, the rendered output is scanned for high-confidence secret
 * shapes; if any survived redaction the write is REFUSED. `--allow-unscrubbed`
 * overrides this for local-only debugging and must never be used for a handoff.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";

import { buildTrace, detectFormat, type HarnessFormat, parseTranscript } from "./agent-trace-export/build-trace.js";
import { scanForSecrets } from "./agent-trace-export/redact.js";
import type { TraceOverrides } from "./agent-trace-export/types.js";
import { DEFAULT_REDACTION } from "./agent-trace-export/types.js";

interface CliArgs {
  inputs: string[];
  out: string;
  metaPath?: string;
  format?: HarnessFormat;
  maxOutputChars: number;
  allowUnscrubbed: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const inputs: string[] = [];
  let out = "";
  let metaPath: string | undefined;
  let format: HarnessFormat | undefined;
  let maxOutputChars = DEFAULT_REDACTION.maxOutputChars;
  let allowUnscrubbed = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--in") inputs.push(next());
    else if (arg === "--out") out = next();
    else if (arg === "--meta") metaPath = next();
    else if (arg === "--allow-unscrubbed") allowUnscrubbed = true;
    else if (arg === "--format") {
      const f = next();
      if (f !== "codex" && f !== "claude") throw new Error(`--format must be codex|claude, got ${f}`);
      format = f;
    } else if (arg === "--max-output-chars") maxOutputChars = Number(next());
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (inputs.length === 0) throw new Error("At least one --in <transcript.jsonl> is required");
  if (!out) throw new Error("--out <out.jsonl> is required");
  if (!Number.isFinite(maxOutputChars) || maxOutputChars <= 0)
    throw new Error("--max-output-chars must be a positive number");
  return { inputs, out, metaPath, format, maxOutputChars, allowUnscrubbed };
}

/** Parse a JSONL file into records, skipping blank/malformed lines. */
function readJsonl(path: string): unknown[] {
  const records: unknown[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // Tolerate a partially-flushed final line; skip it.
    }
  }
  return records;
}

/**
 * Resolve per-input overrides from a parsed `--meta` value. An array supplies
 * one entry per input (keeping each entry's own sessionId, with a positional
 * fallback). A single object is broadcast across all inputs - and because the
 * same object would otherwise reuse one sessionId for every trace, the index is
 * always appended so ids stay unique. `meta` is undefined when no --meta given.
 */
export function resolveOverrides(meta: unknown, count: number): TraceOverrides[] {
  if (meta === undefined) {
    return Array.from({ length: count }, (_, i) => ({ sessionId: `trace-${i + 1}` }));
  }
  const isArray = Array.isArray(meta);
  const arr: TraceOverrides[] = isArray
    ? (meta as TraceOverrides[])
    : Array.from({ length: count }, () => meta as TraceOverrides);
  return arr.map((m, i) => ({
    ...m,
    sessionId: isArray ? (m.sessionId ?? `trace-${i + 1}`) : `${m.sessionId ?? "trace"}-${i + 1}`,
  }));
}

function loadOverrides(metaPath: string | undefined, count: number): TraceOverrides[] {
  const meta = metaPath ? JSON.parse(readFileSync(metaPath, "utf8")) : undefined;
  return resolveOverrides(meta, count);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const overrides = loadOverrides(args.metaPath, args.inputs.length);
  const redaction = { maxOutputChars: args.maxOutputChars };

  const lines: string[] = [];
  for (let i = 0; i < args.inputs.length; i++) {
    const records = readJsonl(args.inputs[i]);
    const format = args.format ?? detectFormat(records);
    const parsed = parseTranscript(records, format, redaction);
    const trace = buildTrace(parsed, overrides[i] ?? { sessionId: `trace-${i + 1}` });
    lines.push(JSON.stringify(trace));
    process.stderr.write(
      `${args.inputs[i]} -> ${format}: ${trace.toolCallCount} tools, ${trace.turns.length} turns, outcome=${trace.outcome}\n`,
    );
  }

  // Ship-blocking safety net: scan the fully rendered output for any secret
  // shape that survived redaction. If anything is found, refuse to write -
  // never leak silently. `--allow-unscrubbed` overrides only for local debugging.
  const rendered = lines.join("\n") + "\n";
  const residual = scanForSecrets(rendered);
  if (residual.length > 0) {
    const list = residual.map((r) => `  - ${r}...`).join("\n");
    if (!args.allowUnscrubbed) {
      process.stderr.write(
        `REFUSING TO WRITE: ${residual.length} secret-shaped value(s) survived redaction:\n${list}\n` +
          `Add a pattern to redact.ts (or pass --allow-unscrubbed for local-only debugging). Nothing was written.\n`,
      );
      process.exitCode = 1;
      return;
    }
    // Bypass active: still write, but never emit a "passed" all-clear - the
    // operator must know the file contains residual secrets and is unsafe.
    process.stderr.write(
      `WARNING --allow-unscrubbed: ${residual.length} secret-shaped value(s) ARE PRESENT in the output. DO NOT hand off this file:\n${list}\n`,
    );
  }

  writeFileSync(args.out, rendered);
  process.stderr.write(
    residual.length === 0
      ? `Wrote ${lines.length} trace(s) to ${args.out} (passed secret scan)\n`
      : `Wrote ${lines.length} trace(s) to ${args.out} (UNSAFE: --allow-unscrubbed, ${residual.length} secret(s) present)\n`,
  );
}

// Only run when invoked directly (not when imported by tests).
if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main();
}
