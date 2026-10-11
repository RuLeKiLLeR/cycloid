export type CodexProtocolAxis = "itemType" | "notification" | "serverRequest";
export type CodexProtocolBucket = "translated" | "raw_fallback" | "ignored";

type CodexProtocolCoverageEntry = {
  bucket: CodexProtocolBucket;
  rationale: string;
  consumedAs: "direct" | "derived" | "raw";
};

function translated(rationale: string, consumedAs: CodexProtocolCoverageEntry["consumedAs"] = "direct") {
  return { bucket: "translated", rationale, consumedAs } as const;
}

function rawFallback(rationale: string) {
  return { bucket: "raw_fallback", rationale, consumedAs: "raw" } as const;
}

function ignored(rationale: string, consumedAs: CodexProtocolCoverageEntry["consumedAs"] = "derived") {
  return { bucket: "ignored", rationale, consumedAs } as const;
}

export const CODEX_PROTOCOL_ITEM_TYPE_COVERAGE: Record<string, CodexProtocolCoverageEntry> = {
  userMessage: translated("User prompts become message role metadata for downstream text gating."),
  agentMessage: translated("Assistant messages stream into bridge text parts."),
  reasoning: translated("Reasoning items stream into bridge reasoning parts."),
  commandExecution: translated("Shell execution becomes first-class bash tool lifecycle events."),
  fileChange: translated("File diffs remain the fallback apply_patch consequence stream."),
  mcpToolCall: translated("MCP tool calls become first-class tool parts and runtime evidence."),
  dynamicToolCall: translated("First-party dynamic tools become first-class tool parts."),
  customToolCall: translated("Direct apply_patch-style custom tool calls drive canonical tool lifecycle."),
  customToolCallOutput: translated("Direct apply_patch outputs provide canonical terminal status."),
  custom_tool_call: translated("Raw response items can still surface direct apply_patch calls."),
  custom_tool_call_output: translated("Raw response items can still surface direct apply_patch outputs."),
  plan: rawFallback("Planning items are visible in debug streams until Cycloid promotes them."),
  collabAgentToolCall: rawFallback("Multi-agent tool-call surfaces remain debug-only in this slice."),
  contextCompaction: rawFallback("Direct compaction items stay raw while Cycloid keeps using derived signals."),
  hookPrompt: rawFallback("Hook prompts are useful in debug streams but not first-class UX yet."),
  imageGeneration: rawFallback("Image-generation items are not promoted by the bridge today."),
  imageView: rawFallback("Image-view items are not promoted by the bridge today."),
  webSearch: rawFallback("Web search is disabled in Cycloid sessions; raw fallback keeps visibility when it appears."),
  enteredReviewMode: rawFallback("Review-mode entry remains debug-only until a dedicated UX exists."),
  exitedReviewMode: rawFallback("Review-mode exit remains debug-only until a dedicated UX exists."),
};

export const CODEX_PROTOCOL_NOTIFICATION_COVERAGE: Record<string, CodexProtocolCoverageEntry> = {
  "thread/started": translated("Thread creation becomes session.created."),
  "turn/started": translated("Turn start becomes session.status running."),
  "thread/tokenUsage/updated": translated("Token usage updates feed bridge attribution."),
  "item/started": translated("Thread items are classified and adapted here."),
  "item/completed": translated("Thread items are classified and adapted here."),
  "item/agentMessage/delta": translated("Assistant message deltas stream text."),
  "item/reasoning/textDelta": translated("Reasoning deltas stream reasoning text."),
  "item/reasoning/summaryTextDelta": translated("Reasoning summary deltas backfill early reasoning text."),
  "item/commandExecution/outputDelta": translated("Command output deltas update bash tool output."),
  "item/fileChange/patchUpdated": translated("Patch updates become patch message parts."),
  "mcpServer/startupStatus/updated": translated("MCP startup status feeds runtime MCP state."),
  "hook/started": translated("Hook execution is surfaced to the bridge."),
  "hook/completed": translated("Hook execution is surfaced to the bridge."),
  "turn/completed": translated("Turn completion drives idle or terminal session.error."),
  error: translated("Structured app-server errors become session.error."),
  raw_response_item: translated("Raw response items can carry direct custom tool lifecycle events."),
  warning: rawFallback("Warnings should be visible for debugging until promoted."),
  "turn/diff/updated": rawFallback("Raw diff updates remain debug-only in the stdio adapter."),
  "item/plan/delta": rawFallback("Plan deltas are explicitly visible but not promoted yet."),
  "item/fileChange/outputDelta": rawFallback("File-change output deltas stay debug-only for now."),
  "thread/status/changed": ignored("Session status is already derived from translated turn lifecycle events."),
  "account/rateLimits/updated": ignored("Rate-limit snapshots do not affect Cycloid session correctness today."),
  "remoteControl/status/changed": ignored("Remote-control availability is host noise for Cycloid sessions."),
  "skills/changed": ignored("Skill list refreshes are host noise for Cycloid sessions."),
};

export const CODEX_PROTOCOL_SERVER_REQUEST_COVERAGE: Record<string, CodexProtocolCoverageEntry> = {
  "item/tool/requestUserInput": translated("Child questions become bridge question.asked events."),
  "item/commandExecution/requestApproval": translated("Command approvals fail closed in Cycloid sessions."),
  "item/fileChange/requestApproval": translated("File-change approvals fail closed in Cycloid sessions."),
  "item/permissions/requestApproval": translated("Permission prompts fail closed with the bridge policy."),
  "mcpServer/elicitation/request": translated("Elicitations are cancelled explicitly by the bridge."),
  applyPatchApproval: translated("Legacy apply_patch approvals fail closed in Cycloid sessions."),
  execCommandApproval: translated("Legacy exec approvals fail closed in Cycloid sessions."),
  "item/tool/call": translated("First-party dynamic tool calls execute through the bridge."),
};

export function getCodexProtocolCoverage(
  axis: CodexProtocolAxis,
  type: string,
): CodexProtocolCoverageEntry | undefined {
  switch (axis) {
    case "itemType":
      return CODEX_PROTOCOL_ITEM_TYPE_COVERAGE[type];
    case "notification":
      return CODEX_PROTOCOL_NOTIFICATION_COVERAGE[type];
    case "serverRequest":
      return CODEX_PROTOCOL_SERVER_REQUEST_COVERAGE[type];
  }
}
