// Memory analyzer: builds bounded session/review context and asks for one
// structured result with genuinely useful memories and convention updates.

import { GPT54_MINI_SIDECAR_REASONING_EFFORT } from "../../../../shared/constants/models.js";
import { OpenAIServiceTier } from "../../../../shared/enums/openai-service-tier.js";
import type { StructuredOutputTool } from "../../../../shared/llm/structured-output.js";
import {
  ENGINEERING_DOMAINS,
  type EngineeringDomain,
  MEMORY_ACTION_TYPES,
  MEMORY_AUTHORITIES,
  MEMORY_CONFIDENCES,
  MEMORY_ENFORCEMENTS,
  MEMORY_LEVELS,
  MEMORY_PRIMITIVES,
  MEMORY_TYPES,
  type MemoryActionType,
  type MemoryAuthority,
  type MemoryConfidence,
  type MemoryEnforcement,
  type MemoryLevel,
  type MemoryPrimitive,
  type MemoryTriggers,
  type MemoryType,
} from "../../../../shared/memory/parser.js";
import {
  CONVENTION_TARGET_FILES,
  MEMORY_AGENT_MAX_TOKENS_PER_TURN,
  MEMORY_AGENT_MODEL,
  MEMORY_AGENT_TOTAL_TIMEOUT_MS,
  MEMORY_CONTENT_MAX_LENGTH,
} from "../constants/memory.js";
import type { Logger } from "../logger.js";
import { queryPlatformStructuredOutput } from "../services/platform-structured-output";
import type { SessionEvent } from "../types.js";
import { countCandidateAuditByLane, semanticDefaultsForSuggestion } from "./utils.js";

// ---------------------------------------------------------------------------
// Public types (unchanged from before — keeps PR-creation pipeline stable)
// ---------------------------------------------------------------------------

/** Shape expected by the analyzer — adapter from repo files or D1 rows. */
export interface AnalyzerMemoryInput {
  id: string;
  content: string;
  context_hint: string;
  type: string;
  referenced_files: string | null;
}

export interface MemorySuggestion {
  type: string;
  memory_type: MemoryType;
  action_type: MemoryActionType | null;
  level: MemoryLevel;
  primitive: MemoryPrimitive;
  engineering_domains: EngineeringDomain[];
  subjects: string[];
  symbols: string[];
  tags: string[];
  confidence: MemoryConfidence;
  authority: MemoryAuthority;
  enforcement: MemoryEnforcement;
  triggers: MemoryTriggers | null;
  supersedes: string[];
  contradicts: string[];
  content: string;
  context_hint: string;
  referenced_files: string[];
  rationale: string;
}

export interface MemoryEpisodeSummary {
  source_pr: string;
  title: string;
  change_summary: string;
  prompt_summary: string;
  review_summary: string;
  touched_subsystems: string[];
  existing_memory_summary: string;
  durable_lesson: string;
}

export const MEMORY_CANDIDATE_LANES = ["strategic", "tactical", "gotcha", "no_memory"] as const;
export type MemoryCandidateLane = (typeof MEMORY_CANDIDATE_LANES)[number];

export interface MemoryCandidateAudit {
  lane: MemoryCandidateLane;
  lesson: string;
  evidence: string;
  selected: boolean;
  rejection_reason: string | null;
}

interface MemoryUpdateSuggestion {
  id: string;
  memory_type?: MemoryType;
  action_type?: MemoryActionType | null;
  level?: MemoryLevel;
  primitive?: MemoryPrimitive;
  engineering_domains?: EngineeringDomain[];
  subjects?: string[];
  symbols?: string[];
  tags?: string[];
  confidence?: MemoryConfidence;
  authority?: MemoryAuthority;
  enforcement?: MemoryEnforcement;
  triggers?: MemoryTriggers | null;
  supersedes?: string[];
  contradicts?: string[];
  content: string;
  context_hint: string;
  referenced_files: string[];
  rationale: string;
}

type MemoryUpdateSemanticFields = Omit<
  MemoryUpdateSuggestion,
  "id" | "content" | "context_hint" | "referenced_files" | "rationale"
>;

interface MemoryRemovalSuggestion {
  id: string;
  rationale: string;
}

interface MemoryReviewSuggestion {
  finding: "missed" | "incorrect" | "helpful";
  memory_id: string | null;
  rationale: string;
  recommended_action: string | null;
}

export interface ConventionUpdateSuggestion {
  target_file: string;
  section_heading: string;
  content: string;
  rationale: string;
}

export interface MemorySuggestions {
  episode_summary?: MemoryEpisodeSummary | null;
  candidate_audit: MemoryCandidateAudit[];
  add: MemorySuggestion[];
  update: MemoryUpdateSuggestion[];
  remove: MemoryRemovalSuggestion[];
  convention_updates: ConventionUpdateSuggestion[];
  memory_review?: MemoryReviewSuggestion[];
}

/** Result of the analyzer pass. Provider failures return empty suggestions. */
export interface AnalyzerResult {
  /** Optional eval-harness marker for runner errors; production analyzer omits it. */
  completed?: boolean;
  suggestions: MemorySuggestions;
  /** Optional eval-harness marker for runner errors; production analyzer omits it. */
  failureReason?: string;
  /** Provider/schema failure from the production analyzer. */
  analysisError?: string;
  /** Number of context fetches that returned errors. */
  toolErrorCount: number;
  /** Total context fetches. */
  toolCallCount: number;
}

/** Review feedback submitted by a human reviewer on a PR. */
export interface ReviewFeedback {
  reviewBody: string | null;
  comments: Array<{
    path: string;
    line: number | null;
    body: string;
    author: string;
  }>;
  reviewAuthor: string;
  reviewState: string;
}

// ---------------------------------------------------------------------------
// Analyzer context — closures used to gather bounded context
// ---------------------------------------------------------------------------

export interface PromptSummary {
  promptId: string;
  /** Prompt text, truncated to 500 chars for context efficiency. */
  prompt: string;
  status: string;
  error: string | null;
  createdAt: string;
  /** Null for user-submitted prompts; set for webhook/system-generated prompts. */
  actorUserId: string | null;
  /** Agent name if this was an agent-generated prompt, undefined for user prompts. */
  agent?: string;
}

export interface AnalyzerContext {
  /** Get prompts (user messages + status) for a session. */
  getSessionPrompts: (sessionId: string) => Promise<PromptSummary[]>;

  /** Get events for a session, filtered by promptId and/or types. */
  getSessionEvents: (
    sessionId: string,
    opts: {
      promptId?: string;
      types?: string[];
      limit?: number;
      afterSequence?: number;
    },
  ) => Promise<SessionEvent[]>;

  /** Fetch the PR diff on demand. */
  getPrDiff: () => Promise<string>;

  /** Read a file from the repo's default branch. Returns null if not found. */
  getFileContent: (filePath: string) => Promise<string | null>;

  /** Get all existing memories (id, type, content summary, context_hint). */
  getExistingMemories: () => Promise<AnalyzerMemoryInput[]>;

  /** Read a section from a convention doc file. If section is empty, returns list of headings. */
  getConventionDocSection: (filePath: string, sectionHeading?: string) => Promise<string | null>;

  /** Load memory usage telemetry recorded during the source sessions. */
  getSessionMemoryUsage?: (sessionIds: string[]) => Promise<AnalyzerMemoryUsage[]>;

  /** Load memory-focused findings from Codex/Claude PR reviewers. */
  getSessionMemoryReviewFindings?: (sessionIds: string[]) => Promise<AnalyzerMemoryReviewFinding[]>;

  repoOwner: string;
  repoName: string;
  sessionIds: string[];
  prNumber: number;
  prUrl: string;
  prTitle?: string | null;
  prBody?: string | null;
}

interface AnalyzerMemoryUsage {
  sessionId: string;
  promptId: string;
  memoryId: string;
  source: string;
  explanation: string | null;
  expectedEffect: string | null;
  observedEffect: string | null;
  reviewOutcome: string | null;
}

export interface AnalyzerMemoryReviewFinding {
  evaluatorModel: string;
  finding: "missed" | "incorrect" | "helpful";
  memoryId: string | null;
  rationale: string;
  expectedEffect: string | null;
  observedEffect: string | null;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const CONVENTION_FILE_DESCRIPTIONS = [...CONVENTION_TARGET_FILES.entries()]
  .map(([file, desc]) => `  - ${file} — ${desc}`)
  .join("\n");

const EPISODE_SYSTEM_PROMPT = `You are a memory analyst for an AI coding agent called Cycloid. A PR generated by the agent was just merged. Your first job is to summarize the merged PR as a sourced memory episode.

Focus on what happened, what changed, which subsystems were touched, what the user/reviewer taught the agent, which memories were available or used, and what durable lesson may exist. Do not create memories in this step.`;

const CANDIDATE_SYSTEM_PROMPT = `You are a memory analyst for an AI coding agent called Cycloid. A PR generated by the agent was just merged. Your job: refine the episode into lane-specific repo-memory candidates and determine if any should become durable memories.

The key question for every potential memory is: **"Next time this topic comes up, how should the agent handle it?"** If you can't answer that clearly, there's no memory worth creating.

## Your process

1. Read the episode summary and source context. Look for:
   - Course corrections ("no, do it this way instead")
   - Steering ("use the existing helper, don't write a new one")
   - Preferences ("we prefer X over Y in this codebase")
   These user interventions are HIGH-VALUE memory signals — they tell you what the agent should do differently next time.
2. Consider exactly one candidate for each lane: strategic, tactical, gotcha, and no_memory.
3. Evaluate each lane against the quality bar and use the audit to explain which single lane, if any, best captures the durable lesson.
4. Check existing memories to avoid duplicates.
5. Before creating any memory, ask whether the pattern is already obvious from reading the diff or existing docs. If someone opening the file would immediately understand the pattern, it's NOT a memory.
6. Every selected strategic/tactical/gotcha lane must produce a corresponding add/update/remove entry. If you are not emitting a memory/change for that lane, mark it selected=false and explain the rejection reason.
7. Bias hard toward no_memory. Return empty add/update/remove/convention arrays when nothing stands out after reviewing the provided context, but still include the candidate audit.

## Memory framing — "next time, do it this way"

Every memory must answer: **"Next time the agent encounters this kind of situation, what should it do?"**

Frame memories as forward-looking guidance, not backward-looking descriptions:
- BAD: "The SessionDO text delta buffer has a 50ms debounce window" (describes what exists)
- GOOD: "When adding a new critical persistence handler, always flush the text delta buffer first — the 50ms debounce window means events can be persisted out of order otherwise"

The person reading the memory should immediately know what action to take. If they have to read the code to understand what the memory means, it's too vague. If they'd figure it out by reading the code anyway, the memory is redundant.

## Memory lanes

- strategic: durable repo direction, subsystem boundary, source of truth, ownership model, or architecture tradeoff.
- tactical: reusable implementation pattern across similar future work.
- gotcha: narrow, surprising failure mode with a concrete safer behavior. Select gotcha when the specific trigger is what will prevent future failure, even if a broader strategic/tactical memory is also selected.
- no_memory: why this episode should not produce repo memory.

Descriptive context is allowed when it explains why this repo works this way. Reject function-level descriptions.

## STRONG FILTER — every selected memory must pass ALL of these

1. **Not obvious from the code.** Would someone who reads the relevant source file still miss this? If the code is self-documenting on this point, do NOT create a memory.
2. **Reusable.** Does this pattern come up across future work, not just in one file? Strategic/tactical memories should be broadly applicable. Gotchas may have narrow triggers when the failure mode is surprising, costly, or easy to repeat; write the trigger clearly instead of generalizing it away.
3. **Not already captured.** Check existing memories and conventions first.
4. **Genuinely surprising.** Would a competent engineer new to this codebase be surprised by this? Standard engineering practice is not a memory.
5. **Actionable.** The memory must tell someone what TO DO or what NOT TO DO. Descriptive memories ("this function does X") are useless.

## BAD memories — do NOT create these

- Describing what a function does or its parameters (that's what code and docstrings are for)
- Noting CSS/styling choices, Tailwind classes, UI details
- Restating what's already in docs/*.md conventions
- Documentation-only PRs that merely add, reorganize, clarify, or correct docs/runbooks/repo maps without revealing a reusable future coding behavior outside that document
- Workflow-only or CI-only wiring changes that merely add a job, smoke check, report-only gate, or deploy step without revealing a reusable implementation constraint
- Aspirational process advice contradicted by the PR's actual deploy/provider constraints; memories must describe a safe behavior the repo can actually perform today
- Reviewer or bot comments that only identify local defects in the PR; review feedback is evidence only when it reveals a durable repo pattern the agent would otherwise repeat
- "This file exports X and Y" — visible from reading the file
- Generic advice like "always test your code" or "validate inputs"
- File-specific instructions ("In bridge.ts line 42, do X") — write for the pattern, not the file
- Memories that only apply in one very specific scenario and nowhere else, unless they are gotchas for a high-risk or repeatedly likely trigger such as auth, sandbox/networking, parser precedence, lifecycle ordering, cache invalidation, data loss, or sanitizer/redaction behavior
- Describing the current state of the code without saying what to do about it

## GOOD memories — these ARE worth creating

- "When doing X, always do Y first, because Z will break otherwise" (actionable gotcha with clear next-time guidance)
- "The team prefers A over B — next time this pattern comes up, use A because C" (preference with rationale, captured from user steering)
- "Don't use X in this context — use Y instead, because X triggers Z side effect" (surprising interaction with a clear alternative)
- "When the user says 'do it like we do elsewhere', they mean: check for existing helpers/patterns before writing new code" (behavioral preference from user correction)

Quality gotchas often involve races/order-sensitive lifecycle transitions, credential/auth fail-closed edges, parser/classifier precedence traps, DB/API/provider limits, or sanitizer/redaction holes. Do not drop these just because they are narrow; the narrow trigger is what makes them useful.

Do not collapse a good gotcha into a broader strategic/tactical memory when doing so removes the file/tool/provider/cache/lifecycle trigger that would make the memory recallable. Prefer both: the broader memory for planning and the gotcha for concrete risk.

Adjacent existing memories do not block a new memory when the episode combines two concerns into a new operational rule.

## Per-PR memory budget

Target at most ONE memory per PR in the common case. Emit a second only for an unrecoverable gotcha whose narrow trigger a broader strategic/tactical memory genuinely cannot carry — this is exactly the "prefer both" case above (the broader memory for planning plus the gotcha for concrete risk), and it is the one sanctioned exception to the cap, not a license to pad. This is a soft cap, not a hard limit — nothing downstream counts your entries — so treat it as a strong bias against volume, not a quota to fill.

When two lanes capture the same underlying lesson, do NOT emit both: select the more actionable lane, mark the other selected=false, and set its rejection_reason to \`subsumed_by_<lane>\` (for example \`subsumed_by_gotcha\`). Keep multiple memories only for genuinely distinct concerns, never for two phrasings of one lesson.

## Documentation and maintenance PRs

For docs-only, runbook-only, dependency-only, lockfile-only, and dead-code cleanup PRs, choose no_memory unless the episode exposes a durable rule that will change future implementation behavior, architecture decisions, or verification work across multiple subsystems.

Do not create a memory just because a doc now explains an existing rule. The memory must teach a future agent what to do before or during future work; if the changed doc is the source of truth, prefer no_memory and reference that doc in the audit.

Most single-file docs PRs should select no_memory even when review comments were addressed.

## Convention updates (docs/*.md)

Use this channel ONLY when a pattern should be a permanent rule for ALL future code. Available target files:
${CONVENTION_FILE_DESCRIPTIONS}

When proposing a convention update, match the target doc's existing terse style.

**Token efficiency is critical.** Convention docs are inlined into the agent's system prompt on every session — every word costs tokens across thousands of runs. Write the shortest directive that a competent engineer can follow without ambiguity. Prefer single-sentence bullets over multi-sentence paragraphs. Never add background context, motivation, or examples that the target audience doesn't need to act correctly. If an existing bullet already covers the intent, propose a surgical edit to that bullet rather than appending a new one.

## Output

Most reviews yield 0-1 memories. Being conservative is correct — a memory that doesn't pass the filter is worse than no memory at all. Empty arrays are a perfectly valid (and common) result.

Also review memory usage quality:
- missed: the agent should have used an existing memory but did not.
- incorrect: the agent used a memory that was stale, wrong, or harmful.
- helpful: the agent used a memory in a way that materially improved the outcome.
Only include memory_review findings backed by the transcript/reviewer evidence.

Content must be under ${MEMORY_CONTENT_MAX_LENGTH} characters per memory/update.

New and updated memories use the Memory 2.0 substrate. Choose fields deliberately:
- memory_type: factual, interaction, or action.
- action_type: procedure, trigger, execution, or outcome for action memories; null otherwise.
- level: strategic, tactical, or gotcha.
- primitive must match memory_type: factual uses entity/artifact/claim/assumption; interaction uses decision/commitment/conflict; action uses procedure/trigger/execution/outcome/gotcha.
- Legacy display type is derived by the system; do not rely on type=gotcha to classify a memory.
- engineering_domains must be one or more of: ${ENGINEERING_DOMAINS.join(", ")}.
- confidence should usually be medium unless review/user evidence is direct; authority should usually be reviewed.
- enforcement is normally none. Use warn/block only for high-confidence reviewed/source-of-truth action memories with concrete triggers.
- triggers must be null unless enforcement is warn/block or primitive/action_type is trigger.`;

// ---------------------------------------------------------------------------
// Structured output schema
// ---------------------------------------------------------------------------

const EPISODE_SUMMARY_TOOL: StructuredOutputTool = {
  name: "submit_episode_summary",
  description: "Summarize the merged PR as a sourced memory episode. Do not create memories.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      source_pr: { type: "string" },
      title: { type: "string" },
      change_summary: { type: "string" },
      prompt_summary: { type: "string" },
      review_summary: { type: "string" },
      touched_subsystems: { type: "array", items: { type: "string" } },
      existing_memory_summary: { type: "string" },
      durable_lesson: { type: "string" },
    },
    required: [
      "source_pr",
      "title",
      "change_summary",
      "prompt_summary",
      "review_summary",
      "touched_subsystems",
      "existing_memory_summary",
      "durable_lesson",
    ],
  },
};

const SUBMIT_ANALYSIS_TOOL: StructuredOutputTool = {
  name: "submit_analysis",
  description: "Submit final analysis. Empty arrays are valid and expected when nothing passes the memory filter.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      episode_summary: {
        type: "object",
        additionalProperties: false,
        properties: {
          source_pr: { type: "string" },
          title: { type: "string" },
          change_summary: { type: "string" },
          prompt_summary: { type: "string" },
          review_summary: { type: "string" },
          touched_subsystems: { type: "array", items: { type: "string" } },
          existing_memory_summary: { type: "string" },
          durable_lesson: { type: "string" },
        },
        required: [
          "source_pr",
          "title",
          "change_summary",
          "prompt_summary",
          "review_summary",
          "touched_subsystems",
          "existing_memory_summary",
          "durable_lesson",
        ],
      },
      candidate_audit: {
        type: "array",
        description:
          "Exactly one audit entry for each lane: strategic, tactical, gotcha, and no_memory. Mark selected=true only for selected candidate lanes. When a lane is dropped because another selected lane already covers the same lesson, set rejection_reason to subsumed_by_<lane> (e.g. subsumed_by_gotcha).",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            lane: { type: "string", enum: MEMORY_CANDIDATE_LANES },
            lesson: { type: "string" },
            evidence: { type: "string" },
            selected: { type: "boolean" },
            rejection_reason: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
          required: ["lane", "lesson", "evidence", "selected", "rejection_reason"],
        },
      },
      add: {
        type: "array",
        description: "New memories to add",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            memory_type: { type: "string", enum: [...MEMORY_TYPES] },
            action_type: { anyOf: [{ type: "string", enum: [...MEMORY_ACTION_TYPES] }, { type: "null" }] },
            level: { type: "string", enum: [...MEMORY_LEVELS] },
            primitive: { type: "string", enum: [...MEMORY_PRIMITIVES] },
            engineering_domains: { type: "array", items: { type: "string", enum: [...ENGINEERING_DOMAINS] } },
            subjects: { type: "array", items: { type: "string" } },
            symbols: { type: "array", items: { type: "string" } },
            tags: { type: "array", items: { type: "string" } },
            confidence: { type: "string", enum: [...MEMORY_CONFIDENCES] },
            authority: { type: "string", enum: [...MEMORY_AUTHORITIES] },
            enforcement: { type: "string", enum: [...MEMORY_ENFORCEMENTS] },
            triggers: {
              anyOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    tools: { type: "array", items: { type: "string" } },
                    path_globs: { type: "array", items: { type: "string" } },
                    command_patterns: { type: "array", items: { type: "string" } },
                    forbidden_patterns: { type: "array", items: { type: "string" } },
                    mcp_tools: { type: "array", items: { type: "string" } },
                  },
                  required: ["tools", "path_globs", "command_patterns", "forbidden_patterns", "mcp_tools"],
                },
                { type: "null" },
              ],
            },
            supersedes: { type: "array", items: { type: "string" } },
            contradicts: { type: "array", items: { type: "string" } },
            content: {
              type: "string",
              description: "The memory content: pattern-level, broadly applicable, actionable",
            },
            context_hint: {
              type: "string",
              description: "When this memory is relevant; describe the general pattern, not a specific file.",
            },
            referenced_files: {
              type: "array",
              items: { type: "string" },
              description: "Example files where this applies",
            },
            rationale: { type: "string", description: "Why this passes the strong filter" },
          },
          required: [
            "memory_type",
            "action_type",
            "level",
            "primitive",
            "engineering_domains",
            "subjects",
            "symbols",
            "tags",
            "confidence",
            "authority",
            "enforcement",
            "triggers",
            "supersedes",
            "contradicts",
            "content",
            "context_hint",
            "referenced_files",
            "rationale",
          ],
        },
      },
      update: {
        type: "array",
        description: "Existing memories to update",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", description: "ID of existing memory to update" },
            semantic_update: {
              description:
                "Set to null for content/context-only updates. Use an object only when deliberately changing semantic metadata.",
              anyOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    memory_type: { type: "string", enum: [...MEMORY_TYPES] },
                    action_type: { anyOf: [{ type: "string", enum: [...MEMORY_ACTION_TYPES] }, { type: "null" }] },
                    level: { type: "string", enum: [...MEMORY_LEVELS] },
                    primitive: { type: "string", enum: [...MEMORY_PRIMITIVES] },
                    engineering_domains: { type: "array", items: { type: "string", enum: [...ENGINEERING_DOMAINS] } },
                    subjects: { type: "array", items: { type: "string" } },
                    symbols: { type: "array", items: { type: "string" } },
                    tags: { type: "array", items: { type: "string" } },
                    confidence: { type: "string", enum: [...MEMORY_CONFIDENCES] },
                    authority: { type: "string", enum: [...MEMORY_AUTHORITIES] },
                    enforcement: { type: "string", enum: [...MEMORY_ENFORCEMENTS] },
                    triggers: {
                      anyOf: [
                        {
                          type: "object",
                          additionalProperties: false,
                          properties: {
                            tools: { type: "array", items: { type: "string" } },
                            path_globs: { type: "array", items: { type: "string" } },
                            command_patterns: { type: "array", items: { type: "string" } },
                            forbidden_patterns: { type: "array", items: { type: "string" } },
                            mcp_tools: { type: "array", items: { type: "string" } },
                          },
                          required: ["tools", "path_globs", "command_patterns", "forbidden_patterns", "mcp_tools"],
                        },
                        { type: "null" },
                      ],
                    },
                    supersedes: { type: "array", items: { type: "string" } },
                    contradicts: { type: "array", items: { type: "string" } },
                  },
                  required: [
                    "memory_type",
                    "action_type",
                    "level",
                    "primitive",
                    "engineering_domains",
                    "subjects",
                    "symbols",
                    "tags",
                    "confidence",
                    "authority",
                    "enforcement",
                    "triggers",
                    "supersedes",
                    "contradicts",
                  ],
                },
                { type: "null" },
              ],
            },
            content: { type: "string" },
            context_hint: { type: "string" },
            referenced_files: { type: "array", items: { type: "string" } },
            rationale: { type: "string", description: "Why this update is needed" },
          },
          required: ["id", "semantic_update", "content", "context_hint", "referenced_files", "rationale"],
        },
      },
      remove: {
        type: "array",
        description: "Existing memories to remove",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", description: "ID of memory to remove" },
            rationale: { type: "string", description: "Why this memory is no longer valid" },
          },
          required: ["id", "rationale"],
        },
      },
      convention_updates: {
        type: "array",
        description: "Updates to convention docs: permanent rules for future code",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            target_file: { type: "string", description: "Doc path, for example docs/conventions.md" },
            section_heading: { type: "string", description: "Exact heading from the doc" },
            content: {
              type: "string",
              description: "Minimal directive convention text; single-sentence bullet preferred.",
            },
            rationale: { type: "string", description: "Why this is a permanent rule" },
          },
          required: ["target_file", "section_heading", "content", "rationale"],
        },
      },
      memory_review: {
        type: "array",
        description: "Findings about whether memory usage was missed, incorrect, or meaningfully helpful.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            finding: { type: "string", enum: ["missed", "incorrect", "helpful"] },
            memory_id: { anyOf: [{ type: "string" }, { type: "null" }] },
            rationale: { type: "string" },
            recommended_action: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
          required: ["finding", "memory_id", "rationale", "recommended_action"],
        },
      },
    },
    required: ["episode_summary", "candidate_audit", "add", "update", "remove", "convention_updates", "memory_review"],
  },
};

// ---------------------------------------------------------------------------
// Analyzer entry point
// ---------------------------------------------------------------------------

const EMPTY_RESULT: MemorySuggestions = {
  episode_summary: null,
  candidate_audit: [],
  add: [],
  update: [],
  remove: [],
  convention_updates: [],
  memory_review: [],
};
const MEMORY_AGENT_STAGE_TIMEOUT_MS = Math.floor(MEMORY_AGENT_TOTAL_TIMEOUT_MS / 2);

function emptyFallbackResult(toolCallCount: number, toolErrorCount: number, analysisError: string): AnalyzerResult {
  return { suggestions: EMPTY_RESULT, toolCallCount, toolErrorCount, analysisError };
}

export async function analyzeSessionForMemories(
  apiKey: string,
  reviewFeedback: ReviewFeedback,
  context: AnalyzerContext,
  log: Logger,
): Promise<AnalyzerResult> {
  const startTime = Date.now();
  let toolCallCount = 0;
  let toolErrorCount = 0;

  const prefetchedPrompts = new Map<string, PromptSummary[]>();
  for (const sessionId of context.sessionIds) {
    toolCallCount++;
    try {
      const prompts = await context.getSessionPrompts(sessionId);
      prefetchedPrompts.set(sessionId, prompts);
    } catch (err) {
      toolErrorCount++;
      log.warn({ error: String(err), sessionId }, "Failed to pre-fetch session prompts");
    }
  }

  toolCallCount += 2 + (context.getSessionMemoryUsage ? 1 : 0) + (context.getSessionMemoryReviewFindings ? 1 : 0);
  const [existingMemories, prDiff, memoryUsage, memoryReviewFindings] = await Promise.all([
    context
      .getExistingMemories()
      .then((value) => value)
      .catch((err) => {
        toolErrorCount++;
        log.warn({ error: String(err) }, "Failed to load existing memories for analysis");
        return [];
      }),
    context
      .getPrDiff()
      .then((value) => value)
      .catch((err) => {
        toolErrorCount++;
        log.warn({ error: String(err) }, "Failed to load PR diff for memory analysis");
        return "";
      }),
    context.getSessionMemoryUsage
      ? context
          .getSessionMemoryUsage(context.sessionIds)
          .then((value) => value)
          .catch((err) => {
            toolErrorCount++;
            log.warn({ error: String(err) }, "Failed to load memory usage context");
            return [];
          })
      : Promise.resolve([]),
    context.getSessionMemoryReviewFindings
      ? context
          .getSessionMemoryReviewFindings(context.sessionIds)
          .then((value) => value)
          .catch((err) => {
            toolErrorCount++;
            log.warn({ error: String(err) }, "Failed to load memory reviewer findings");
            return [];
          })
      : Promise.resolve([]),
  ]);

  try {
    const analysisPrompt = buildAnalysisPrompt(
      reviewFeedback,
      context,
      prefetchedPrompts,
      existingMemories,
      prDiff,
      memoryUsage,
      memoryReviewFindings,
    );
    const rawEpisode = await queryPlatformStructuredOutput(
      {
        ARCANIST_OPENAI_API_KEY: apiKey,
      },
      {
        model: MEMORY_AGENT_MODEL,
        reasoningEffort: GPT54_MINI_SIDECAR_REASONING_EFFORT,
        tool: EPISODE_SUMMARY_TOOL,
        systemPrompt: EPISODE_SYSTEM_PROMPT,
        userPrompt: analysisPrompt,
        maxTokens: MEMORY_AGENT_MAX_TOKENS_PER_TURN,
        timeoutMs: MEMORY_AGENT_STAGE_TIMEOUT_MS,
        serviceTier: OpenAIServiceTier.Flex,
        strictErrors: true,
        retry: { maxAttempts: 3 },
        spanName: "memory.episode_summary",
      },
      {
        subsystem: "memory",
        callType: "memory_episode_summary",
        phase: "background",
        sourceId: `memory_episode_summary:${context.sessionIds.join(",")}:${startTime}`,
        repoOwner: context.repoOwner,
        repoName: context.repoName,
      },
      { logger: log },
    );
    const episodeSummary = normalizeEpisodeSummary(rawEpisode, context);

    const raw = await queryPlatformStructuredOutput(
      {
        ARCANIST_OPENAI_API_KEY: apiKey,
      },
      {
        model: MEMORY_AGENT_MODEL,
        reasoningEffort: GPT54_MINI_SIDECAR_REASONING_EFFORT,
        tool: SUBMIT_ANALYSIS_TOOL,
        systemPrompt: CANDIDATE_SYSTEM_PROMPT,
        userPrompt: buildCandidatePrompt(episodeSummary, analysisPrompt),
        maxTokens: MEMORY_AGENT_MAX_TOKENS_PER_TURN,
        timeoutMs: MEMORY_AGENT_STAGE_TIMEOUT_MS,
        serviceTier: OpenAIServiceTier.Flex,
        strictErrors: true,
        retry: { maxAttempts: 3 },
        spanName: "memory.analysis",
      },
      {
        subsystem: "memory",
        callType: "memory_analysis",
        phase: "background",
        sourceId: `memory_analysis:${context.sessionIds.join(",")}:${startTime}`,
        repoOwner: context.repoOwner,
        repoName: context.repoName,
      },
      { logger: log },
    );

    const suggestions = parseSubmission(raw, log, episodeSummary);
    log.info(
      {
        latencyMs: Date.now() - startTime,
        toolCallCount,
        toolErrorCount,
        candidateAuditCounts: countCandidateAuditByLane(suggestions.candidate_audit, MEMORY_CANDIDATE_LANES),
        selectedLanes: suggestions.candidate_audit.filter((entry) => entry.selected).map((entry) => entry.lane),
      },
      "Memory analysis structured output completed",
    );
    return {
      suggestions,
      toolCallCount,
      toolErrorCount,
    };
  } catch (err) {
    const analysisError = String(err);
    log.warn({ error: analysisError, latencyMs: Date.now() - startTime }, "Memory analysis failed");
    return emptyFallbackResult(toolCallCount, toolErrorCount, analysisError);
  }
}

// ---------------------------------------------------------------------------
// Bounded context prompt
// ---------------------------------------------------------------------------

function buildAnalysisPrompt(
  feedback: ReviewFeedback,
  ctx: AnalyzerContext,
  prefetchedPrompts: Map<string, PromptSummary[]>,
  existingMemories: AnalyzerMemoryInput[],
  prDiff: string,
  memoryUsage: AnalyzerMemoryUsage[],
  memoryReviewFindings: AnalyzerMemoryReviewFinding[],
): string {
  const lines: string[] = [
    `Repository: ${ctx.repoOwner}/${ctx.repoName}`,
    `PR: #${ctx.prNumber} (${ctx.prUrl})`,
    `PR title: ${ctx.prTitle?.trim() || "(unknown)"}`,
    `PR body: ${truncatePromptText(ctx.prBody?.trim() || "(empty)", 2_000)}`,
    `Sessions: ${ctx.sessionIds.join(", ")}`,
    "",
  ];

  // Session prompts — pre-fetched so the agent can analyze immediately
  for (const [sessionId, prompts] of prefetchedPrompts) {
    if (prompts.length === 0) continue;
    lines.push(`## Session Prompts (${sessionId})`);
    for (const p of prompts) {
      const statusTag = p.status !== "completed" ? ` [${p.status}]` : "";
      const errorTag = p.error ? ` ERROR: ${p.error}` : "";
      const agentTag = p.agent ? ` (agent: ${p.agent})` : "";
      lines.push(`- ${p.prompt}${statusTag}${errorTag}${agentTag}`);
    }
    lines.push("");
  }

  // Review comments are supplementary context (may be empty for PRs merged without review)
  if (feedback.comments.length > 0) {
    lines.push("## Review Comments on PR");
    for (const group of groupReviewComments(feedback.comments)) {
      lines.push(`### ${group.path}`);
      for (const c of group.comments) {
        const loc = c.line !== null ? `${c.path}:${c.line}` : c.path;
        lines.push(`- **${loc}** (@${c.author}): ${truncatePromptText(c.body.trim(), 1_000)}`);
      }
    }
    lines.push("");
  }

  const changedPaths = extractChangedPathsFromDiff(prDiff);
  const touchedSubsystems = summarizeTouchedSubsystems(changedPaths);
  if (touchedSubsystems.length > 0) {
    lines.push("## Touched Subsystems");
    for (const subsystem of touchedSubsystems) lines.push(`- ${subsystem}`);
    if (changedPaths.length > 0) {
      lines.push(`Changed files: ${changedPaths.slice(0, 80).join(", ")}`);
    }
    lines.push("");
  }

  if (existingMemories.length > 0) {
    lines.push("## Existing Memories");
    for (const m of existingMemories.slice(0, 200)) {
      const files = m.referenced_files ? ` files=${m.referenced_files}` : "";
      lines.push(`- [${m.id}] (${m.type}) ${m.context_hint}: ${truncatePromptText(m.content, 500)}${files}`);
    }
    lines.push("");
  }

  if (memoryUsage.length > 0) {
    lines.push("## Memory Usage During Sessions");
    for (const usage of memoryUsage.slice(0, 100)) {
      const outcome = usage.reviewOutcome ? ` outcome=${usage.reviewOutcome}` : "";
      const reason = usage.explanation ? ` reason=${usage.explanation.slice(0, 300)}` : "";
      const effect = usage.expectedEffect ? ` expected=${usage.expectedEffect.slice(0, 300)}` : "";
      const observed = usage.observedEffect ? ` observed=${usage.observedEffect.slice(0, 300)}` : "";
      lines.push(
        `- ${usage.sessionId}/${usage.promptId}: [${usage.memoryId}] source=${usage.source}${outcome}${reason}${effect}${observed}`,
      );
    }
    lines.push("");
  }

  if (memoryReviewFindings.length > 0) {
    lines.push("## Reviewer Memory Findings");
    for (const finding of memoryReviewFindings.slice(0, 100)) {
      const memory = finding.memoryId ? `[${finding.memoryId}]` : "[no memory id]";
      const expected = finding.expectedEffect ? ` expected=${finding.expectedEffect.slice(0, 300)}` : "";
      const observed = finding.observedEffect ? ` observed=${finding.observedEffect.slice(0, 300)}` : "";
      lines.push(
        `- ${finding.evaluatorModel}: ${finding.finding} ${memory}: ${finding.rationale.slice(0, 500)}${expected}${observed}`,
      );
    }
    lines.push("");
  }

  if (prDiff.trim().length > 0) {
    lines.push("## PR Diff");
    lines.push(prDiff.slice(0, 40_000));
    lines.push("");
  }

  lines.push(
    "---",
    "",
    "This PR was just merged. The session prompts above show the user's messages and any course corrections. Review comments (if any) provide additional context.",
    "",
    "Look for: user corrections, steering, preferences, failed prompts, and surprising patterns.",
    "Return empty arrays when nothing passes the strong filter.",
  );

  return lines.join("\n");
}

function buildCandidatePrompt(episode: MemoryEpisodeSummary, sourceContext: string): string {
  return [
    "## Episode Summary",
    JSON.stringify(episode, null, 2),
    "",
    "## Source Context",
    sourceContext,
    "",
    "---",
    "",
    "Generate candidate_audit entries for strategic, tactical, gotcha, and no_memory.",
    "If selecting strategic/tactical/gotcha lanes, add/update/remove outputs must include a corresponding memory/change for each selected lane. If no memory/change is emitted for a lane, mark that lane selected=false.",
    "Strategic/tactical/gotcha lanes are not mutually exclusive. Keep useful gotchas when their narrow trigger would help recall a concrete risk that a broader memory would not reliably surface.",
    "Prefer no_memory for documentation-only, dependency-only, lockfile-only, dead-code cleanup, and local maintenance PRs unless they reveal a durable rule that changes future implementation behavior across multiple subsystems.",
    "Reviewer/bot comments are not enough by themselves; they must expose a reusable repo pattern that is not already obvious from the changed file or existing docs.",
  ].join("\n");
}

function normalizeEpisodeSummary(raw: unknown, ctx: AnalyzerContext): MemoryEpisodeSummary {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    source_pr: stringValue(record.source_pr, ctx.prUrl),
    title: stringValue(record.title, ctx.prTitle ?? ""),
    change_summary: stringValue(record.change_summary, ""),
    prompt_summary: stringValue(record.prompt_summary, ""),
    review_summary: stringValue(record.review_summary, ""),
    touched_subsystems: stringArray(record.touched_subsystems),
    existing_memory_summary: stringValue(record.existing_memory_summary, ""),
    durable_lesson: stringValue(record.durable_lesson, ""),
  };
}

function groupReviewComments(comments: ReviewFeedback["comments"]): Array<{
  path: string;
  comments: ReviewFeedback["comments"];
}> {
  const grouped = new Map<string, ReviewFeedback["comments"]>();
  for (const comment of comments) {
    const existing = grouped.get(comment.path) ?? [];
    existing.push(comment);
    grouped.set(comment.path, existing);
  }
  return [...grouped.entries()].map(([path, groupedComments]) => ({ path, comments: groupedComments.slice(0, 20) }));
}

function extractChangedPathsFromDiff(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    if (!line.startsWith("diff --git ")) continue;
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (!match) continue;
    paths.add(match[2]);
  }
  return [...paths].slice(0, 200);
}

function summarizeTouchedSubsystems(paths: string[]): string[] {
  const subsystemCounts = new Map<string, number>();
  for (const path of paths) {
    const parts = path.split("/");
    const subsystem =
      parts[0] === "apps" && parts.length >= 3
        ? `${parts[0]}/${parts[1]}/${parts[2]}`
        : parts[0] === "tests" && parts.length >= 2
          ? `${parts[0]}/${parts[1]}`
          : parts.slice(0, Math.min(parts.length, 2)).join("/");
    subsystemCounts.set(subsystem, (subsystemCounts.get(subsystem) ?? 0) + 1);
  }
  return [...subsystemCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([subsystem, count]) => `${subsystem} (${count} file${count === 1 ? "" : "s"})`);
}

function truncatePromptText(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

// ---------------------------------------------------------------------------
// Submission parsing + validation
// ---------------------------------------------------------------------------

function parseSubmission(input: unknown, log: Logger, fallbackEpisode: MemoryEpisodeSummary): MemorySuggestions {
  const raw = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const episodeSummary = normalizeEpisodeSummary(raw.episode_summary, {
    repoOwner: "",
    repoName: "",
    sessionIds: [],
    prNumber: 0,
    prUrl: fallbackEpisode.source_pr,
    prTitle: fallbackEpisode.title,
    prBody: null,
    getSessionPrompts: async () => [],
    getSessionEvents: async () => [],
    getPrDiff: async () => "",
    getFileContent: async () => null,
    getExistingMemories: async () => [],
    getConventionDocSection: async () => null,
  });
  const result: MemorySuggestions = {
    episode_summary: raw.episode_summary && typeof raw.episode_summary === "object" ? episodeSummary : fallbackEpisode,
    candidate_audit: Array.isArray(raw.candidate_audit) ? validateCandidateAudit(raw.candidate_audit) : [],
    add: Array.isArray(raw.add) ? validateAddSuggestions(raw.add) : [],
    update: Array.isArray(raw.update) ? validateUpdateSuggestions(raw.update) : [],
    remove: Array.isArray(raw.remove) ? validateRemoveSuggestions(raw.remove) : [],
    convention_updates: Array.isArray(raw.convention_updates) ? validateConventionUpdates(raw.convention_updates) : [],
    memory_review: Array.isArray(raw.memory_review) ? validateMemoryReview(raw.memory_review) : [],
  };

  // The service layer validates update/remove IDs when applying changes.

  const total =
    result.add.length +
    result.update.length +
    result.remove.length +
    result.convention_updates.length +
    (result.memory_review?.length ?? 0);
  log.info(
    {
      added: result.add.length,
      updated: result.update.length,
      removed: result.remove.length,
      conventions: result.convention_updates.length,
      memoryReview: result.memory_review?.length ?? 0,
      candidateAudit: result.candidate_audit.length,
      candidateAuditCounts: countCandidateAuditByLane(result.candidate_audit, MEMORY_CANDIDATE_LANES),
      selectedLanes: result.candidate_audit.filter((entry) => entry.selected).map((entry) => entry.lane),
    },
    `Memory agent submitted ${total} suggestion(s)`,
  );

  return result;
}

function validateCandidateAudit(raw: unknown[]): MemoryCandidateAudit[] {
  const seen = new Set<MemoryCandidateLane>();
  return raw
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map((entry) => {
      const lane = entry.lane;
      if (!isCandidateLane(lane) || seen.has(lane)) return null;
      seen.add(lane);
      const lesson = typeof entry.lesson === "string" ? entry.lesson.trim() : "";
      const evidence = typeof entry.evidence === "string" ? entry.evidence.trim() : "";
      const selected = entry.selected === true;
      const rejectionReason =
        typeof entry.rejection_reason === "string" && entry.rejection_reason.trim()
          ? entry.rejection_reason.trim()
          : null;
      if (!lesson && !evidence) return null;
      return { lane, lesson, evidence, selected, rejection_reason: selected ? null : rejectionReason };
    })
    .filter((entry): entry is MemoryCandidateAudit => entry !== null);
}

function validateMemoryReview(raw: unknown[]): MemoryReviewSuggestion[] {
  return raw
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map((entry) => {
      const finding = entry.finding;
      if (finding !== "missed" && finding !== "incorrect" && finding !== "helpful") return null;
      const memoryId = typeof entry.memory_id === "string" && entry.memory_id.trim() ? entry.memory_id.trim() : null;
      const rationale = typeof entry.rationale === "string" ? entry.rationale.trim() : "";
      if (!rationale) return null;
      const recommendedAction =
        typeof entry.recommended_action === "string" && entry.recommended_action.trim()
          ? entry.recommended_action.trim()
          : null;
      return { finding, memory_id: memoryId, rationale, recommended_action: recommendedAction };
    })
    .filter((entry): entry is MemoryReviewSuggestion => entry !== null);
}

function validateAddSuggestions(raw: unknown[]): MemorySuggestion[] {
  return raw
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map(normalizeAddSuggestion)
    .filter((entry): entry is MemorySuggestion => entry !== null);
}

function validateUpdateSuggestions(raw: unknown[]): MemoryUpdateSuggestion[] {
  return raw
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map(normalizeUpdateSuggestion)
    .filter((entry): entry is MemoryUpdateSuggestion => entry !== null);
}

function validateRemoveSuggestions(raw: unknown[]): MemoryRemovalSuggestion[] {
  return raw
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .filter((entry) => typeof entry.id === "string" && typeof entry.rationale === "string")
    .map((entry) => ({
      id: entry.id as string,
      rationale: entry.rationale as string,
    }));
}

function normalizeAddSuggestion(entry: Record<string, unknown>): MemorySuggestion | null {
  if (
    typeof entry.content !== "string" ||
    typeof entry.context_hint !== "string" ||
    !Array.isArray(entry.referenced_files) ||
    typeof entry.rationale !== "string"
  ) {
    return null;
  }
  const referencedFiles = stringArray(entry.referenced_files);
  const semantic = normalizeMemory2Fields(entry, legacyTypeFromEntry(entry), referencedFiles);
  if (!semantic) return null;
  return {
    type: deriveLegacyType(semantic),
    ...semantic,
    content: entry.content.slice(0, MEMORY_CONTENT_MAX_LENGTH),
    context_hint: entry.context_hint,
    referenced_files: referencedFiles,
    rationale: entry.rationale,
  };
}

function normalizeUpdateSuggestion(entry: Record<string, unknown>): MemoryUpdateSuggestion | null {
  if (
    typeof entry.id !== "string" ||
    typeof entry.content !== "string" ||
    typeof entry.context_hint !== "string" ||
    !Array.isArray(entry.referenced_files) ||
    typeof entry.rationale !== "string"
  ) {
    return null;
  }
  const referencedFiles = stringArray(entry.referenced_files);
  const legacyType = typeof entry.type === "string" && isLegacyMemoryType(entry.type) ? entry.type : "process";
  const semantic = normalizeUpdateSemanticFields(entry, legacyType, referencedFiles);
  return {
    id: entry.id,
    ...(semantic ?? {}),
    content: entry.content.slice(0, MEMORY_CONTENT_MAX_LENGTH),
    context_hint: entry.context_hint,
    referenced_files: referencedFiles,
    rationale: entry.rationale,
  };
}

function normalizeUpdateSemanticFields(
  entry: Record<string, unknown>,
  legacyType: string,
  referencedFiles: string[],
): MemoryUpdateSemanticFields | null {
  if (hasOwn(entry, "semantic_update")) {
    if (entry.semantic_update === null) return null;
    if (!entry.semantic_update || typeof entry.semantic_update !== "object" || Array.isArray(entry.semantic_update)) {
      return null;
    }
    return normalizeMemory2Fields(entry.semantic_update as Record<string, unknown>, legacyType, referencedFiles);
  }
  return normalizeMemory2Fields(entry, legacyType, referencedFiles, { allowMissing: true });
}

function normalizeMemory2Fields(
  entry: Record<string, unknown>,
  legacyType: string,
  referencedFiles: string[],
  options: { allowMissing?: boolean } = {},
): Omit<MemorySuggestion, "type" | "content" | "context_hint" | "referenced_files" | "rationale"> | null {
  const fallback = semanticDefaultsForSuggestion(legacyType, referencedFiles);
  const hasExplicitSubstrate =
    hasOwn(entry, "memory_type") ||
    hasOwn(entry, "action_type") ||
    hasOwn(entry, "level") ||
    hasOwn(entry, "primitive") ||
    hasOwn(entry, "engineering_domains") ||
    hasOwn(entry, "confidence") ||
    hasOwn(entry, "authority") ||
    hasOwn(entry, "enforcement") ||
    hasOwn(entry, "triggers");
  if (options.allowMissing && !hasExplicitSubstrate) return null;

  const memoryType = enumValueOrFallback(entry, "memory_type", MEMORY_TYPES, fallback.memory_type);
  const level = enumValueOrFallback(entry, "level", MEMORY_LEVELS, fallback.level);
  const primitive = enumValueOrFallback(entry, "primitive", MEMORY_PRIMITIVES, fallback.primitive);
  const confidence = enumValueOrFallback(entry, "confidence", MEMORY_CONFIDENCES, "medium");
  const authority = enumValueOrFallback(entry, "authority", MEMORY_AUTHORITIES, "reviewed");
  const enforcement = enumValueOrFallback(entry, "enforcement", MEMORY_ENFORCEMENTS, "none");
  if (!memoryType || !level || !primitive || !confidence || !authority || !enforcement) return null;

  const actionType = nullableEnumValueOrFallback(entry, "action_type", MEMORY_ACTION_TYPES, fallback.action_type);
  if (actionType === undefined) return null;

  if (hasOwn(entry, "engineering_domains") && !Array.isArray(entry.engineering_domains)) return null;
  const engineeringDomains = enumArray(entry.engineering_domains, ENGINEERING_DOMAINS);
  if (hasOwn(entry, "engineering_domains") && engineeringDomains.length === 0) return null;
  const domains = engineeringDomains.length > 0 ? engineeringDomains : fallback.engineering_domains;
  const triggers = entry.triggers === null || entry.triggers === undefined ? null : normalizeTriggers(entry.triggers);
  if (hasOwn(entry, "triggers") && entry.triggers !== null && !triggers) return null;

  if (!memoryTypePrimitiveMatches(memoryType, primitive)) return null;
  if (memoryType === "action" && !actionType) return null;
  if (memoryType !== "action" && actionType !== null) return null;
  const requiresTriggers =
    primitive === "trigger" || actionType === "trigger" || enforcement === "warn" || enforcement === "block";
  if (requiresTriggers && !triggers) return null;
  if (enforcement === "block" && triggers && !hasBlockingTrigger(triggers)) return null;

  return {
    memory_type: memoryType,
    action_type: actionType,
    level,
    primitive,
    engineering_domains: domains,
    subjects: stringArray(entry.subjects),
    symbols: stringArray(entry.symbols),
    tags: stringArray(entry.tags),
    confidence,
    authority,
    enforcement,
    triggers,
    supersedes: stringArray(entry.supersedes),
    contradicts: stringArray(entry.contradicts),
  };
}

function normalizeTriggers(value: unknown): MemoryTriggers | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    tools: stringArray(record.tools),
    path_globs: stringArray(record.path_globs),
    command_patterns: stringArray(record.command_patterns),
    forbidden_patterns: stringArray(record.forbidden_patterns),
    mcp_tools: stringArray(record.mcp_tools),
  };
}

function hasBlockingTrigger(triggers: MemoryTriggers): boolean {
  return triggers.command_patterns.length > 0 || triggers.forbidden_patterns.length > 0;
}

function memoryTypePrimitiveMatches(memoryType: MemoryType, primitive: MemoryPrimitive): boolean {
  if (memoryType === "factual")
    return primitive === "entity" || primitive === "artifact" || primitive === "claim" || primitive === "assumption";
  if (memoryType === "interaction")
    return primitive === "decision" || primitive === "commitment" || primitive === "conflict";
  return (
    primitive === "procedure" ||
    primitive === "trigger" ||
    primitive === "execution" ||
    primitive === "outcome" ||
    primitive === "gotcha"
  );
}

function legacyTypeFromEntry(entry: Record<string, unknown>): string {
  return typeof entry.type === "string" && isLegacyMemoryType(entry.type) ? entry.type : "process";
}

function deriveLegacyType(input: { memory_type: MemoryType; level: MemoryLevel }): string {
  if (input.level === "gotcha") return "gotcha";
  if (input.level === "strategic" || input.memory_type === "factual") return "architecture";
  return "process";
}

function isCandidateLane(value: unknown): value is MemoryCandidateLane {
  return value === "strategic" || value === "tactical" || value === "gotcha" || value === "no_memory";
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T): T[number] | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value : null;
}

function enumValueOrFallback<const T extends readonly string[]>(
  entry: Record<string, unknown>,
  key: string,
  allowed: T,
  fallback: T[number],
): T[number] | null {
  if (!hasOwn(entry, key)) return fallback;
  return enumValue(entry[key], allowed);
}

function nullableEnumValueOrFallback<const T extends readonly string[]>(
  entry: Record<string, unknown>,
  key: string,
  allowed: T,
  fallback: T[number] | null,
): T[number] | null | undefined {
  if (!hasOwn(entry, key)) return fallback;
  if (entry[key] === null) return null;
  return enumValue(entry[key], allowed) ?? undefined;
}

function enumArray<const T extends readonly string[]>(value: unknown, allowed: T): T[number][] {
  const values = stringArray(value);
  return values.every((entry) => (allowed as readonly string[]).includes(entry)) ? values : [];
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function isLegacyMemoryType(value: string): boolean {
  return value === "convention" || value === "gotcha" || value === "architecture" || value === "process";
}

function hasOwn(entry: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(entry, key);
}

function validateConventionUpdates(raw: unknown[]): ConventionUpdateSuggestion[] {
  return raw
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .filter(
      (entry) =>
        typeof entry.target_file === "string" &&
        CONVENTION_TARGET_FILES.has(entry.target_file as string) &&
        typeof entry.section_heading === "string" &&
        typeof entry.content === "string" &&
        typeof entry.rationale === "string",
    )
    .map((entry) => ({
      target_file: entry.target_file as string,
      section_heading: entry.section_heading as string,
      content: (entry.content as string).slice(0, MEMORY_CONTENT_MAX_LENGTH),
      rationale: entry.rationale as string,
    }));
}
