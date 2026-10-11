import { splitTopLevelSegments } from "../command-classification.js";
import { normalizeToolName } from "../tools/names.js";
import { isRecord } from "../utils/type-guards.js";
import {
  type ActivityEvent,
  type CustomerActivityDetail,
  type CustomerActivityEvent,
  type ToolCallActivityEvent,
} from "./projector.js";

type CustomerActivityCategory = CustomerActivityEvent["category"];
type CustomerActivityStatus = NonNullable<CustomerActivityEvent["status"]>;

type ProjectableActivity = ToolCallActivityEvent | Extract<ActivityEvent, { type: "patch" }>;

type ActivityBucket = {
  category: CustomerActivityCategory;
  promptId?: string;
  items: ProjectableActivity[];
  status: CustomerActivityStatus;
};

const INSPECTION_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "ls",
  "cat",
  "head",
  "tail",
  "find",
  "web_search",
  "web_fetch",
  "lsp",
]);

const CHANGE_TOOLS = new Set(["edit", "write", "notebook_edit"]);
const GIT_TOOLS = new Set(["git_commit", "git_push"]);
const PLAN_TOOLS = new Set(["todowrite"]);
const CUSTOMER_VISIBLE_TIMELINE_EVENTS = new Set([
  "publish_gate.result",
  "verification.result",
  "git.commit",
  "git.push",
  "pr.open",
]);

// Codex wraps every shell call in `/bin/bash -lc "<cmd>"` so its login-shell env
// (PATH, nvm, pyenv) is loaded. The wrapper is boilerplate on every bash chip,
// so peel it off before the command surfaces in the activity timeline. This
// also lets `classifyBashCommand` see the real leading token (e.g. `rg`, `git`).
function stripBashWrapper(command: string): string {
  const trimmed = command.trim();
  const prefix = trimmed.match(/^(?:\/bin\/)?bash\s+-lc\s+/);
  if (!prefix) return command;
  const remainder = trimmed.slice(prefix[0].length);
  if (remainder.length === 0) return command;
  const quote = remainder[0];
  if ((quote === '"' || quote === "'") && remainder.length >= 2 && remainder.endsWith(quote)) {
    return remainder.slice(1, -1);
  }
  return remainder;
}

function rawCommandFromTool(event: ToolCallActivityEvent): string {
  const command = event.input?.command;
  return typeof command === "string" ? stripBashWrapper(command) : "";
}

// A lint/typecheck/build command counts as verification only when the check tool
// is the LEADING command of a top-level segment (optionally behind env-var
// assignments or a package-manager runner). Matching the bare word anywhere tagged
// inspection commands whose paths/args merely contain these tokens (`cat build.log`,
// `grep 'lint' pkg.json`, `cat tsc-errors.txt`) as "verify", reporting checks that
// never ran. Segments are split quote-aware via the shared splitter so a token
// inside a quoted argument (`grep 'foo && tsc' pkg.json`) never leads a segment.
const VERIFY_CHECK_SEGMENT_PATTERNS: RegExp[] = [
  // npm/pnpm/yarn/bun run lint|typecheck|build, incl. workspace flags and env-var prefixes.
  /^(?:\w+=\S+\s+)*(?:npm|pnpm|yarn|bun)\s+(?:(?:--workspace|-w)(?:=|\s+)\S+\s+)?(?:run\s+)?(?:lint|typecheck|type-check|build)\b/,
  // go build/vet, cargo build/check.
  /^(?:\w+=\S+\s+)*(?:go\s+(?:build|vet)|cargo\s+(?:build|check))\b/,
  // Standalone type checkers / linters, optionally via npx.
  /^(?:\w+=\S+\s+)*(?:npx\s+)?(?:tsc|eslint|prettier|biome)\b/,
];

function isVerifyCheckCommand(lower: string): boolean {
  return splitTopLevelSegments(lower).some((segment) =>
    VERIFY_CHECK_SEGMENT_PATTERNS.some((pattern) => pattern.test(segment)),
  );
}

function classifyBashCommand(command: string): CustomerActivityCategory {
  const lower = command.toLowerCase();
  if (!lower) return "command";
  // Only real test-runner invocations count as verification. A bare `test` word
  // would tag inspection/file commands (`cat src/test.txt`, `cd test`, `mkdir
  // test`) as "verify" in the customer transcript, reporting checks that never ran.
  if (
    /\b(vitest|jest|pytest|go test|cargo test|bun test)\b/.test(lower) ||
    /(?:^|\|\||&&|;|\s)(npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/.test(lower)
  ) {
    return "verify";
  }
  if (isVerifyCheckCommand(lower)) return "verify";
  if (/^git\b/.test(lower)) return "git";
  if (/^(sed|awk|rg|grep|find|ls|cat|head|tail)\b/.test(lower)) return "inspect";
  return "command";
}

function classifyActivity(event: ActivityEvent): CustomerActivityCategory | null {
  if (event.type === "patch") return "change";
  if (event.type !== "tool_call") return null;

  const tool = normalizeToolName(event.tool);
  if (tool === "agent" || tool === "task" || tool === "spawn_agent" || event.input?.prompt) {
    return null;
  }
  if (tool === "bash") return classifyBashCommand(rawCommandFromTool(event));
  if (INSPECTION_TOOLS.has(tool)) return "inspect";
  if (CHANGE_TOOLS.has(tool)) return "change";
  if (GIT_TOOLS.has(tool)) return "git";
  if (PLAN_TOOLS.has(tool)) return "plan";
  if (tool === "batch") return "command";
  return "command";
}

const MAX_DETAILS = 5;
const MAX_DETAIL_LENGTH = 120;

// Detail content surfaces in the customer-facing transcript. Tool inputs can
// occasionally carry credentials embedded in shell args, URL basic-auth, env
// var assignments, or provider token formats. Scrub the highest-confidence
// patterns before the value reaches the UI. Lower-confidence heuristics are
// intentionally omitted to avoid false positives that hide real activity.
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // scheme://user:password@host  ->  scheme://[redacted]@host
  [/([a-zA-Z][a-zA-Z0-9+.\-]*:\/\/)[^/@\s'"`]+:[^/@\s'"`]+@/g, "$1[redacted]@"],
  // Non-DB schemes whose passwords may contain a literal "/" (e.g. amqp/ftp); the
  // generic rule above stops at "/", so scope-match these and allow "/" in creds.
  // Username excludes "/" and password excludes "?"/"#" so a credential-free
  // `host:port/path?x@y` is not mistaken for `user:pass@`.
  [/\b(amqps?|ftp|sftp):\/\/[^/\s:@'"`]+:[^@\s?#'"`]+@/gi, "$1://[redacted]@"],
  // Provider-specific token formats
  [/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, "[redacted-gh-token]"],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, "[redacted-gh-token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-aws-key]"],
  [/\bASIA[0-9A-Z]{16}\b/g, "[redacted-aws-key]"],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_\-]{20,}\b/g, "[redacted-api-key]"],
  [/\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g, "[redacted-stripe-key]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "[redacted-slack-token]"],
  [/\bAIza[0-9A-Za-z_\-]{30,}\b/g, "[redacted-google-key]"],
  // JWT (three base64url segments)
  [/\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g, "[redacted-jwt]"],
  // HTTP auth schemes followed by a credential
  [/\b(?:Bearer|Basic|Token|token|bearer|basic)\s+[A-Za-z0-9._\-+/=]{12,}/g, "[redacted-auth]"],
  // Shell env-var assignments where the name suggests a secret
  [
    /\b([A-Z][A-Z0-9_]*?(?:TOKEN|SECRET|API[_-]?KEY|PASSWORD|PASSWD|PWD|CREDENTIAL|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)[A-Z0-9_]*)=(?:'[^']*'|"[^"]*"|\S+)/g,
    "$1=[redacted]",
  ],
  // Common credential keys in URL query strings or curl args
  [/([?&](?:token|api[_-]?key|access[_-]?token|secret|password|pwd|auth)=)([^&\s'"`]+)/gi, "$1[redacted]"],
];

function redactSecrets(value: string): string {
  let out = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function normalizeDetail(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateDetail(value: string): string {
  if (value.length <= MAX_DETAIL_LENGTH) return value;
  return `${value.slice(0, MAX_DETAIL_LENGTH - 1)}…`;
}

function firstString(input: Record<string, unknown> | undefined, keys: string[]): string {
  if (!input) return "";
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function stripToolPrefix(summary: string, tool: string): string {
  const trimmedSummary = summary.trim();
  const trimmedTool = tool.trim();
  if (!trimmedSummary || !trimmedTool) return trimmedSummary;

  const summaryLower = trimmedSummary.toLowerCase();
  const toolLower = trimmedTool.toLowerCase();
  if (summaryLower === toolLower) return "";
  if (summaryLower.startsWith(`${toolLower} `)) return trimmedSummary.slice(trimmedTool.length + 1).trimStart();
  return trimmedSummary;
}

function detailFromToolCall(event: ToolCallActivityEvent): CustomerActivityDetail {
  const tool = normalizeToolName(event.tool);
  if (tool === "bash") {
    const command = rawCommandFromTool(event);
    return { tool: "bash", content: command || event.summary || "bash" };
  }
  if (CHANGE_TOOLS.has(tool) || INSPECTION_TOOLS.has(tool)) {
    const path = firstString(event.input, ["file_path", "filePath", "path", "notebook_path", "notebookPath"]);
    if (path) return { tool, content: path };
    const pattern = firstString(event.input, ["pattern", "query", "url"]);
    if (pattern) return { tool, content: pattern };
  }
  if (GIT_TOOLS.has(tool)) {
    const message = firstString(event.input, ["message", "branch", "remote"]);
    return { tool, content: message || tool };
  }
  if (PLAN_TOOLS.has(tool)) {
    const todos = event.input?.todos;
    if (Array.isArray(todos)) {
      const inProgress = todos.find((todo) => isRecord(todo) && todo.status === "in_progress");
      if (isRecord(inProgress) && typeof inProgress.content === "string") {
        return { tool, content: inProgress.content };
      }
    }
    return { tool, content: "Updated plan" };
  }
  const genericDetail = firstString(event.input, [
    "file_path",
    "filePath",
    "path",
    "pattern",
    "query",
    "traceId",
    "trace_id",
    "url",
    "command",
  ]);
  if (genericDetail) return { tool: tool || "step", content: genericDetail };

  const summary = stripToolPrefix(event.summary ?? "", tool);
  if (summary.length > 0) {
    return { tool: tool || "step", content: summary };
  }
  return { tool: tool || "step", content: tool || "step" };
}

function detailsFromPatch(event: Extract<ActivityEvent, { type: "patch" }>): CustomerActivityDetail[] {
  return event.files
    .filter((file): file is string => typeof file === "string" && file.length > 0)
    .map((file) => ({ tool: "patch", content: file }));
}

function collectDetails(items: ProjectableActivity[]): { details: CustomerActivityDetail[]; overflow: number } {
  const seen = new Set<string>();
  const details: CustomerActivityDetail[] = [];
  let total = 0;

  const push = (raw: CustomerActivityDetail) => {
    const normalized = normalizeDetail(redactSecrets(raw.content));
    if (!normalized) return;
    const key = `${raw.tool}\0${normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    total += 1;
    if (details.length < MAX_DETAILS) {
      details.push({ tool: raw.tool, content: truncateDetail(normalized) });
    }
  };

  for (const item of items) {
    if (item.type === "patch") {
      for (const detail of detailsFromPatch(item)) push(detail);
      continue;
    }
    push(detailFromToolCall(item));
  }

  const overflow = Math.max(0, total - details.length);
  return { details, overflow };
}

function statusRank(status: CustomerActivityStatus): number {
  switch (status) {
    case "error":
      return 3;
    case "running":
      return 2;
    case "completed":
      return 1;
  }
}

function effectiveToolStatus(event: ToolCallActivityEvent): CustomerActivityStatus {
  if (event.toolStatus === "error" && event.failure?.category === "command") {
    return "completed";
  }
  return event.toolStatus ?? "completed";
}

function mergeStatus(current: CustomerActivityStatus, event: ProjectableActivity): CustomerActivityStatus {
  if (event.type === "patch") return current;
  const next = effectiveToolStatus(event);
  return statusRank(next) > statusRank(current) ? next : current;
}

function activityId(bucket: ActivityBucket): string {
  const first = bucket.items[0];
  const last = bucket.items[bucket.items.length - 1];
  return `customer-${bucket.category}-${first?.id ?? "start"}-${last?.id ?? "end"}`;
}

const CATEGORY_LABELS: Record<CustomerActivityCategory, { title: string; verb: string }> = {
  inspect: { title: "Inspected code", verb: "Looked at" },
  change: { title: "Updated files", verb: "Edited" },
  verify: { title: "Ran targeted checks", verb: "Ran" },
  plan: { title: "Updated the work plan", verb: "Updated" },
  git: { title: "Prepared Git changes", verb: "Ran" },
  command: { title: "Ran supporting commands", verb: "Ran" },
};

function plural(count: number, singular: string, pluralValue = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralValue}`;
}

function summarizeBucket(bucket: ActivityBucket, details: CustomerActivityDetail[], overflow: number): string {
  const count = bucket.items.length;
  if (details.length === 0) {
    switch (bucket.category) {
      case "inspect":
        return count === 1 ? "Looked at the project." : `Looked at ${plural(count, "thing")}.`;
      case "change":
        return count === 1 ? "Edited a file." : `Edited ${plural(count, "file")}.`;
      case "verify":
        return count === 1 ? "Ran a check." : `Ran ${plural(count, "check")}.`;
      case "plan":
        return count === 1 ? "Updated the task plan." : `Updated the task plan ${plural(count, "time")}.`;
      case "git":
        return count === 1 ? "Ran a git command." : `Ran ${plural(count, "git command")}.`;
      case "command":
        return count === 1 ? "Ran a command." : `Ran ${plural(count, "command")}.`;
    }
  }
  const verb = CATEGORY_LABELS[bucket.category].verb;
  const head = details[0].content;
  if (details.length === 1 && overflow === 0) {
    return `${verb} ${head}`;
  }
  const extras = details.length - 1 + overflow;
  return `${verb} ${head} (+${extras} more)`;
}

function flushBucket(result: ActivityEvent[], bucket: ActivityBucket | null): void {
  if (!bucket || bucket.items.length === 0) return;
  const { details, overflow } = collectDetails(bucket.items);
  result.push({
    type: "customer_activity",
    id: activityId(bucket),
    category: bucket.category,
    title: CATEGORY_LABELS[bucket.category].title,
    summary: summarizeBucket(bucket, details, overflow),
    status: bucket.status,
    count: bucket.items.length,
    details,
    ...(overflow > 0 ? { overflow } : {}),
    ...(bucket.promptId ? { promptId: bucket.promptId } : {}),
  });
}

function canMerge(bucket: ActivityBucket | null, category: CustomerActivityCategory, promptId?: string): boolean {
  return !!bucket && bucket.category === category && bucket.promptId === promptId && promptId !== undefined;
}

export function projectCustomerActivityEvents(events: ActivityEvent[]): ActivityEvent[] {
  const result: ActivityEvent[] = [];
  let bucket: ActivityBucket | null = null;

  for (const event of events) {
    // The `apply_patch` tool_call is a sandbox-bridge fan-out from a Codex
    // `file_change` item: the same item also emits a `patch` event that
    // already lists each file. Showing both produces a useless duplicate
    // "apply_patch apply_patch" row in the customer transcript. Drop it
    // here while leaving the underlying tool_call intact for trackers
    // (modified-file, behavior signals, span telemetry) that consume it.
    if (event.type === "tool_call" && normalizeToolName(event.tool) === "apply_patch") continue;

    const category = classifyActivity(event);
    if (category) {
      const projectable = event as ProjectableActivity;
      let activeBucket: ActivityBucket | null = bucket;
      if (!canMerge(activeBucket, category, event.promptId)) {
        flushBucket(result, bucket);
        activeBucket = {
          category,
          items: [],
          status: "completed",
          ...(event.promptId ? { promptId: event.promptId } : {}),
        };
        bucket = activeBucket;
      }
      if (!activeBucket) continue;
      activeBucket.items.push(projectable);
      activeBucket.status = mergeStatus(activeBucket.status, projectable);
      continue;
    }

    flushBucket(result, bucket);
    bucket = null;

    if (event.type === "agent_timeline") {
      if (CUSTOMER_VISIBLE_TIMELINE_EVENTS.has(event.eventType)) {
        result.push(event);
      }
      continue;
    }

    if (event.type === "raw_agent_runtime" || event.type === "tool_truncated") {
      continue;
    }
    result.push(event);
  }

  flushBucket(result, bucket);
  return result;
}
