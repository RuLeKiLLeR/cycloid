import { z } from "zod";

import {
  SPAWN_CHILD_SESSION_MAX_PROMPT_LENGTH,
  SPAWN_CHILD_SESSION_MAX_TITLE_LENGTH,
  SPAWN_CHILD_SESSION_REPOSITORY_ID_PATTERN,
} from "../../../../shared/constants/session.js";
import {
  BRAINTRUST_DYNAMIC_TOOL_NAMESPACE,
  BRAINTRUST_GENERATE_PERMALINK_DYNAMIC_TOOL_NAME,
  BRAINTRUST_INFER_SCHEMA_DYNAMIC_TOOL_NAME,
  BRAINTRUST_LIST_PROJECTS_DYNAMIC_TOOL_NAME,
  BRAINTRUST_QUERY_SQL_DYNAMIC_TOOL_NAME,
  BRAINTRUST_SUMMARIZE_EXPERIMENT_DYNAMIC_TOOL_NAME,
} from "./braintrust-dynamic-tool.js";
import { SPAWN_CHILD_SESSION_DYNAMIC_TOOL_NAME } from "./child-session-dynamic-tool.js";
import {
  CLOUDFLARE_DYNAMIC_TOOL_NAMESPACE,
  CLOUDFLARE_QUERY_D1_DYNAMIC_TOOL_NAME,
} from "./cloudflare-d1-dynamic-tool.js";
import {
  COMPANY_MEMORY_REASONING_CHAIN_DYNAMIC_TOOL_NAME,
  COMPANY_MEMORY_RECALL_DYNAMIC_TOOL_NAME,
} from "./company-memory-dynamic-tool.js";
import {
  DATADOG_DYNAMIC_TOOL_NAMESPACE,
  DATADOG_GET_MONITORS_DYNAMIC_TOOL_NAME,
  DATADOG_GET_TRACE_DYNAMIC_TOOL_NAME,
  DATADOG_QUERY_METRICS_DYNAMIC_TOOL_NAME,
  DATADOG_SEARCH_LOGS_DYNAMIC_TOOL_NAME,
} from "./datadog-dynamic-tool.js";
import {
  DESKTOP_CLICK_DYNAMIC_TOOL_NAME,
  DESKTOP_DRAG_DYNAMIC_TOOL_NAME,
  DESKTOP_DYNAMIC_TOOL_NAMESPACE,
  DESKTOP_FOCUS_WINDOW_DYNAMIC_TOOL_NAME,
  DESKTOP_HOTKEY_DYNAMIC_TOOL_NAME,
  DESKTOP_OBSERVE_DYNAMIC_TOOL_NAME,
  DESKTOP_OPEN_APP_DYNAMIC_TOOL_NAME,
  DESKTOP_RECORD_START_DYNAMIC_TOOL_NAME,
  DESKTOP_RECORD_STATUS_DYNAMIC_TOOL_NAME,
  DESKTOP_RECORD_STOP_DYNAMIC_TOOL_NAME,
  DESKTOP_SCREENSHOT_DYNAMIC_TOOL_NAME,
  DESKTOP_SCROLL_DYNAMIC_TOOL_NAME,
  DESKTOP_TYPE_DYNAMIC_TOOL_NAME,
  DESKTOP_WINDOWS_DYNAMIC_TOOL_NAME,
} from "./desktop-dynamic-tool.js";
import { GIT_SYNC_DYNAMIC_TOOL_NAME } from "./git-sync-dynamic-tool.js";
import {
  JIRA_ADD_COMMENT_DYNAMIC_TOOL_NAME,
  JIRA_CREATE_ISSUE_DYNAMIC_TOOL_NAME,
  JIRA_DYNAMIC_TOOL_NAMESPACE,
  JIRA_GET_ISSUE_DYNAMIC_TOOL_NAME,
  JIRA_LIST_COMMENTS_DYNAMIC_TOOL_NAME,
  JIRA_LIST_TRANSITIONS_DYNAMIC_TOOL_NAME,
  JIRA_SEARCH_ISSUES_DYNAMIC_TOOL_NAME,
  JIRA_TRANSITION_ISSUE_DYNAMIC_TOOL_NAME,
} from "./jira-dynamic-tool.js";
import { KNOWN_IMAGE_FIXTURE_DYNAMIC_TOOL_NAME } from "./known-image-dynamic-tool.js";
import {
  LAUNCHDARKLY_DYNAMIC_TOOL_NAMESPACE,
  LAUNCHDARKLY_GET_FEATURE_FLAG_DYNAMIC_TOOL_NAME,
  LAUNCHDARKLY_LIST_FEATURE_FLAGS_DYNAMIC_TOOL_NAME,
  LAUNCHDARKLY_PATCH_FEATURE_FLAG_DYNAMIC_TOOL_NAME,
} from "./launchdarkly-dynamic-tool.js";
import {
  CYCLOID_DYNAMIC_TOOL_NAMESPACE,
  MEMORY_CONTEXT_DYNAMIC_TOOL_NAME,
  MEMORY_RECALL_DYNAMIC_TOOL_NAME,
} from "./memory-dynamic-tool.js";
import {
  NOTION_DYNAMIC_TOOL_NAMESPACE,
  NOTION_GET_BLOCK_CHILDREN_DYNAMIC_TOOL_NAME,
  NOTION_SEARCH_DYNAMIC_TOOL_NAME,
} from "./notion-dynamic-tool.js";
import { PR_REVIEW_PUBLISH_DYNAMIC_TOOL_NAME } from "./pr-review-publish-dynamic-tool.js";
import { REVIEW_LOOP_REPLY_DYNAMIC_TOOL_NAME } from "./review-loop-dynamic-tool.js";
import { REVIEW_SUMMARY_COMMENT_DYNAMIC_TOOL_NAME } from "./review-summary-comment-dynamic-tool.js";
import {
  SENTRY_DYNAMIC_TOOL_NAME,
  SENTRY_DYNAMIC_TOOL_NAMESPACE,
  SENTRY_SEARCH_ISSUES_DYNAMIC_TOOL_NAME,
  SENTRY_SEARCH_ISSUES_LIMIT_MAX,
  SENTRY_SEARCH_ISSUES_STATS_PERIOD_PATTERN,
} from "./sentry-dynamic-tool.js";
import {
  SLACK_DYNAMIC_TOOL_NAMESPACE,
  SLACK_GET_THREAD_DYNAMIC_TOOL_NAME,
  SLACK_SEARCH_MESSAGES_DYNAMIC_TOOL_NAME,
  SLACK_SEND_MESSAGE_DYNAMIC_TOOL_NAME,
} from "./slack-dynamic-tool.js";
import { TERRAFORM_DYNAMIC_TOOL_NAMESPACE, TERRAFORM_PLAN_DYNAMIC_TOOL_NAME } from "./terraform-dynamic-tool.js";
import {
  VERCEL_DYNAMIC_TOOL_NAMESPACE,
  VERCEL_GET_DEPLOYMENT_FOR_REF_DYNAMIC_TOOL_NAME,
  VERCEL_GET_PREVIEW_URL_DYNAMIC_TOOL_NAME,
} from "./vercel-dynamic-tool.js";

// Structural gate enforced at the shared dispatch boundary
// (executeFirstPartyDynamicToolCall) for both the Codex and Claude Code
// backends. Each schema mirrors the tool's published inputSchema spec: strict
// keys, required fields, enums, and literal numeric ranges. Deeper semantic
// validation (read-only SQL, byte limits, exactly-one-of) stays in the tools.

const nonEmptyString = z.string().min(1);
const desktopScenarioId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);
const desktopActionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const desktopCoordinate = z.number().int().min(0).max(4095);
const desktopWindowId = z.string().regex(/^0x[0-9A-Fa-f]+$/);
const desktopCommonFields = {
  scenarioId: desktopScenarioId.optional(),
  actionId: desktopActionId.optional(),
  includeRecentScreenshots: z.boolean().optional(),
} as const;
const datadogTraceLookback = z
  .string()
  .regex(/^[1-9]\d*[mhd]$/)
  .refine((value) => {
    const match = /^([1-9]\d*)([mhd])$/.exec(value);
    if (!match) return false;
    const count = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isSafeInteger(count)) return false;
    const unit = match[2];
    const minutes = unit === "m" ? count : unit === "h" ? count * 60 : count * 24 * 60;
    return minutes <= 15 * 24 * 60;
  });

const vercelDeploymentLookupInputSchema = z
  .object({
    projectId: nonEmptyString,
    gitRef: nonEmptyString.optional(),
    gitSha: nonEmptyString.optional(),
  })
  .strict()
  .refine((value) => Boolean(value.gitRef) || Boolean(value.gitSha), {
    message: "requires at least one of 'gitRef' or 'gitSha'",
  });

const launchDarklyPatchOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("turn_on") }).strict(),
  z.object({ kind: z.literal("turn_off") }).strict(),
  z.object({ kind: z.literal("set_fallthrough_variation"), variationId: nonEmptyString }).strict(),
  z.object({ kind: z.literal("set_off_variation"), variationId: nonEmptyString }).strict(),
]);

const SCHEMAS = {
  [`${DESKTOP_DYNAMIC_TOOL_NAMESPACE}.${DESKTOP_OBSERVE_DYNAMIC_TOOL_NAME}`]: z.object(desktopCommonFields).strict(),
  [`${DESKTOP_DYNAMIC_TOOL_NAMESPACE}.${DESKTOP_SCREENSHOT_DYNAMIC_TOOL_NAME}`]: z.object(desktopCommonFields).strict(),
  [`${DESKTOP_DYNAMIC_TOOL_NAMESPACE}.${DESKTOP_WINDOWS_DYNAMIC_TOOL_NAME}`]: z
    .object({ actionId: desktopActionId.optional() })
    .strict(),
  [`${DESKTOP_DYNAMIC_TOOL_NAMESPACE}.${DESKTOP_CLICK_DYNAMIC_TOOL_NAME}`]: z
    .object({
      ...desktopCommonFields,
      x: desktopCoordinate,
      y: desktopCoordinate,
      button: z.number().int().min(1).max(5).optional(),
      targetWindowId: desktopWindowId.optional(),
    })
    .strict(),
  [`${DESKTOP_DYNAMIC_TOOL_NAMESPACE}.${DESKTOP_TYPE_DYNAMIC_TOOL_NAME}`]: z
    .object({
      ...desktopCommonFields,
      text: nonEmptyString.max(4096),
      targetWindowId: desktopWindowId.optional(),
    })
    .strict(),
  [`${DESKTOP_DYNAMIC_TOOL_NAMESPACE}.${DESKTOP_HOTKEY_DYNAMIC_TOOL_NAME}`]: z
    .object({
      ...desktopCommonFields,
      keys: nonEmptyString.regex(/^[A-Za-z0-9_+:.\/-]+$/),
      targetWindowId: desktopWindowId.optional(),
    })
    .strict(),
  [`${DESKTOP_DYNAMIC_TOOL_NAMESPACE}.${DESKTOP_SCROLL_DYNAMIC_TOOL_NAME}`]: z
    .object({
      ...desktopCommonFields,
      x: desktopCoordinate,
      y: desktopCoordinate,
      amount: z
        .number()
        .int()
        .min(-20)
        .max(20)
        .refine((value) => value !== 0, {
          message: "amount must be non-zero",
        }),
      targetWindowId: desktopWindowId.optional(),
    })
    .strict(),
  [`${DESKTOP_DYNAMIC_TOOL_NAMESPACE}.${DESKTOP_DRAG_DYNAMIC_TOOL_NAME}`]: z
    .object({
      ...desktopCommonFields,
      fromX: desktopCoordinate,
      fromY: desktopCoordinate,
      toX: desktopCoordinate,
      toY: desktopCoordinate,
      targetWindowId: desktopWindowId.optional(),
    })
    .strict(),
  [`${DESKTOP_DYNAMIC_TOOL_NAMESPACE}.${DESKTOP_OPEN_APP_DYNAMIC_TOOL_NAME}`]: z
    .object({
      ...desktopCommonFields,
      url: nonEmptyString
        .max(4096)
        .regex(/^https?:\/\//i)
        .optional(),
      command: nonEmptyString.max(4096).optional(),
    })
    .strict()
    .refine((value) => Boolean(value.url) !== Boolean(value.command), {
      message: "requires exactly one of 'url' or 'command'",
    }),
  [`${DESKTOP_DYNAMIC_TOOL_NAMESPACE}.${DESKTOP_FOCUS_WINDOW_DYNAMIC_TOOL_NAME}`]: z
    .object({
      ...desktopCommonFields,
      windowId: desktopWindowId.optional(),
      title: nonEmptyString.optional(),
    })
    .strict()
    .refine((value) => Boolean(value.windowId) !== Boolean(value.title), {
      message: "requires exactly one of 'windowId' or 'title'",
    }),
  [`${DESKTOP_DYNAMIC_TOOL_NAMESPACE}.${DESKTOP_RECORD_START_DYNAMIC_TOOL_NAME}`]: z
    .object({
      ...desktopCommonFields,
      label: nonEmptyString.max(160),
      acknowledgeNoSecrets: z.literal(true),
      recordingId: desktopActionId.optional(),
    })
    .strict(),
  [`${DESKTOP_DYNAMIC_TOOL_NAMESPACE}.${DESKTOP_RECORD_STOP_DYNAMIC_TOOL_NAME}`]: z
    .object({
      ...desktopCommonFields,
      reason: z.enum(["operator_stop", "interrupted", "pause", "resume", "stale"]).optional(),
    })
    .strict(),
  [`${DESKTOP_DYNAMIC_TOOL_NAMESPACE}.${DESKTOP_RECORD_STATUS_DYNAMIC_TOOL_NAME}`]: z
    .object({ actionId: desktopActionId.optional() })
    .strict(),

  [`${CYCLOID_DYNAMIC_TOOL_NAMESPACE}.${MEMORY_CONTEXT_DYNAMIC_TOOL_NAME}`]: z
    .object({
      intent: nonEmptyString,
      files: z.array(z.string()).optional(),
      symbols: z.array(z.string()).optional(),
      tool: z.string().optional(),
      currentTaskSummary: z.string().optional(),
      recentSessionSummary: z.string().nullable().optional(),
      maxMemories: z.number().int().min(1).max(5).optional(),
    })
    .strict(),
  [`${CYCLOID_DYNAMIC_TOOL_NAMESPACE}.${MEMORY_RECALL_DYNAMIC_TOOL_NAME}`]: z
    .object({
      intent: nonEmptyString,
      files: z.array(z.string()).optional(),
      symbols: z.array(z.string()).optional(),
      tool: z.string().optional(),
    })
    .strict(),
  [`${CYCLOID_DYNAMIC_TOOL_NAMESPACE}.${COMPANY_MEMORY_RECALL_DYNAMIC_TOOL_NAME}`]: z
    .object({
      intent: nonEmptyString,
      files: z.array(z.string()).optional(),
      customer: z.string().optional(),
      topK: z.number().optional(),
      includeActionItems: z.boolean().optional(),
      includeOpenQuestions: z.boolean().optional(),
    })
    .strict(),
  [`${CYCLOID_DYNAMIC_TOOL_NAMESPACE}.${COMPANY_MEMORY_REASONING_CHAIN_DYNAMIC_TOOL_NAME}`]: z
    .object({ memoryId: nonEmptyString })
    .strict(),
  [`${CYCLOID_DYNAMIC_TOOL_NAMESPACE}.${REVIEW_LOOP_REPLY_DYNAMIC_TOOL_NAME}`]: z
    .object({
      epochId: nonEmptyString,
      targetSourceId: nonEmptyString,
      verdict: z.enum(["fixed", "replied", "declined"]),
      body: nonEmptyString.max(4096),
      promptId: nonEmptyString.optional(),
    })
    .strict(),
  [`${CYCLOID_DYNAMIC_TOOL_NAMESPACE}.${REVIEW_SUMMARY_COMMENT_DYNAMIC_TOOL_NAME}`]: z
    .object({
      epochId: nonEmptyString,
      // Mirrors BODY_MAX_BYTES in review-summary-comment-dynamic-tool.ts (the
      // executor enforces the byte-accurate limit).
      body: nonEmptyString.max(8192),
      promptId: nonEmptyString.optional(),
    })
    .strict(),
  [`${CYCLOID_DYNAMIC_TOOL_NAMESPACE}.${GIT_SYNC_DYNAMIC_TOOL_NAME}`]: z
    .object({
      operation: z.enum(["force_push_current_branch"]),
      baseBranch: nonEmptyString.optional(),
    })
    .strict(),
  [`${CYCLOID_DYNAMIC_TOOL_NAMESPACE}.${PR_REVIEW_PUBLISH_DYNAMIC_TOOL_NAME}`]: z
    .object({
      summaryMarkdown: nonEmptyString.max(60_000).optional(),
      verdict: z.enum(["clear", "issues_found", "inconclusive"]),
      checks: z
        .array(
          z
            .object({
              command: z.string().max(1_000),
              reason: nonEmptyString.max(500),
              status: z.enum(["passed", "failed", "skipped"]),
              exitCode: z.number().int().nullable(),
              detail: nonEmptyString.max(500),
            })
            .strict(),
        )
        .max(20),
      scopeNotVerified: z.array(nonEmptyString.max(1_000)).max(20),
      confidenceScore: z.number().int().min(1).max(5),
      importantFiles: z.array(z.object({ path: z.string(), reason: z.string() }).strict()).max(100),
      findings: z
        .array(
          z
            .object({
              path: z.string(),
              line: z.number().int().min(1),
              side: z.literal("RIGHT"),
              severity: z.enum(["P1", "P2"]),
              title: z.string(),
              confidence: z.number().int().min(1).max(5),
              bodyMarkdown: z.string(),
              security: z.boolean().optional(),
              suggestion: z
                .string()
                .min(1)
                .max(4_000)
                .regex(/^[^`\r\n]+$/)
                .optional(),
              citations: z.array(z.string().min(1).max(240)).max(5).optional(),
            })
            .strict(),
        )
        .max(40),
      headSha: z.string().regex(/^[0-9a-fA-F]{40}$/),
    })
    .strict(),
  [`${CYCLOID_DYNAMIC_TOOL_NAMESPACE}.${SPAWN_CHILD_SESSION_DYNAMIC_TOOL_NAME}`]: z
    .object({
      prompt: nonEmptyString.max(SPAWN_CHILD_SESSION_MAX_PROMPT_LENGTH),
      repositoryId: nonEmptyString.regex(SPAWN_CHILD_SESSION_REPOSITORY_ID_PATTERN),
      title: nonEmptyString.max(SPAWN_CHILD_SESSION_MAX_TITLE_LENGTH).optional(),
      model: nonEmptyString.optional(),
      reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
    })
    .strict(),
  [`${CYCLOID_DYNAMIC_TOOL_NAMESPACE}.${KNOWN_IMAGE_FIXTURE_DYNAMIC_TOOL_NAME}`]: z
    .object({
      scenarioId: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/)
        .optional(),
      detail: z.enum(["high", "low"]).optional(),
    })
    .strict(),

  [`${CLOUDFLARE_DYNAMIC_TOOL_NAMESPACE}.${CLOUDFLARE_QUERY_D1_DYNAMIC_TOOL_NAME}`]: z
    .object({
      sql: nonEmptyString,
      params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    })
    .strict(),

  [`${BRAINTRUST_DYNAMIC_TOOL_NAMESPACE}.${BRAINTRUST_LIST_PROJECTS_DYNAMIC_TOOL_NAME}`]: z
    .object({ limit: z.number().int().min(1).max(100).optional() })
    .strict(),
  [`${BRAINTRUST_DYNAMIC_TOOL_NAMESPACE}.${BRAINTRUST_QUERY_SQL_DYNAMIC_TOOL_NAME}`]: z
    .object({ query: nonEmptyString })
    .strict(),
  [`${BRAINTRUST_DYNAMIC_TOOL_NAMESPACE}.${BRAINTRUST_SUMMARIZE_EXPERIMENT_DYNAMIC_TOOL_NAME}`]: z
    .object({
      experiment_id: nonEmptyString,
      summarize_scores: z.boolean().optional(),
      comparison_experiment_id: z.string().optional(),
    })
    .strict(),
  [`${BRAINTRUST_DYNAMIC_TOOL_NAMESPACE}.${BRAINTRUST_GENERATE_PERMALINK_DYNAMIC_TOOL_NAME}`]: z
    .object({
      object_type: z.enum(["experiment", "project"]),
      object_id: nonEmptyString,
      org_name: z.string().optional(),
      project_name: z.string().optional(),
      app_url: z.string().optional(),
    })
    .strict(),
  [`${BRAINTRUST_DYNAMIC_TOOL_NAMESPACE}.${BRAINTRUST_INFER_SCHEMA_DYNAMIC_TOOL_NAME}`]: z
    .object({
      source_type: z.enum(["project_logs", "experiment", "dataset"]),
      object_id: nonEmptyString,
      shape: z.enum(["spans", "traces"]).optional(),
      sample_limit: z.number().int().min(1).max(100).optional(),
      days: z.number().int().min(1).max(365).optional(),
      where: nonEmptyString.optional(),
    })
    .strict(),

  [`${DATADOG_DYNAMIC_TOOL_NAMESPACE}.${DATADOG_SEARCH_LOGS_DYNAMIC_TOOL_NAME}`]: z
    .object({
      query: nonEmptyString,
      from: z.string().optional(),
      to: z.string().optional(),
      cursor: nonEmptyString.optional(),
      limit: z.number().int().min(1).max(50).optional(),
    })
    .strict()
    .refine(
      (value) => {
        if (!value.cursor) return true;
        const from = value.from;
        const to = value.to;
        return Boolean(from && to && !from.includes("now") && !to.includes("now"));
      },
      {
        message: "cursor requires fixed, non-relative 'from' and 'to' values",
      },
    ),
  [`${DATADOG_DYNAMIC_TOOL_NAMESPACE}.${DATADOG_GET_TRACE_DYNAMIC_TOOL_NAME}`]: z
    .object({
      traceId: nonEmptyString,
      lookback: datadogTraceLookback.optional(),
    })
    .strict(),
  [`${DATADOG_DYNAMIC_TOOL_NAMESPACE}.${DATADOG_QUERY_METRICS_DYNAMIC_TOOL_NAME}`]: z
    .object({
      query: nonEmptyString,
      from: z.number().int().optional(),
      to: z.number().int().optional(),
    })
    .strict(),
  [`${DATADOG_DYNAMIC_TOOL_NAMESPACE}.${DATADOG_GET_MONITORS_DYNAMIC_TOOL_NAME}`]: z
    .object({
      name: nonEmptyString.optional(),
      tags: z.array(z.string()).optional(),
      groupStates: nonEmptyString.optional(),
      limit: z.number().int().min(1).max(25).optional(),
    })
    .strict(),

  [`${LAUNCHDARKLY_DYNAMIC_TOOL_NAMESPACE}.${LAUNCHDARKLY_LIST_FEATURE_FLAGS_DYNAMIC_TOOL_NAME}`]: z
    .object({
      projectKey: nonEmptyString,
      environmentKey: nonEmptyString.optional(),
      search: nonEmptyString.max(200).optional(),
      tag: nonEmptyString.max(100).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      offset: z.number().int().min(0).optional(),
      includeEnvironmentDetails: z.boolean().optional(),
    })
    .strict()
    .refine((value) => !value.includeEnvironmentDetails || Boolean(value.environmentKey), {
      message: "includeEnvironmentDetails requires environmentKey",
    }),
  [`${LAUNCHDARKLY_DYNAMIC_TOOL_NAMESPACE}.${LAUNCHDARKLY_GET_FEATURE_FLAG_DYNAMIC_TOOL_NAME}`]: z
    .object({
      projectKey: nonEmptyString,
      featureFlagKey: nonEmptyString,
      environmentKey: nonEmptyString.optional(),
      includeEvaluation: z.boolean().optional(),
    })
    .strict(),
  [`${LAUNCHDARKLY_DYNAMIC_TOOL_NAMESPACE}.${LAUNCHDARKLY_PATCH_FEATURE_FLAG_DYNAMIC_TOOL_NAME}`]: z
    .object({
      projectKey: nonEmptyString,
      featureFlagKey: nonEmptyString,
      environmentKey: nonEmptyString,
      operations: z.array(launchDarklyPatchOperationSchema).min(1).max(4),
    })
    .strict()
    .superRefine((value, ctx) => {
      const counts = new Map<string, number>();
      for (const operation of value.operations) {
        counts.set(operation.kind, (counts.get(operation.kind) ?? 0) + 1);
      }
      if ((counts.get("turn_on") ?? 0) > 0 && (counts.get("turn_off") ?? 0) > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "cannot combine turn_on and turn_off in one request",
          path: ["operations"],
        });
      }
      for (const [kind, count] of counts.entries()) {
        if (count > 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${kind} can appear at most once`,
            path: ["operations"],
          });
        }
      }
    }),

  [`${JIRA_DYNAMIC_TOOL_NAMESPACE}.${JIRA_CREATE_ISSUE_DYNAMIC_TOOL_NAME}`]: z
    .object({
      projectKey: nonEmptyString,
      summary: nonEmptyString,
      description: z.string().optional(),
      issueType: z.string().optional(),
      labels: z.array(z.string()).optional(),
      assigneeAccountId: z.string().optional(),
    })
    .strict(),
  [`${JIRA_DYNAMIC_TOOL_NAMESPACE}.${JIRA_GET_ISSUE_DYNAMIC_TOOL_NAME}`]: z
    .object({ keyOrId: nonEmptyString })
    .strict(),
  [`${JIRA_DYNAMIC_TOOL_NAMESPACE}.${JIRA_LIST_COMMENTS_DYNAMIC_TOOL_NAME}`]: z
    .object({
      keyOrId: nonEmptyString,
      startAt: z.number().int().min(0).optional(),
      maxResults: z.number().int().min(1).max(50).optional(),
    })
    .strict(),
  [`${JIRA_DYNAMIC_TOOL_NAMESPACE}.${JIRA_ADD_COMMENT_DYNAMIC_TOOL_NAME}`]: z
    .object({ keyOrId: nonEmptyString, body: nonEmptyString })
    .strict(),
  [`${JIRA_DYNAMIC_TOOL_NAMESPACE}.${JIRA_SEARCH_ISSUES_DYNAMIC_TOOL_NAME}`]: z
    .object({
      jql: nonEmptyString,
      nextPageToken: nonEmptyString.optional(),
      maxResults: z.number().int().min(1).max(25).optional(),
    })
    .strict(),
  [`${JIRA_DYNAMIC_TOOL_NAMESPACE}.${JIRA_LIST_TRANSITIONS_DYNAMIC_TOOL_NAME}`]: z
    .object({ keyOrId: nonEmptyString })
    .strict(),
  [`${JIRA_DYNAMIC_TOOL_NAMESPACE}.${JIRA_TRANSITION_ISSUE_DYNAMIC_TOOL_NAME}`]: z
    .object({ keyOrId: nonEmptyString, transition: nonEmptyString })
    .strict(),

  [`${NOTION_DYNAMIC_TOOL_NAMESPACE}.${NOTION_SEARCH_DYNAMIC_TOOL_NAME}`]: z
    .object({ query: z.string().optional(), pageSize: z.number().int().min(1).max(25).optional() })
    .strict(),
  [`${NOTION_DYNAMIC_TOOL_NAMESPACE}.${NOTION_GET_BLOCK_CHILDREN_DYNAMIC_TOOL_NAME}`]: z
    .object({ blockId: nonEmptyString, pageSize: z.number().int().min(1).max(100).optional() })
    .strict(),

  [`${SENTRY_DYNAMIC_TOOL_NAMESPACE}.${SENTRY_DYNAMIC_TOOL_NAME}`]: z
    .object({ reference: nonEmptyString, organizationSlug: z.string().optional() })
    .strict(),
  [`${SENTRY_DYNAMIC_TOOL_NAMESPACE}.${SENTRY_SEARCH_ISSUES_DYNAMIC_TOOL_NAME}`]: z
    .object({
      query: nonEmptyString,
      project: nonEmptyString.optional(),
      statsPeriod: z.string().regex(SENTRY_SEARCH_ISSUES_STATS_PERIOD_PATTERN).optional(),
      limit: z.number().int().min(1).max(SENTRY_SEARCH_ISSUES_LIMIT_MAX).optional(),
    })
    .strict(),

  [`${SLACK_DYNAMIC_TOOL_NAMESPACE}.${SLACK_GET_THREAD_DYNAMIC_TOOL_NAME}`]: z
    .object({ channel: nonEmptyString, ts: nonEmptyString })
    .strict(),
  [`${SLACK_DYNAMIC_TOOL_NAMESPACE}.${SLACK_SEARCH_MESSAGES_DYNAMIC_TOOL_NAME}`]: z
    .object({
      query: nonEmptyString,
      channel: nonEmptyString.optional(),
      count: z.number().int().min(1).max(20).optional(),
    })
    .strict(),
  [`${SLACK_DYNAMIC_TOOL_NAMESPACE}.${SLACK_SEND_MESSAGE_DYNAMIC_TOOL_NAME}`]: z
    .object({
      channel: nonEmptyString,
      threadTs: nonEmptyString.optional(),
      text: nonEmptyString.max(4096),
    })
    .strict(),

  [`${TERRAFORM_DYNAMIC_TOOL_NAMESPACE}.${TERRAFORM_PLAN_DYNAMIC_TOOL_NAME}`]: z
    .object({
      directory: z.string().optional(),
    })
    .strict(),

  [`${VERCEL_DYNAMIC_TOOL_NAMESPACE}.${VERCEL_GET_DEPLOYMENT_FOR_REF_DYNAMIC_TOOL_NAME}`]:
    vercelDeploymentLookupInputSchema,
  [`${VERCEL_DYNAMIC_TOOL_NAMESPACE}.${VERCEL_GET_PREVIEW_URL_DYNAMIC_TOOL_NAME}`]: vercelDeploymentLookupInputSchema,
} as const satisfies Record<string, z.ZodTypeAny>;

export type DynamicToolInputValidation = { ok: true; value: unknown } | { ok: false; message: string };

function formatIssues(toolKey: string, error: z.ZodError): string {
  const issues = error.issues
    .slice(0, 3)
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
  return `${toolKey} input invalid: ${issues}`;
}

/**
 * Validates a first-party dynamic tool input against its registered schema.
 * `undefined` inputs normalize to `{}` so tools with all-optional fields
 * accept a bare call. `null` is explicit input and must satisfy the schema.
 * A missing schema fails closed: every registered tool must have an entry here.
 */
export function validateFirstPartyDynamicToolInput(
  namespace: string,
  name: string,
  args: unknown,
): DynamicToolInputValidation {
  const toolKey = `${namespace}.${name}`;
  const schema = (SCHEMAS as Record<string, z.ZodTypeAny>)[toolKey];
  if (!schema) {
    return {
      ok: false,
      message: `${toolKey} has no registered input schema; add one to dynamic-tool-input-schemas.ts.`,
    };
  }
  const result = schema.safeParse(args === undefined ? {} : args);
  if (!result.success) {
    return { ok: false, message: formatIssues(toolKey, result.error) };
  }
  return { ok: true, value: result.data };
}
