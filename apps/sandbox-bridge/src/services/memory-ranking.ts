import { MEMORY_RECALL_OUTPUT_MAX_CHARS } from "../constants/bridge.js";

export interface Memory {
  id: string;
  content: string;
  context_hint: string;
  type: string;
  memory_type?: string;
  action_type?: string | null;
  level?: string;
  primitive?: string;
  status?: string;
  confidence?: string;
  authority?: string;
  enforcement?: string;
  subjects?: string[];
  symbols?: string[];
  tags?: string[];
  source_pr_urls?: string[];
  source_pr_number?: number | null;
  source_session_ids?: string[];
  triggers?: {
    tools: string[];
    path_globs: string[];
    command_patterns: string[];
    forbidden_patterns: string[];
    mcp_tools: string[];
  } | null;
  applies_to?: string[];
  scope: string;
  referenced_files: string | null;
  created_at?: string;
  updated_at?: string;
  selectionRank?: number;
  selectionScore?: number;
  reason?: string;
  expectedEffect?: string;
}

function parseReferencedFiles(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

export function formatMemorySection(memories: Memory[]): string {
  if (memories.length === 0) return "";

  const header =
    "# Engineering Memories\n\nThese are learned patterns from past work. Apply when relevant. Retrieval used structured relevance scoring.\n";
  let remaining = MEMORY_RECALL_OUTPUT_MAX_CHARS - header.length;
  const blocks = memories
    .map((m) => {
      const files = m.applies_to ?? parseReferencedFiles(m.referenced_files);
      const type = m.memory_type ?? m.type;
      const typeValue = m.action_type ? `${type}/${m.action_type}` : type;
      const metadataLines = [
        `## ${m.id}`,
        `Type: ${typeValue}`,
        m.level ? `Level: ${m.level}` : null,
        m.confidence ? `Confidence: ${m.confidence}` : null,
        m.authority ? `Authority: ${m.authority}` : null,
        files.length > 0 ? `Applies to: ${files.map((f) => "`" + f + "`").join(", ")}` : null,
      ].filter((line): line is string => Boolean(line));
      const prefix = `${metadataLines.join("\n")}\n\n`;
      const maxContentLength = remaining - prefix.length;
      if (maxContentLength <= "...[truncated memory]".length) return "";
      const content =
        m.content.length > maxContentLength
          ? `${m.content.slice(0, maxContentLength - "...[truncated memory]".length)}...[truncated memory]`
          : m.content;
      const block = `${prefix}${content}`;
      remaining -= block.length + 2;
      return block;
    })
    .filter((block) => block.length > 0);
  if (blocks.length === 0) return "";
  return header + blocks.join("\n\n");
}
