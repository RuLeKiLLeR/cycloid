// Atlassian Document Format helpers shared by the control plane (webhook issue
// re-fetch) and the sandbox bridge (jira dynamic tools). v1 fidelity is
// deliberately minimal: plain text wraps into paragraph nodes on write, and
// arbitrary ADF flattens to plain text on read.

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type AdfNode = Record<string, unknown>;

function textNode(text: string, marks: AdfNode[] = []): AdfNode {
  return marks.length > 0 ? { type: "text", text, marks } : { type: "text", text };
}

export function adfText(text: string): AdfNode {
  return textNode(text);
}

export function adfInlineCode(text: string): AdfNode {
  return textNode(text, [{ type: "code" }]);
}

export function adfParagraph(content: AdfNode[]): AdfNode {
  return { type: "paragraph", content };
}

export function adfHeading(level: number, content: AdfNode[]): AdfNode {
  const safeLevel = Number.isInteger(level) && level >= 1 && level <= 6 ? level : 3;
  return { type: "heading", attrs: { level: safeLevel }, content };
}

export function adfBulletList(items: AdfNode[][]): AdfNode {
  return {
    type: "bulletList",
    content: items.map((item) => ({ type: "listItem", content: item.length > 0 ? item : [adfParagraph([])] })),
  };
}

export function adfDoc(content: AdfNode[]): Record<string, unknown> {
  return {
    type: "doc",
    version: 1,
    content: content.length > 0 ? content : [adfParagraph([])],
  };
}

export function wrapTextAsAdf(text: string): Record<string, unknown> {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => {
      const content: Array<Record<string, unknown>> = [];
      const lines = paragraph.split("\n");
      lines.forEach((line, index) => {
        if (line.length > 0) content.push({ type: "text", text: line });
        if (index < lines.length - 1) content.push({ type: "hardBreak" });
      });
      return { type: "paragraph", content };
    });

  return {
    type: "doc",
    version: 1,
    content: paragraphs.length > 0 ? paragraphs : [{ type: "paragraph", content: [] }],
  };
}

function splitInlineCode(text: string): AdfNode[] {
  const nodes: AdfNode[] = [];
  const parts = text.split(/(`[^`]+`)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      nodes.push(adfInlineCode(part.slice(1, -1)));
    } else {
      nodes.push(adfText(part));
    }
  }
  return nodes;
}

function repoSkipAction(reasonText: string): string | null {
  if (reasonText.includes("Set a default repo")) {
    return "Set a default repo in Cycloid settings, or add `repo=owner/name` to the Jira description, then re-add the label.";
  }
  if (reasonText.includes("Install it")) return "Install the GitHub App, then re-add the label.";
  if (reasonText.includes("Reconnect GitHub")) return "Reconnect GitHub in Cycloid settings, then re-add the label.";
  return null;
}

export function formatJiraIssueCommentAsAdf(text: string): Record<string, unknown> {
  try {
    const trimmed = text.trim();
    const sessionPrefix = "Cycloid couldn't start a session:";
    const accessPrefix = "Cycloid couldn't confirm access to";
    const isSessionSkip = trimmed.startsWith(sessionPrefix);
    const isAccessSkip = trimmed.startsWith(accessPrefix);
    if (!isSessionSkip && !isAccessSkip) return wrapTextAsAdf(text);

    const reasonText = isSessionSkip ? trimmed.slice(sessionPrefix.length).trim() : trimmed;
    const action = repoSkipAction(reasonText);
    return adfDoc([
      adfHeading(3, [adfText("Cycloid couldn't start a session")]),
      adfParagraph(splitInlineCode(reasonText)),
      ...(action ? [adfBulletList([[adfParagraph(splitInlineCode(action))]])] : []),
    ]);
  } catch {
    return wrapTextAsAdf(text);
  }
}

const ADF_BLOCK_TYPES = new Set(["paragraph", "heading", "blockquote", "codeBlock", "listItem", "tableRow"]);

export function flattenAdfToText(node: unknown): string {
  const record = asRecord(node);
  if (!record) return "";

  if (record.type === "text" && typeof record.text === "string") {
    return record.text;
  }
  if (record.type === "hardBreak") {
    return "\n";
  }

  // Inline leaf nodes carry their text in `attrs`, not a `content` array, so
  // without this they flatten to "" and silently drop (a `mention` between two
  // text runs would also fuse the surrounding words). Map them to a textual
  // surrogate; block separation below is unchanged.
  if (record.type === "mention" || record.type === "emoji") {
    const attrs = asRecord(record.attrs);
    const text =
      attrs &&
      (typeof attrs.text === "string" ? attrs.text : typeof attrs.shortName === "string" ? attrs.shortName : null);
    if (typeof text === "string" && text.length > 0) return text;
  }
  if (record.type === "inlineCard") {
    const attrs = asRecord(record.attrs);
    if (attrs && typeof attrs.url === "string" && attrs.url.length > 0) return attrs.url;
  }

  const content = Array.isArray(record.content) ? record.content : [];
  const childText = content.map((child) => flattenAdfToText(child)).join("");

  // Block-level nodes get paragraph separation so flattened output stays readable.
  if (typeof record.type === "string" && ADF_BLOCK_TYPES.has(record.type)) {
    return `${childText}\n\n`;
  }
  return childText;
}

/** Flattens an ADF description to trimmed plain text, or null when empty. */
export function flattenAdfDescription(description: unknown): string | null {
  if (description === null || description === undefined) return null;
  const text = flattenAdfToText(description)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > 0 ? text : null;
}
