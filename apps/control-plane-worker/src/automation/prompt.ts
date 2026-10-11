import { parseLeadingSkillCommands } from "../../../../shared/skills/index.js";

export type ScheduledAutomationPrompt = {
  prompt: string;
  skills?: string[];
};

export function splitScheduledAutomationPrompt(promptTemplate: string): ScheduledAutomationPrompt {
  const parsed = parseLeadingSkillCommands(promptTemplate);
  return {
    prompt: parsed.prompt,
    ...(parsed.skills.length > 0 ? { skills: parsed.skills } : {}),
  };
}

export function scheduledAutomationPromptEquals(
  left: ScheduledAutomationPrompt,
  right: ScheduledAutomationPrompt,
): boolean {
  return left.prompt === right.prompt && sameSkills(left.skills, right.skills);
}

function sameSkills(left: string[] | undefined, right: string[] | undefined): boolean {
  const normalizedLeft = left ?? [];
  const normalizedRight = right ?? [];
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((skill, index) => skill === normalizedRight[index])
  );
}
