import { readFileSync } from "node:fs";

import type { MemoryTriggers } from "../../../../shared/memory/parser.js";
import { type Memory } from "./memory-ranking.js";
import { loadActiveRepoMemories } from "./repo-memory-files.js";

type HookInput = {
  hook_event_name?: string;
  hookEventName?: string;
  prompt?: string;
  cwd?: string;
  tool_name?: string;
  toolName?: string;
  tool_input?: unknown;
  toolInput?: unknown;
  tool_output?: unknown;
  toolOutput?: unknown;
  tool_result?: unknown;
  toolResult?: unknown;
  result?: unknown;
  transcript_path?: string;
};

type HookDecision = {
  decision?: "block";
  reason?: string;
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
    systemMessage?: string;
  };
};

const HOOK_MEMORY_LIMIT = 3;

export async function runMemoryHookFromStdin(stdin = process.stdin, stdout = process.stdout): Promise<void> {
  const rawInput = await readAll(stdin);
  let input: HookInput;
  try {
    input = JSON.parse(rawInput) as HookInput;
  } catch {
    stdout.write("{}\n");
    return;
  }
  try {
    const result = runMemoryHook(input, process.env.REPO_PATH || input.cwd || process.cwd());
    stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    stdout.write("{}\n");
  }
}

export function runMemoryHook(input: HookInput, repoPath: string): HookDecision {
  const eventName = input.hook_event_name ?? input.hookEventName ?? "";
  const activeMemories = loadActiveRepoMemories(repoPath).map((entry) => entry.memory);
  if (activeMemories.length === 0) return {};

  if (eventName === "UserPromptSubmit") {
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    const selected = selectMemoriesForText(activeMemories, prompt, []).slice(0, HOOK_MEMORY_LIMIT);
    if (selected.length === 0) return {};
    return additionalContext(eventName, formatMemoryRecallReminder("prompt", selected));
  }

  if (eventName === "PreToolUse") {
    const toolName = input.tool_name ?? input.toolName ?? "";
    const toolInput = stringifyToolInput(input.tool_input ?? input.toolInput);
    const relevant = activeMemories.filter((memory) =>
      triggerMatches(memory.triggers ?? null, String(toolName), toolInput),
    );
    const blockable = relevant.find((memory) => shouldBlock(memory, String(toolName), toolInput));
    if (blockable) {
      return {
        decision: "block",
        reason: `Blocked by Cycloid memory ${blockable.id}: ${blockable.context_hint}`,
        hookSpecificOutput: {
          hookEventName: eventName,
          systemMessage: `Blocked by Cycloid memory ${blockable.id}: ${blockable.context_hint}`,
        },
      };
    }
    const warnable = relevant.find((memory) => memory.enforcement === "warn");
    if (warnable) {
      return {
        hookSpecificOutput: {
          hookEventName: eventName,
          systemMessage: `Cycloid memory ${warnable.id}: ${warnable.context_hint}`,
        },
      };
    }
    const nearMissBlock = relevant.find((memory) =>
      shouldWarnForPartialBlockMatch(memory, String(toolName), toolInput),
    );
    if (nearMissBlock) {
      return {
        hookSpecificOutput: {
          hookEventName: eventName,
          systemMessage: `Cycloid memory ${nearMissBlock.id}: ${nearMissBlock.context_hint}`,
        },
      };
    }
    return {};
  }

  if (eventName === "PostToolUse") {
    const toolInput = stringifyToolInput(input.tool_input ?? input.toolInput);
    const toolOutput = stringifyToolInput(
      input.tool_output ?? input.toolOutput ?? input.tool_result ?? input.toolResult ?? input.result,
    );
    const selected = selectMemoriesForPostTool(activeMemories, `${toolInput}\n${toolOutput}`).slice(
      0,
      HOOK_MEMORY_LIMIT,
    );
    if (selected.length === 0) return {};
    return additionalContext(eventName, formatMemoryRecallReminder("tool_result", selected));
  }

  if (eventName === "Stop") {
    const transcript = readTranscript(input.transcript_path);
    const violatedBlock = activeMemories.find(
      (memory) =>
        memory.status === "active" &&
        memory.confidence === "high" &&
        (memory.authority === "reviewed" || memory.authority === "source_of_truth") &&
        (memory.memory_type === "action" || memory.primitive === "gotcha") &&
        memory.enforcement === "block" &&
        memory.triggers &&
        forbiddenPatternMatches(memory.triggers, transcript),
    );
    if (violatedBlock) {
      return {
        decision: "block",
        reason: `Blocked by Cycloid memory ${violatedBlock.id}: ${violatedBlock.context_hint}`,
        hookSpecificOutput: {
          hookEventName: eventName,
          additionalContext: formatMemoryVerificationReminder([violatedBlock]),
        },
      };
    }
    const obligations = activeMemories.filter((memory) => hasUnfinishedVerificationObligation(memory, transcript));
    if (obligations.length === 0) return {};
    return additionalContext(eventName, formatMemoryVerificationReminder(obligations.slice(0, HOOK_MEMORY_LIMIT)));
  }

  return {};
}

function formatMemoryRecallReminder(trigger: "prompt" | "tool_result", memories: Memory[]): string {
  const reason =
    trigger === "prompt"
      ? "Check repo memory before planning or editing."
      : "Check repo memory for the new tool output.";
  const memoryRefs = memories
    .map((memory) => `- ${memory.id}${memory.applies_to?.length ? ` (${memory.applies_to.join(", ")})` : ""}`)
    .join("\n");
  return [
    reason,
    "Call cycloid.memory_context before editing if prior repo context could affect the task.",
    "Memory candidates:",
    memoryRefs,
  ].join("\n");
}

function formatMemoryVerificationReminder(memories: Memory[]): string {
  const memoryRefs = memories
    .map((memory) => `- ${memory.id}${memory.applies_to?.length ? ` (${memory.applies_to.join(", ")})` : ""}`)
    .join("\n");
  return [
    "Repo memory may require verification before stopping.",
    "Call cycloid.memory_context if you need the full memory text.",
    "Memory candidates:",
    memoryRefs,
  ].join("\n");
}

function selectMemoriesForText(memories: Memory[], text: string, files: string[]): Memory[] {
  const normalized = text.toLowerCase();
  return memories.filter((memory) => {
    const appliesTo = memory.applies_to ?? [];
    if (appliesTo.some((path) => normalized.includes(path.replace(/\*\*?$/, "").toLowerCase()))) return true;
    if (files.some((file) => appliesTo.some((path) => globishMatches(path, file)))) return true;
    return normalized.includes(memory.id.toLowerCase()) || normalized.includes(memory.context_hint.toLowerCase());
  });
}

function selectMemoriesForPostTool(memories: Memory[], text: string): Memory[] {
  return selectMemoriesForText(memories, text, []).filter((memory) => {
    if (!memory.triggers) return true;
    if (forbiddenPatternMatches(memory.triggers, text)) return true;
    const normalized = text.toLowerCase();
    return /\b(error|failed|failure|exception|denied|unauthorized|timeout|not found)\b/i.test(normalized);
  });
}

function shouldBlock(memory: Memory, toolName: string, toolInput: string): boolean {
  if (memory.status !== "active") return false;
  if (memory.authority !== "reviewed" && memory.authority !== "source_of_truth") return false;
  if (memory.confidence !== "high") return false;
  if (memory.enforcement !== "block") return false;
  if (memory.memory_type !== "action" && memory.primitive !== "gotcha") return false;
  if (!memory.triggers) return false;
  if (!isMutatingTool(memory.triggers, toolName)) return false;
  return triggerMatches(memory.triggers, toolName, toolInput) && forbiddenPatternMatches(memory.triggers, toolInput);
}

function shouldWarnForPartialBlockMatch(memory: Memory, toolName: string, toolInput: string): boolean {
  if (memory.status !== "active") return false;
  if (memory.enforcement !== "block") return false;
  if (memory.memory_type !== "action" && memory.primitive !== "gotcha") return false;
  if (!memory.triggers) return false;
  if (!triggerMatches(memory.triggers, toolName, toolInput)) return false;
  return !shouldBlock(memory, toolName, toolInput);
}

function triggerMatches(triggers: MemoryTriggers | null, toolName: string, toolInput: string): boolean {
  if (!triggers) return false;
  const normalizedTool = toolName.toLowerCase();
  if (triggers.tools.some((tool) => tool.toLowerCase() === normalizedTool)) return true;
  if (triggers.mcp_tools.some((tool) => tool.toLowerCase() === normalizedTool)) return true;
  if (triggers.path_globs.some((glob) => globishMatches(glob, toolInput))) return true;
  return triggers.command_patterns.some((pattern) => safeRegexTest(pattern, toolInput));
}

function forbiddenPatternMatches(triggers: MemoryTriggers, toolInput: string): boolean {
  return (
    triggers.forbidden_patterns.some((pattern) => safeRegexTest(pattern, toolInput)) ||
    triggers.command_patterns.some((pattern) => safeRegexTest(pattern, toolInput))
  );
}

function isMutatingTool(triggers: MemoryTriggers | null, toolName: string): boolean {
  if (!triggers) return false;
  const normalizedTool = toolName.toLowerCase();
  return (
    triggers.tools.some((tool) => tool.toLowerCase() === normalizedTool) ||
    triggers.mcp_tools.some((tool) => tool.toLowerCase() === normalizedTool)
  );
}

function hasUnfinishedVerificationObligation(memory: Memory, transcript: string): boolean {
  if (memory.status !== "active") return false;
  if (memory.confidence !== "high") return false;
  if (memory.authority !== "reviewed" && memory.authority !== "source_of_truth") return false;
  if (memory.memory_type !== "action" && memory.primitive !== "gotcha") return false;
  if (!/\b(test|verify|verification|typecheck|lint|format)\b/i.test(`${memory.context_hint}\n${memory.content}`)) {
    return false;
  }

  const coveredPathChanged = (memory.applies_to ?? []).some((path) => {
    const normalizedPath = path.replace(/\*\*?$/, "");
    if (!normalizedPath) return false;
    return (
      transcript.includes(normalizedPath) &&
      /\b(apply_patch|Applied patch|modified|changed|write|Update File)\b/i.test(transcript)
    );
  });
  if (!coveredPathChanged) return false;

  return !/\b(npm\s+(run\s+)?(test|typecheck|lint|format:check)|npx\s+vitest|pnpm\s+(test|typecheck|lint)|yarn\s+(test|typecheck|lint)|pytest|cargo\s+test|go\s+test)\b/i.test(
    transcript,
  );
}

function globishMatches(glob: string, value: string): boolean {
  const needle = glob
    .replace(/\*\*.*$/, "")
    .replace(/\*.*$/, "")
    .toLowerCase();
  return needle.length > 0 && value.toLowerCase().includes(needle);
}

function safeRegexTest(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern, "i").test(value);
  } catch {
    return false;
  }
}

function stringifyToolInput(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? {});
}

function readTranscript(path: unknown): string {
  if (typeof path !== "string" || !path) return "";
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function additionalContext(hookEventName: string, additionalContext: string): HookDecision {
  return { hookSpecificOutput: { hookEventName, additionalContext } };
}

function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      data += chunk;
    });
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });
}
