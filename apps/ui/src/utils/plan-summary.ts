// Plan-mode planning turns respond with a single `# Plan` markdown document
// (see docs/prompt-agents.md). The transcript renders that turn as a compact
// card instead of a wall of text; these helpers detect the plan turn and derive
// the card's summary purely from the message content — no backend signal needed.

const BREADTH_TOKEN = /\b(XS|S|M|L|XL)\b/i;
const PLAN_HEADING = /^#[ \t]+plan\b/im;

/**
 * True when a text event's content is a plan-turn `# Plan` document. The plan's
 * first markdown heading is the `# Plan` H1; a short prose preamble before it is
 * tolerated (agents sometimes prepend a sentence like "I have enough context…"),
 * but a lower-level `## Plan` subsection elsewhere does not qualify.
 */
export function isPlanText(text: string): boolean {
  const firstHeading = text.match(/^(#{1,6})[ \t]+(.+?)[ \t]*$/m);
  return firstHeading ? firstHeading[1] === "#" && /^plan\b/i.test(firstHeading[2]) : false;
}

/** Strip any prose preamble before the `# Plan` heading so the card shows the plan itself. */
export function extractPlanMarkdown(text: string): string {
  const idx = text.search(PLAN_HEADING);
  return idx > 0 ? text.slice(idx) : text;
}

type PlanSummary = {
  title: string;
  breadth: string | null;
  sectionCount: number;
};

/** Split a `## Heading` markdown document into a map of lowercased heading -> body. */
function parseSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  let heading: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (heading !== null) sections.set(heading.toLowerCase(), body.join("\n").trim());
    body = [];
  };
  for (const line of text.split("\n")) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      heading = match[1];
    } else if (heading !== null) {
      body.push(line);
    }
  }
  flush();
  return sections;
}

function firstProseLine(text: string): string | null {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("-") || line.startsWith("*")) continue;
    return line;
  }
  return null;
}

function truncate(value: string, max = 90): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/**
 * Derive a one-line title, breadth token (XS–XL), and section count from a plan
 * document. All fields degrade gracefully when a section is missing.
 */
export function parsePlanSummary(rawText: string): PlanSummary {
  const text = extractPlanMarkdown(rawText);
  const sections = parseSections(text);

  const intent = sections.get("intent restatement");
  const titleSource = (intent && firstProseLine(intent)) || firstProseLine(text) || "Plan";
  // Prefer the first sentence of the intent so the title stays short.
  const firstSentence = titleSource.split(/(?<=[.!?])\s/, 1)[0] ?? titleSource;

  const breadthBody = sections.get("breadth");
  const breadth = breadthBody ? (BREADTH_TOKEN.exec(breadthBody)?.[1]?.toUpperCase() ?? null) : null;

  return {
    title: truncate(firstSentence),
    breadth,
    sectionCount: sections.size,
  };
}
