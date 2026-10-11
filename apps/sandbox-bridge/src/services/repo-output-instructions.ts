import { type BridgeLogger } from "../logger.js";
import { readEffectiveProjectDocContent } from "../utils/project-doc-setup.js";
import { parseTemplateHeadings } from "./pr-template.js";

export type OutputInstructionsTopic = "pr-summary";

const MAX_OUTPUT_INSTRUCTIONS_CHARS = 4 * 1024;

const TOPIC_HEADING_ALIASES: Record<OutputInstructionsTopic, ReadonlySet<string>> = {
  "pr-summary": new Set([
    "pr descriptions",
    "pr description style",
    "pr summary",
    "pr summaries",
    "pr summary style",
    "pull request descriptions",
    "pull request summaries",
  ]),
};

export function resolveOutputInstructions(
  cwd: string,
  topic: OutputInstructionsTopic,
  log: BridgeLogger,
): string | null {
  const doc = readEffectiveProjectDocContent(cwd, log);
  if (!doc) return null;

  const aliases = TOPIC_HEADING_ALIASES[topic];
  const matched = parseTemplateHeadings(doc.content).find((heading) => aliases.has(heading.normalizedText));
  const body = matched?.body.trim();
  if (!body) return null;

  return body.slice(0, MAX_OUTPUT_INSTRUCTIONS_CHARS);
}
