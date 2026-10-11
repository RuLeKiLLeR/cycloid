export type SkillInfo = {
  name: string;
  description: string;
  argument?: string;
  content: string;
  path?: string;
};

export type SkillMetadata = Omit<SkillInfo, "content">;

export const SKILL_ROOTS = [".claude/skills", ".agents/skills"] as const;

export const MAX_SKILLS_PER_PROMPT = 5;

const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;

export function isValidSkillName(value: string): boolean {
  return SKILL_NAME_RE.test(value);
}

function parseFrontmatterFields(yaml: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = yaml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[i]);
    if (!match) continue;

    const key = match[1];
    const rawValue = match[2].trim();
    if (/^[>|]-?$/.test(rawValue)) {
      const blockLines: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (next.length > 0 && !/^\s/.test(next)) break;
        i++;
        blockLines.push(/^\s*$/.test(next) ? "" : next.trim());
      }
      while (blockLines.length > 0 && blockLines[blockLines.length - 1] === "") blockLines.pop();
      fields[key] = rawValue.startsWith(">") ? blockLines.join(" ").trim() : blockLines.join("\n").trim();
      continue;
    }

    fields[key] = rawValue;
  }
  return fields;
}

export function parseSkillMarkdown(raw: string): {
  name: string;
  description: string;
  argument?: string;
  content: string;
} {
  const normalized = raw.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { name: "", description: "", content: normalized.trim() };

  const fields = parseFrontmatterFields(match[1]);
  const content = match[2].trim();
  const argument = fields.argument?.trim();
  return {
    name: fields.name?.trim() ?? "",
    description: fields.description?.trim() ?? "",
    ...(argument ? { argument } : {}),
    content,
  };
}

export type LeadingSkillCommandParseResult = {
  skills: string[];
  prompt: string;
};

export function parseLeadingSkillCommands(input: string): LeadingSkillCommandParseResult {
  let cursor = 0;
  while (cursor < input.length && /\s/.test(input[cursor])) cursor++;

  const skills: string[] = [];
  while (input[cursor] === "/") {
    const remainder = input.slice(cursor);
    const match = /^\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,79})(?=$|\s)/.exec(remainder);
    if (!match) break;

    const name = match[1];
    if (!skills.includes(name)) skills.push(name);
    cursor += match[0].length;

    if (cursor < input.length && !/\s/.test(input[cursor])) break;
    while (cursor < input.length && /\s/.test(input[cursor])) cursor++;
  }

  return {
    skills,
    prompt: input.slice(cursor).trimStart(),
  };
}
