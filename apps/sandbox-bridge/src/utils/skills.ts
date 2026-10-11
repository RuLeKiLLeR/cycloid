import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

import { isValidSkillName, parseSkillMarkdown, SKILL_ROOTS } from "../../../../shared/skills/index.js";
import { wrapInstructionContent } from "../../../../shared/utils/prompt-safety.js";

export type ResolvedSkillInstruction = {
  name: string;
  path: string;
  content: string;
};

function substituteSkillArguments(content: string, argumentText: string): string {
  return content.replace(/\$ARGUMENTS\b/g, () => argumentText);
}

function resolveSkillFromRoot(
  repoRoot: string,
  root: (typeof SKILL_ROOTS)[number],
  name: string,
  argumentText: string,
): ResolvedSkillInstruction | null {
  const rootPath = join(repoRoot, root);
  if (!existsSync(rootPath)) return null;

  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const relativePath = `${root}/${entry.name}/SKILL.md`;
    const absolutePath = join(repoRoot, relativePath);
    if (!existsSync(absolutePath)) continue;

    const parsed = parseSkillMarkdown(readFileSync(absolutePath, "utf-8"));
    const skillName = parsed.name || entry.name;
    if (skillName !== name) continue;

    return {
      name,
      path: relativePath,
      content: wrapInstructionContent(
        substituteSkillArguments(parsed.content, argumentText),
        "repo_skill",
        relativePath,
      ),
    };
  }

  return null;
}

export function resolveSkillInstructions(
  repoRoot: string,
  skillNames: string[],
  argumentText = "",
): ResolvedSkillInstruction[] {
  const resolved: ResolvedSkillInstruction[] = [];
  const uniqueNames = [...new Set(skillNames)];

  for (const name of uniqueNames) {
    if (!isValidSkillName(name)) {
      throw new Error(`Invalid skill name: ${name}`);
    }

    let found: ResolvedSkillInstruction | null = null;
    for (const root of SKILL_ROOTS) {
      found = resolveSkillFromRoot(repoRoot, root, name, argumentText);
      if (!found) continue;
      break;
    }

    if (!found) {
      throw new Error(`Selected skill not found: ${name}`);
    }
    resolved.push(found);
  }

  return resolved;
}
