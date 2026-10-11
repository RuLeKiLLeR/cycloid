import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { wrapInstructionContent } from "../../../../shared/utils/prompt-safety.js";

const AGENT_PROFILE_INDEX_PATH = ".cycloid/agent-profiles/index.md";

export type ResolvedAgentProfileIndexInstruction = {
  path: string;
  content: string;
};

const AGENT_PROFILE_SELECTION_PREAMBLE = [
  "# Repo agent profile selection",
  "",
  "The repo agent profile index is provided below. Before choosing any repo skill or workflow for this prompt, inspect this index and decide whether the prompt or surrounding context matches one of the listed profiles.",
  "If a profile matches, read that profile file and use it as the primary guidance for this prompt's role, scope, success criteria, and final response format.",
  "After profile selection, you may use repo skills when they help execute the active profile. Treat skills as tactical guidance; they must not override the active profile's role, scope, success criteria, or final response format unless the user explicitly invoked that skill and its instructions conflict with the profile.",
  "If no profile clearly matches, continue normally and use skills when useful.",
].join("\n");

export function resolveAgentProfileIndexInstruction(repoRoot: string): ResolvedAgentProfileIndexInstruction | null {
  const absolutePath = join(repoRoot, AGENT_PROFILE_INDEX_PATH);
  if (!existsSync(absolutePath)) return null;

  const indexContent = readFileSync(absolutePath, "utf-8").trim();
  if (!indexContent) return null;

  return {
    path: AGENT_PROFILE_INDEX_PATH,
    content: [
      AGENT_PROFILE_SELECTION_PREAMBLE,
      "",
      wrapInstructionContent(indexContent, "repo_agent_profile_index", AGENT_PROFILE_INDEX_PATH),
    ].join("\n"),
  };
}
