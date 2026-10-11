export const MEMORY_LINK_TYPES = [
  "owns",
  "mentions",
  "decided_in",
  "blocks",
  "depends_on",
  "committed_to",
  "supersedes",
  "authored_by",
  "reviewed_by",
  "escalated_to",
  "assigned_to",
] as const;

export type MemoryLinkType = (typeof MEMORY_LINK_TYPES)[number];

const LINK_TYPE_SET = new Set<string>(MEMORY_LINK_TYPES);

export function isAllowedMemoryLinkType(value: string): value is MemoryLinkType {
  return LINK_TYPE_SET.has(value);
}
