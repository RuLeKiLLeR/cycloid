import { isCodeReviewerAgentRole, isQaTesterAgentRole, PLAN_AGENT_NAME } from "../../../../shared/agent/constants.js";
import type { AgentRole } from "../../../../shared/agent/schema.js";
import {
  CYCLOID_DYNAMIC_TOOL_NAMESPACE,
  REVIEW_LOOP_REPLY_DYNAMIC_TOOL_NAME,
} from "../../../../shared/constants/dynamic-tool-names.js";
import {
  INTEGRATION_LIFECYCLE_REASON_CODE,
  INTEGRATION_LIFECYCLE_STAGE,
  INTEGRATION_LIFECYCLE_STATUS,
} from "../../../../shared/enums/integration-lifecycle.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import type { BridgeLogger } from "../logger.js";
import {
  BRAINTRUST_DYNAMIC_TOOL_NAMESPACE,
  BRAINTRUST_GENERATE_PERMALINK_DYNAMIC_TOOL_NAME,
  BRAINTRUST_INFER_SCHEMA_DYNAMIC_TOOL_NAME,
  BRAINTRUST_LIST_PROJECTS_DYNAMIC_TOOL_NAME,
  BRAINTRUST_QUERY_SQL_DYNAMIC_TOOL_NAME,
  BRAINTRUST_SUMMARIZE_EXPERIMENT_DYNAMIC_TOOL_NAME,
  buildBraintrustGeneratePermalinkDynamicToolSpec,
  buildBraintrustInferSchemaDynamicToolSpec,
  buildBraintrustListProjectsDynamicToolSpec,
  buildBraintrustQuerySqlDynamicToolSpec,
  buildBraintrustSummarizeExperimentDynamicToolSpec,
  executeBraintrustGeneratePermalinkDynamicToolCall,
  executeBraintrustInferSchemaDynamicToolCall,
  executeBraintrustListProjectsDynamicToolCall,
  executeBraintrustQuerySqlDynamicToolCall,
  executeBraintrustSummarizeExperimentDynamicToolCall,
  redactBraintrustDynamicToolInputForPersistence,
  redactBraintrustSummarizeExperimentInputForPersistence,
} from "./braintrust-dynamic-tool.js";
import {
  buildSpawnChildSessionDynamicToolSpec,
  executeSpawnChildSessionDynamicToolCall,
  SPAWN_CHILD_SESSION_DYNAMIC_TOOL_NAME,
} from "./child-session-dynamic-tool.js";
import {
  buildCloudflareQueryD1DynamicToolSpec,
  CLOUDFLARE_DYNAMIC_TOOL_NAMESPACE,
  CLOUDFLARE_QUERY_D1_DYNAMIC_TOOL_NAME,
  executeCloudflareQueryD1DynamicToolCall,
  redactCloudflareD1DynamicToolInput,
} from "./cloudflare-d1-dynamic-tool.js";
import {
  buildCompanyMemoryReasoningChainDynamicToolSpec,
  buildCompanyMemoryRecallDynamicToolSpec,
  COMPANY_MEMORY_REASONING_CHAIN_DYNAMIC_TOOL_NAME,
  COMPANY_MEMORY_RECALL_DYNAMIC_TOOL_NAME,
  executeCompanyMemoryReasoningChainDynamicToolCall,
  executeCompanyMemoryRecallDynamicToolCall,
} from "./company-memory-dynamic-tool.js";
import {
  buildDatadogGetMonitorsDynamicToolSpec,
  buildDatadogGetTraceDynamicToolSpec,
  buildDatadogQueryMetricsDynamicToolSpec,
  buildDatadogSearchLogsDynamicToolSpec,
  DATADOG_DYNAMIC_TOOL_NAMESPACE,
  DATADOG_GET_MONITORS_DYNAMIC_TOOL_NAME,
  DATADOG_GET_TRACE_DYNAMIC_TOOL_NAME,
  DATADOG_QUERY_METRICS_DYNAMIC_TOOL_NAME,
  DATADOG_SEARCH_LOGS_DYNAMIC_TOOL_NAME,
  executeDatadogGetMonitorsDynamicToolCall,
  executeDatadogGetTraceDynamicToolCall,
  executeDatadogQueryMetricsDynamicToolCall,
  executeDatadogSearchLogsDynamicToolCall,
  redactDatadogDynamicToolInputForPersistence,
} from "./datadog-dynamic-tool.js";
import {
  buildDesktopDynamicToolSpec,
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
  executeDesktopDynamicToolCall,
  redactDesktopDynamicToolInputForPersistence,
} from "./desktop-dynamic-tool.js";
import { normalizeControlPlaneUrl } from "./dynamic-tool-http.js";
import { validateFirstPartyDynamicToolInput } from "./dynamic-tool-input-schemas.js";
import { appendRecoveryGuidance, DYNAMIC_TOOL_ERROR_CODES, type DynamicToolErrorCode } from "./dynamic-tool-results.js";
import {
  buildGitSyncDynamicToolSpec,
  executeGitSyncDynamicToolCall,
  GIT_SYNC_DYNAMIC_TOOL_NAME,
} from "./git-sync-dynamic-tool.js";
import {
  buildJiraAddCommentDynamicToolSpec,
  buildJiraCreateIssueDynamicToolSpec,
  buildJiraGetIssueDynamicToolSpec,
  buildJiraListCommentsDynamicToolSpec,
  buildJiraListTransitionsDynamicToolSpec,
  buildJiraSearchIssuesDynamicToolSpec,
  buildJiraTransitionIssueDynamicToolSpec,
  executeJiraAddCommentDynamicToolCall,
  executeJiraCreateIssueDynamicToolCall,
  executeJiraGetIssueDynamicToolCall,
  executeJiraListCommentsDynamicToolCall,
  executeJiraListTransitionsDynamicToolCall,
  executeJiraSearchIssuesDynamicToolCall,
  executeJiraTransitionIssueDynamicToolCall,
  JIRA_ADD_COMMENT_DYNAMIC_TOOL_NAME,
  JIRA_CREATE_ISSUE_DYNAMIC_TOOL_NAME,
  JIRA_DYNAMIC_TOOL_NAMESPACE,
  JIRA_GET_ISSUE_DYNAMIC_TOOL_NAME,
  JIRA_LIST_COMMENTS_DYNAMIC_TOOL_NAME,
  JIRA_LIST_TRANSITIONS_DYNAMIC_TOOL_NAME,
  JIRA_SEARCH_ISSUES_DYNAMIC_TOOL_NAME,
  JIRA_TRANSITION_ISSUE_DYNAMIC_TOOL_NAME,
  redactJiraDynamicToolInputForPersistence,
} from "./jira-dynamic-tool.js";
import {
  buildKnownImageFixtureDynamicToolSpec,
  executeKnownImageFixtureDynamicToolCall,
  isKnownImageFixtureDynamicToolAvailable,
  KNOWN_IMAGE_FIXTURE_DYNAMIC_TOOL_NAME,
} from "./known-image-dynamic-tool.js";
import {
  buildLaunchDarklyGetFeatureFlagDynamicToolSpec,
  buildLaunchDarklyListFeatureFlagsDynamicToolSpec,
  buildLaunchDarklyPatchFeatureFlagDynamicToolSpec,
  executeLaunchDarklyGetFeatureFlagDynamicToolCall,
  executeLaunchDarklyListFeatureFlagsDynamicToolCall,
  executeLaunchDarklyPatchFeatureFlagDynamicToolCall,
  LAUNCHDARKLY_DYNAMIC_TOOL_NAMESPACE,
  LAUNCHDARKLY_GET_FEATURE_FLAG_DYNAMIC_TOOL_NAME,
  LAUNCHDARKLY_LIST_FEATURE_FLAGS_DYNAMIC_TOOL_NAME,
  LAUNCHDARKLY_PATCH_FEATURE_FLAG_DYNAMIC_TOOL_NAME,
  redactLaunchDarklyDynamicToolInputForPersistence,
} from "./launchdarkly-dynamic-tool.js";
import { buildLoadedFirstPartyDynamicToolRegistrations } from "./loaded-first-party-dynamic-tools.js";
import {
  buildMemoryContextDynamicToolSpec,
  buildMemoryRecallDynamicToolSpec,
  executeMemoryContextDynamicToolCall,
  executeMemoryRecallDynamicToolCall,
  MEMORY_CONTEXT_DYNAMIC_TOOL_NAME,
  MEMORY_RECALL_DYNAMIC_TOOL_NAME,
} from "./memory-dynamic-tool.js";
import {
  buildNotionGetBlockChildrenDynamicToolSpec,
  buildNotionSearchDynamicToolSpec,
  executeNotionGetBlockChildrenDynamicToolCall,
  executeNotionSearchDynamicToolCall,
  NOTION_DYNAMIC_TOOL_NAMESPACE,
  NOTION_GET_BLOCK_CHILDREN_DYNAMIC_TOOL_NAME,
  NOTION_SEARCH_DYNAMIC_TOOL_NAME,
} from "./notion-dynamic-tool.js";
import {
  buildPrReviewPublishDynamicToolSpec,
  executePrReviewPublishDynamicToolCall,
  PR_REVIEW_PUBLISH_DYNAMIC_TOOL_NAME,
  redactPrReviewPublishInput,
} from "./pr-review-publish-dynamic-tool.js";
import {
  buildReviewLoopReplyDynamicToolSpec,
  executeReviewLoopReplyDynamicToolCall,
  redactReviewLoopReplyDynamicToolInput,
} from "./review-loop-dynamic-tool.js";
import {
  buildReviewSummaryCommentDynamicToolSpec,
  executeReviewSummaryCommentDynamicToolCall,
  redactReviewSummaryCommentDynamicToolInput,
  REVIEW_SUMMARY_COMMENT_DYNAMIC_TOOL_NAME,
} from "./review-summary-comment-dynamic-tool.js";
import {
  buildSentryDynamicToolSpec,
  buildSentrySearchIssuesDynamicToolSpec,
  executeSentryDynamicToolCall,
  executeSentrySearchIssuesDynamicToolCall,
  redactSentryDynamicToolInputForPersistence,
  SENTRY_DYNAMIC_TOOL_NAME,
  SENTRY_DYNAMIC_TOOL_NAMESPACE,
  SENTRY_SEARCH_ISSUES_DYNAMIC_TOOL_NAME,
} from "./sentry-dynamic-tool.js";
import {
  buildSlackGetThreadDynamicToolSpec,
  buildSlackSearchMessagesDynamicToolSpec,
  buildSlackSendMessageDynamicToolSpec,
  executeSlackGetThreadDynamicToolCall,
  executeSlackSearchMessagesDynamicToolCall,
  executeSlackSendMessageDynamicToolCall,
  redactSlackDynamicToolInputForPersistence,
  SLACK_DYNAMIC_TOOL_NAMESPACE,
  SLACK_GET_THREAD_DYNAMIC_TOOL_NAME,
  SLACK_SEARCH_MESSAGES_DYNAMIC_TOOL_NAME,
  SLACK_SEND_MESSAGE_DYNAMIC_TOOL_NAME,
} from "./slack-dynamic-tool.js";
import {
  buildTerraformPlanDynamicToolSpec,
  executeTerraformPlanDynamicToolCall,
  redactTerraformPlanDynamicToolInput,
  TERRAFORM_DYNAMIC_TOOL_NAMESPACE,
  TERRAFORM_PLAN_DYNAMIC_TOOL_NAME,
} from "./terraform-dynamic-tool.js";
import {
  buildVercelGetDeploymentForRefDynamicToolSpec,
  buildVercelGetPreviewUrlDynamicToolSpec,
  executeVercelGetDeploymentForRefDynamicToolCall,
  executeVercelGetPreviewUrlDynamicToolCall,
  redactVercelDynamicToolInputForPersistence,
  VERCEL_DYNAMIC_TOOL_NAMESPACE,
  VERCEL_GET_DEPLOYMENT_FOR_REF_DYNAMIC_TOOL_NAME,
  VERCEL_GET_PREVIEW_URL_DYNAMIC_TOOL_NAME,
} from "./vercel-dynamic-tool.js";

export type FirstPartyDynamicToolSpec = {
  namespace: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type FirstPartyDynamicToolTextContentItem = { type: "inputText"; text: string };

export type FirstPartyDynamicToolImageContentItem = {
  type: "inputImage";
  path: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  label: string;
  detail: "high" | "low";
  width: number;
  height: number;
  bytes: number;
};

export type FirstPartyDynamicToolContentItem =
  FirstPartyDynamicToolTextContentItem | FirstPartyDynamicToolImageContentItem;

export type FirstPartyDynamicToolCallResult = {
  contentItems: FirstPartyDynamicToolContentItem[];
  success: boolean;
  errorCode?: DynamicToolErrorCode;
  retryAfterMs?: number;
};

export type FirstPartyDynamicToolExecuteContext = {
  env: NodeJS.ProcessEnv | Record<string, string>;
  agentRole?: AgentRole;
  cwd?: string;
  signal?: AbortSignal;
  agentProfile?: string;
  fetchImpl?: typeof fetch;
  promptLog?: BridgeLogger;
  repoMemories?: import("./memory-ranking.js").Memory[];
  memoryRefById?: ReadonlyMap<string, import("../../../../shared/events/bridge.js").MemoryRef>;
  recordTelemetry?: (event: string, fields: Record<string, unknown>) => void;
};

export type FirstPartyDynamicToolRegistration = {
  namespace: string;
  name: string;
  planMode: "readOnly" | "sideEffecting";
  buildSpecs: (env: NodeJS.ProcessEnv | Record<string, string>) => FirstPartyDynamicToolSpec[];
  execute: (args: unknown, context: FirstPartyDynamicToolExecuteContext) => Promise<FirstPartyDynamicToolCallResult>;
  isAvailable?: (env: NodeJS.ProcessEnv | Record<string, string>) => boolean;
  validateInput?: (args: unknown) => unknown;
  redactPersistedInput?: (args: unknown) => Record<string, unknown> | null | undefined;
};

const LIFECYCLE_INTEGRATION_BY_NAMESPACE = {
  [BRAINTRUST_DYNAMIC_TOOL_NAMESPACE]: "braintrust",
  [CLOUDFLARE_DYNAMIC_TOOL_NAMESPACE]: "cloudflare",
  [DATADOG_DYNAMIC_TOOL_NAMESPACE]: "datadog",
  [JIRA_DYNAMIC_TOOL_NAMESPACE]: "jira",
  [LAUNCHDARKLY_DYNAMIC_TOOL_NAMESPACE]: "launchdarkly",
  linear: "linear",
  [NOTION_DYNAMIC_TOOL_NAMESPACE]: "notion",
  [SENTRY_DYNAMIC_TOOL_NAMESPACE]: "sentry",
  [SLACK_DYNAMIC_TOOL_NAMESPACE]: "slack",
  [TERRAFORM_DYNAMIC_TOOL_NAMESPACE]: "terraform",
  [VERCEL_DYNAMIC_TOOL_NAMESPACE]: "vercel",
} as const;

const MAX_LIFECYCLE_DEDUPE_KEYS = 10_000;
const emittedLifecycleEvents = new Set<string>();
const emittedLifecycleEventOrder: string[] = [];
const MAX_DYNAMIC_TOOL_FAILURE_REASON_CHARS = 2_000;
const SENSITIVE_DYNAMIC_TOOL_INPUT_KEYS = new Set(["body", "text", "content", "message", "jql"]);
const VERIFICATION_SIDE_EFFECTING_DYNAMIC_TOOL_ALLOWLIST = new Set<string>([
  firstPartyDynamicToolKey(DESKTOP_DYNAMIC_TOOL_NAMESPACE, DESKTOP_CLICK_DYNAMIC_TOOL_NAME),
  firstPartyDynamicToolKey(DESKTOP_DYNAMIC_TOOL_NAMESPACE, DESKTOP_TYPE_DYNAMIC_TOOL_NAME),
  firstPartyDynamicToolKey(DESKTOP_DYNAMIC_TOOL_NAMESPACE, DESKTOP_HOTKEY_DYNAMIC_TOOL_NAME),
  firstPartyDynamicToolKey(DESKTOP_DYNAMIC_TOOL_NAMESPACE, DESKTOP_SCROLL_DYNAMIC_TOOL_NAME),
  firstPartyDynamicToolKey(DESKTOP_DYNAMIC_TOOL_NAMESPACE, DESKTOP_DRAG_DYNAMIC_TOOL_NAME),
  firstPartyDynamicToolKey(DESKTOP_DYNAMIC_TOOL_NAMESPACE, DESKTOP_OPEN_APP_DYNAMIC_TOOL_NAME),
  firstPartyDynamicToolKey(DESKTOP_DYNAMIC_TOOL_NAMESPACE, DESKTOP_FOCUS_WINDOW_DYNAMIC_TOOL_NAME),
  firstPartyDynamicToolKey(DESKTOP_DYNAMIC_TOOL_NAMESPACE, DESKTOP_RECORD_START_DYNAMIC_TOOL_NAME),
  firstPartyDynamicToolKey(DESKTOP_DYNAMIC_TOOL_NAMESPACE, DESKTOP_RECORD_STOP_DYNAMIC_TOOL_NAME),
]);
const REVIEW_SIDE_EFFECTING_DYNAMIC_TOOL_ALLOWLIST = new Set<string>([
  `${CYCLOID_DYNAMIC_TOOL_NAMESPACE}.${PR_REVIEW_PUBLISH_DYNAMIC_TOOL_NAME}`,
]);
const RATE_LIMIT_RETRY_MAX_ATTEMPTS = 3;
const RATE_LIMIT_RETRY_BASE_DELAY_MS = 250;

function firstPartyDynamicToolKey(namespace: string, name: string): string {
  return `${namespace}.${name}`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function lifecycleEventDedupeKey(sessionId: string, integrationId: string, stage: string): string {
  return `${sessionId}:${integrationId}:${stage}`;
}

function hasEmittedLifecycleEvent(dedupeKey: string): boolean {
  return emittedLifecycleEvents.has(dedupeKey);
}

function rememberLifecycleEvent(dedupeKey: string): void {
  if (emittedLifecycleEvents.has(dedupeKey)) return;
  emittedLifecycleEvents.add(dedupeKey);
  emittedLifecycleEventOrder.push(dedupeKey);
  if (emittedLifecycleEventOrder.length <= MAX_LIFECYCLE_DEDUPE_KEYS) return;
  const evicted = emittedLifecycleEventOrder.shift();
  if (evicted) emittedLifecycleEvents.delete(evicted);
}

function lifecycleReasonForToolFailure(errorCode: DynamicToolErrorCode | undefined): string | null {
  switch (errorCode) {
    case DYNAMIC_TOOL_ERROR_CODES.UPSTREAM_RATE_LIMITED:
      return INTEGRATION_LIFECYCLE_REASON_CODE.PROVIDER_RATE_LIMITED;
    case DYNAMIC_TOOL_ERROR_CODES.TOKEN_EXPIRED:
      return INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_REVOKED;
    case DYNAMIC_TOOL_ERROR_CODES.SCOPE_MISSING:
      return INTEGRATION_LIFECYCLE_REASON_CODE.PROVIDER_AUTHN_REJECTED;
    case DYNAMIC_TOOL_ERROR_CODES.NOT_CONNECTED:
    case DYNAMIC_TOOL_ERROR_CODES.WORKSPACE_UNKNOWN:
    case DYNAMIC_TOOL_ERROR_CODES.WORKSPACE_UNINSTALLED:
      return INTEGRATION_LIFECYCLE_REASON_CODE.RUNTIME_ATTACH_FAILED;
    case DYNAMIC_TOOL_ERROR_CODES.CANCELLED:
    case DYNAMIC_TOOL_ERROR_CODES.FORBIDDEN:
      return INTEGRATION_LIFECYCLE_REASON_CODE.TOOL_EXECUTION_FAILED;
    case DYNAMIC_TOOL_ERROR_CODES.UPSTREAM_ERROR:
    case DYNAMIC_TOOL_ERROR_CODES.NOT_FOUND:
    case DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT:
      return INTEGRATION_LIFECYCLE_REASON_CODE.TOOL_EXECUTION_FAILED;
    default:
      return null;
  }
}

function truncateDynamicToolFailureReason(reason: string): string {
  if (reason.length <= MAX_DYNAMIC_TOOL_FAILURE_REASON_CHARS) return reason;
  return `${reason.slice(0, MAX_DYNAMIC_TOOL_FAILURE_REASON_CHARS)}...[truncated]`;
}

function scrubSensitiveInputValues(reason: string, args: unknown): string {
  if (!args || typeof args !== "object") return reason;
  let scrubbed = reason;
  for (const [key, value] of Object.entries(args)) {
    if (!SENSITIVE_DYNAMIC_TOOL_INPUT_KEYS.has(key) || typeof value !== "string" || value.length === 0) continue;
    scrubbed = scrubbed.split(value).join("[redacted]");
  }
  return scrubbed;
}

function sanitizeDynamicToolFailureReason(reason: string, args: unknown): string {
  return truncateDynamicToolFailureReason(scrubSensitiveInputValues(reason, args).replace(/\s+/g, " ").trim());
}

function stringFieldFromArgs(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function logDynamicToolFailure(params: {
  namespace: string;
  name: string;
  args: unknown;
  context: FirstPartyDynamicToolExecuteContext;
  result: FirstPartyDynamicToolCallResult;
}): void {
  const reason = sanitizeDynamicToolFailureReason(
    getFirstPartyDynamicToolTextContentItems(params.result)
      .map((item) => item.text)
      .join("\n"),
    params.args,
  );
  const sessionId = params.context.env["SESSION_ID"]?.trim() || undefined;
  const promptId = params.context.env["PROMPT_ID"]?.trim() || undefined;
  const targetSourceId = stringFieldFromArgs(params.args, "targetSourceId");
  params.context.promptLog?.warn(
    {
      event: "first_party_dynamic_tool_failed",
      namespace: params.namespace,
      name: params.name,
      errorCode: params.result.errorCode ?? null,
      ...(sessionId ? { sessionId } : {}),
      ...(promptId ? { promptId } : {}),
      ...(targetSourceId ? { targetSourceId } : {}),
      reason,
    },
    "First-party dynamic tool call failed",
  );
}

async function postLifecycleEvent(params: {
  sessionId: string;
  integrationId: string;
  stage: string;
  status: string;
  message: string;
  context: FirstPartyDynamicToolExecuteContext;
  reasonCode?: string | null;
  details?: Record<string, unknown>;
  dedupe?: boolean;
}): Promise<void> {
  const controlPlaneUrl = normalizeControlPlaneUrl(
    params.context.env["CONTROL_PLANE_URL"] ?? params.context.env["ARCANIST_API_URL"],
  );
  const sandboxAuthToken = params.context.env["SANDBOX_AUTH_TOKEN"]?.trim();
  if (!controlPlaneUrl || !sandboxAuthToken) return;

  const dedupeKey = lifecycleEventDedupeKey(params.sessionId, params.integrationId, params.stage);
  if (params.dedupe !== false && hasEmittedLifecycleEvent(dedupeKey)) return;

  try {
    const response = await (params.context.fetchImpl ?? fetch)(
      `${controlPlaneUrl}/api/sessions/${encodeURIComponent(params.sessionId)}/integration-lifecycle`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${sandboxAuthToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          integrationId: params.integrationId,
          stage: params.stage,
          status: params.status,
          reasonCode: params.reasonCode ?? null,
          message: params.message,
          details: {
            provider: params.integrationId,
            ...(params.details ?? {}),
          },
        }),
        signal: params.context.signal,
      },
    );
    if (response.ok && params.dedupe !== false) {
      rememberLifecycleEvent(dedupeKey);
    }
  } catch {
    // Lifecycle callback must remain best-effort.
  }
}

function postLifecycleEventInBackground(params: {
  sessionId: string;
  integrationId: string;
  stage: string;
  status: string;
  message: string;
  context: FirstPartyDynamicToolExecuteContext;
  reasonCode?: string | null;
  details?: Record<string, unknown>;
  dedupe?: boolean;
}): void {
  void postLifecycleEvent(params).catch((error) => {
    params.context.recordTelemetry?.("integration_lifecycle_callback_failed", {
      integrationId: params.integrationId,
      stage: params.stage,
      status: params.status,
      error: stringifyError(error),
    });
  });
}

function isMemoryToolAvailable(env: NodeJS.ProcessEnv | Record<string, string>): boolean {
  return env.ARCANIST_MEMORY_TOOLS_ENABLED === "1";
}

function isFirstPartyDynamicToolAvailable(
  registration: FirstPartyDynamicToolRegistration,
  env: NodeJS.ProcessEnv | Record<string, string>,
): boolean {
  if (registration.namespace === DESKTOP_DYNAMIC_TOOL_NAMESPACE) return env.ARCANIST_CUA_ENABLED === "1";
  return registration.isAvailable?.(env) ?? true;
}

const FIRST_PARTY_DYNAMIC_TOOL_REGISTRY: readonly FirstPartyDynamicToolRegistration[] = [
  {
    namespace: DESKTOP_DYNAMIC_TOOL_NAMESPACE,
    name: DESKTOP_OBSERVE_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: () => buildDesktopDynamicToolSpec(DESKTOP_OBSERVE_DYNAMIC_TOOL_NAME),
    execute: (args, context) => executeDesktopDynamicToolCall(args, context, DESKTOP_OBSERVE_DYNAMIC_TOOL_NAME),
  },
  {
    namespace: DESKTOP_DYNAMIC_TOOL_NAMESPACE,
    name: DESKTOP_SCREENSHOT_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: () => buildDesktopDynamicToolSpec(DESKTOP_SCREENSHOT_DYNAMIC_TOOL_NAME),
    execute: (args, context) => executeDesktopDynamicToolCall(args, context, DESKTOP_SCREENSHOT_DYNAMIC_TOOL_NAME),
  },
  {
    namespace: DESKTOP_DYNAMIC_TOOL_NAMESPACE,
    name: DESKTOP_WINDOWS_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: () => buildDesktopDynamicToolSpec(DESKTOP_WINDOWS_DYNAMIC_TOOL_NAME),
    execute: (args, context) => executeDesktopDynamicToolCall(args, context, DESKTOP_WINDOWS_DYNAMIC_TOOL_NAME),
  },
  {
    namespace: DESKTOP_DYNAMIC_TOOL_NAMESPACE,
    name: DESKTOP_CLICK_DYNAMIC_TOOL_NAME,
    planMode: "sideEffecting",
    buildSpecs: () => buildDesktopDynamicToolSpec(DESKTOP_CLICK_DYNAMIC_TOOL_NAME),
    execute: (args, context) => executeDesktopDynamicToolCall(args, context, DESKTOP_CLICK_DYNAMIC_TOOL_NAME),
  },
  {
    namespace: DESKTOP_DYNAMIC_TOOL_NAMESPACE,
    name: DESKTOP_TYPE_DYNAMIC_TOOL_NAME,
    planMode: "sideEffecting",
    buildSpecs: () => buildDesktopDynamicToolSpec(DESKTOP_TYPE_DYNAMIC_TOOL_NAME),
    execute: (args, context) => executeDesktopDynamicToolCall(args, context, DESKTOP_TYPE_DYNAMIC_TOOL_NAME),
    redactPersistedInput: (args) => redactDesktopDynamicToolInputForPersistence(DESKTOP_TYPE_DYNAMIC_TOOL_NAME, args),
  },
  {
    namespace: DESKTOP_DYNAMIC_TOOL_NAMESPACE,
    name: DESKTOP_HOTKEY_DYNAMIC_TOOL_NAME,
    planMode: "sideEffecting",
    buildSpecs: () => buildDesktopDynamicToolSpec(DESKTOP_HOTKEY_DYNAMIC_TOOL_NAME),
    execute: (args, context) => executeDesktopDynamicToolCall(args, context, DESKTOP_HOTKEY_DYNAMIC_TOOL_NAME),
  },
  {
    namespace: DESKTOP_DYNAMIC_TOOL_NAMESPACE,
    name: DESKTOP_SCROLL_DYNAMIC_TOOL_NAME,
    planMode: "sideEffecting",
    buildSpecs: () => buildDesktopDynamicToolSpec(DESKTOP_SCROLL_DYNAMIC_TOOL_NAME),
    execute: (args, context) => executeDesktopDynamicToolCall(args, context, DESKTOP_SCROLL_DYNAMIC_TOOL_NAME),
  },
  {
    namespace: DESKTOP_DYNAMIC_TOOL_NAMESPACE,
    name: DESKTOP_DRAG_DYNAMIC_TOOL_NAME,
    planMode: "sideEffecting",
    buildSpecs: () => buildDesktopDynamicToolSpec(DESKTOP_DRAG_DYNAMIC_TOOL_NAME),
    execute: (args, context) => executeDesktopDynamicToolCall(args, context, DESKTOP_DRAG_DYNAMIC_TOOL_NAME),
  },
  {
    namespace: DESKTOP_DYNAMIC_TOOL_NAMESPACE,
    name: DESKTOP_OPEN_APP_DYNAMIC_TOOL_NAME,
    planMode: "sideEffecting",
    buildSpecs: () => buildDesktopDynamicToolSpec(DESKTOP_OPEN_APP_DYNAMIC_TOOL_NAME),
    execute: (args, context) => executeDesktopDynamicToolCall(args, context, DESKTOP_OPEN_APP_DYNAMIC_TOOL_NAME),
    redactPersistedInput: (args) =>
      redactDesktopDynamicToolInputForPersistence(DESKTOP_OPEN_APP_DYNAMIC_TOOL_NAME, args),
  },
  {
    namespace: DESKTOP_DYNAMIC_TOOL_NAMESPACE,
    name: DESKTOP_FOCUS_WINDOW_DYNAMIC_TOOL_NAME,
    planMode: "sideEffecting",
    buildSpecs: () => buildDesktopDynamicToolSpec(DESKTOP_FOCUS_WINDOW_DYNAMIC_TOOL_NAME),
    execute: (args, context) => executeDesktopDynamicToolCall(args, context, DESKTOP_FOCUS_WINDOW_DYNAMIC_TOOL_NAME),
  },
  {
    namespace: DESKTOP_DYNAMIC_TOOL_NAMESPACE,
    name: DESKTOP_RECORD_START_DYNAMIC_TOOL_NAME,
    planMode: "sideEffecting",
    buildSpecs: () => buildDesktopDynamicToolSpec(DESKTOP_RECORD_START_DYNAMIC_TOOL_NAME),
    execute: (args, context) => executeDesktopDynamicToolCall(args, context, DESKTOP_RECORD_START_DYNAMIC_TOOL_NAME),
  },
  {
    namespace: DESKTOP_DYNAMIC_TOOL_NAMESPACE,
    name: DESKTOP_RECORD_STOP_DYNAMIC_TOOL_NAME,
    planMode: "sideEffecting",
    buildSpecs: () => buildDesktopDynamicToolSpec(DESKTOP_RECORD_STOP_DYNAMIC_TOOL_NAME),
    execute: (args, context) => executeDesktopDynamicToolCall(args, context, DESKTOP_RECORD_STOP_DYNAMIC_TOOL_NAME),
  },
  {
    namespace: DESKTOP_DYNAMIC_TOOL_NAMESPACE,
    name: DESKTOP_RECORD_STATUS_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: () => buildDesktopDynamicToolSpec(DESKTOP_RECORD_STATUS_DYNAMIC_TOOL_NAME),
    execute: (args, context) => executeDesktopDynamicToolCall(args, context, DESKTOP_RECORD_STATUS_DYNAMIC_TOOL_NAME),
  },
  {
    namespace: CYCLOID_DYNAMIC_TOOL_NAMESPACE,
    name: MEMORY_CONTEXT_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: buildMemoryContextDynamicToolSpec,
    execute: executeMemoryContextDynamicToolCall,
    isAvailable: isMemoryToolAvailable,
  },
  {
    namespace: CYCLOID_DYNAMIC_TOOL_NAMESPACE,
    name: MEMORY_RECALL_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: buildMemoryRecallDynamicToolSpec,
    execute: executeMemoryRecallDynamicToolCall,
    isAvailable: isMemoryToolAvailable,
  },
  {
    namespace: CYCLOID_DYNAMIC_TOOL_NAMESPACE,
    name: COMPANY_MEMORY_RECALL_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: buildCompanyMemoryRecallDynamicToolSpec,
    execute: executeCompanyMemoryRecallDynamicToolCall,
    isAvailable: isMemoryToolAvailable,
  },
  {
    namespace: CYCLOID_DYNAMIC_TOOL_NAMESPACE,
    name: COMPANY_MEMORY_REASONING_CHAIN_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: buildCompanyMemoryReasoningChainDynamicToolSpec,
    execute: executeCompanyMemoryReasoningChainDynamicToolCall,
    isAvailable: isMemoryToolAvailable,
  },
  {
    namespace: CYCLOID_DYNAMIC_TOOL_NAMESPACE,
    name: REVIEW_LOOP_REPLY_DYNAMIC_TOOL_NAME,
    planMode: "sideEffecting",
    buildSpecs: buildReviewLoopReplyDynamicToolSpec,
    execute: executeReviewLoopReplyDynamicToolCall,
    redactPersistedInput: redactReviewLoopReplyDynamicToolInput,
  },
  {
    namespace: CYCLOID_DYNAMIC_TOOL_NAMESPACE,
    name: REVIEW_SUMMARY_COMMENT_DYNAMIC_TOOL_NAME,
    planMode: "sideEffecting",
    buildSpecs: buildReviewSummaryCommentDynamicToolSpec,
    execute: executeReviewSummaryCommentDynamicToolCall,
    redactPersistedInput: redactReviewSummaryCommentDynamicToolInput,
  },
  {
    namespace: CYCLOID_DYNAMIC_TOOL_NAMESPACE,
    name: PR_REVIEW_PUBLISH_DYNAMIC_TOOL_NAME,
    planMode: "sideEffecting",
    buildSpecs: buildPrReviewPublishDynamicToolSpec,
    execute: executePrReviewPublishDynamicToolCall,
    redactPersistedInput: redactPrReviewPublishInput,
  },
  {
    namespace: CYCLOID_DYNAMIC_TOOL_NAMESPACE,
    name: GIT_SYNC_DYNAMIC_TOOL_NAME,
    planMode: "sideEffecting",
    buildSpecs: buildGitSyncDynamicToolSpec,
    execute: executeGitSyncDynamicToolCall,
  },
  {
    namespace: CYCLOID_DYNAMIC_TOOL_NAMESPACE,
    name: SPAWN_CHILD_SESSION_DYNAMIC_TOOL_NAME,
    planMode: "sideEffecting",
    buildSpecs: buildSpawnChildSessionDynamicToolSpec,
    execute: executeSpawnChildSessionDynamicToolCall,
  },
  {
    namespace: CYCLOID_DYNAMIC_TOOL_NAMESPACE,
    name: KNOWN_IMAGE_FIXTURE_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: buildKnownImageFixtureDynamicToolSpec,
    execute: executeKnownImageFixtureDynamicToolCall,
    isAvailable: isKnownImageFixtureDynamicToolAvailable,
  },
  {
    namespace: CLOUDFLARE_DYNAMIC_TOOL_NAMESPACE,
    name: CLOUDFLARE_QUERY_D1_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: buildCloudflareQueryD1DynamicToolSpec,
    execute: executeCloudflareQueryD1DynamicToolCall,
    redactPersistedInput: redactCloudflareD1DynamicToolInput,
  },
  {
    namespace: BRAINTRUST_DYNAMIC_TOOL_NAMESPACE,
    name: BRAINTRUST_LIST_PROJECTS_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: buildBraintrustListProjectsDynamicToolSpec,
    execute: executeBraintrustListProjectsDynamicToolCall,
    redactPersistedInput: redactBraintrustDynamicToolInputForPersistence,
  },
  {
    namespace: BRAINTRUST_DYNAMIC_TOOL_NAMESPACE,
    name: BRAINTRUST_QUERY_SQL_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: buildBraintrustQuerySqlDynamicToolSpec,
    execute: executeBraintrustQuerySqlDynamicToolCall,
    redactPersistedInput: redactBraintrustDynamicToolInputForPersistence,
  },
  {
    namespace: BRAINTRUST_DYNAMIC_TOOL_NAMESPACE,
    name: BRAINTRUST_SUMMARIZE_EXPERIMENT_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: buildBraintrustSummarizeExperimentDynamicToolSpec,
    execute: executeBraintrustSummarizeExperimentDynamicToolCall,
    redactPersistedInput: redactBraintrustSummarizeExperimentInputForPersistence,
  },
  {
    namespace: BRAINTRUST_DYNAMIC_TOOL_NAMESPACE,
    name: BRAINTRUST_GENERATE_PERMALINK_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: buildBraintrustGeneratePermalinkDynamicToolSpec,
    execute: executeBraintrustGeneratePermalinkDynamicToolCall,
    redactPersistedInput: redactBraintrustDynamicToolInputForPersistence,
  },
  {
    namespace: BRAINTRUST_DYNAMIC_TOOL_NAMESPACE,
    name: BRAINTRUST_INFER_SCHEMA_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: buildBraintrustInferSchemaDynamicToolSpec,
    execute: executeBraintrustInferSchemaDynamicToolCall,
    redactPersistedInput: redactBraintrustDynamicToolInputForPersistence,
  },
  {
    namespace: DATADOG_DYNAMIC_TOOL_NAMESPACE,
    name: DATADOG_SEARCH_LOGS_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: buildDatadogSearchLogsDynamicToolSpec,
    execute: executeDatadogSearchLogsDynamicToolCall,
  },
  {
    namespace: DATADOG_DYNAMIC_TOOL_NAMESPACE,
    name: DATADOG_GET_TRACE_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: buildDatadogGetTraceDynamicToolSpec,
    execute: executeDatadogGetTraceDynamicToolCall,
  },
  {
    namespace: DATADOG_DYNAMIC_TOOL_NAMESPACE,
    name: DATADOG_QUERY_METRICS_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: buildDatadogQueryMetricsDynamicToolSpec,
    execute: executeDatadogQueryMetricsDynamicToolCall,
    redactPersistedInput: redactDatadogDynamicToolInputForPersistence,
  },
  {
    namespace: DATADOG_DYNAMIC_TOOL_NAMESPACE,
    name: DATADOG_GET_MONITORS_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: buildDatadogGetMonitorsDynamicToolSpec,
    execute: executeDatadogGetMonitorsDynamicToolCall,
  },
  {
    namespace: LAUNCHDARKLY_DYNAMIC_TOOL_NAMESPACE,
    name: LAUNCHDARKLY_LIST_FEATURE_FLAGS_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: buildLaunchDarklyListFeatureFlagsDynamicToolSpec,
    execute: executeLaunchDarklyListFeatureFlagsDynamicToolCall,
    redactPersistedInput: redactLaunchDarklyDynamicToolInputForPersistence,
  },
  {
    namespace: LAUNCHDARKLY_DYNAMIC_TOOL_NAMESPACE,
    name: LAUNCHDARKLY_GET_FEATURE_FLAG_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: buildLaunchDarklyGetFeatureFlagDynamicToolSpec,
    execute: executeLaunchDarklyGetFeatureFlagDynamicToolCall,
    redactPersistedInput: redactLaunchDarklyDynamicToolInputForPersistence,
  },
  {
    namespace: LAUNCHDARKLY_DYNAMIC_TOOL_NAMESPACE,
    name: LAUNCHDARKLY_PATCH_FEATURE_FLAG_DYNAMIC_TOOL_NAME,
    planMode: "sideEffecting",
    buildSpecs: buildLaunchDarklyPatchFeatureFlagDynamicToolSpec,
    execute: executeLaunchDarklyPatchFeatureFlagDynamicToolCall,
    redactPersistedInput: redactLaunchDarklyDynamicToolInputForPersistence,
  },
  {
    namespace: JIRA_DYNAMIC_TOOL_NAMESPACE,
    name: JIRA_CREATE_ISSUE_DYNAMIC_TOOL_NAME,
    planMode: "sideEffecting",
    buildSpecs: buildJiraCreateIssueDynamicToolSpec,
    execute: executeJiraCreateIssueDynamicToolCall,
    redactPersistedInput: redactJiraDynamicToolInputForPersistence,
  },
  {
    namespace: JIRA_DYNAMIC_TOOL_NAMESPACE,
    name: JIRA_GET_ISSUE_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: buildJiraGetIssueDynamicToolSpec,
    execute: executeJiraGetIssueDynamicToolCall,
  },
  {
    namespace: JIRA_DYNAMIC_TOOL_NAMESPACE,
    name: JIRA_LIST_COMMENTS_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: buildJiraListCommentsDynamicToolSpec,
    execute: executeJiraListCommentsDynamicToolCall,
  },
  {
    namespace: JIRA_DYNAMIC_TOOL_NAMESPACE,
    name: JIRA_ADD_COMMENT_DYNAMIC_TOOL_NAME,
    planMode: "sideEffecting",
    buildSpecs: buildJiraAddCommentDynamicToolSpec,
    execute: executeJiraAddCommentDynamicToolCall,
    redactPersistedInput: redactJiraDynamicToolInputForPersistence,
  },
  {
    namespace: JIRA_DYNAMIC_TOOL_NAMESPACE,
    name: JIRA_SEARCH_ISSUES_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: buildJiraSearchIssuesDynamicToolSpec,
    execute: executeJiraSearchIssuesDynamicToolCall,
    redactPersistedInput: redactJiraDynamicToolInputForPersistence,
  },
  {
    namespace: JIRA_DYNAMIC_TOOL_NAMESPACE,
    name: JIRA_LIST_TRANSITIONS_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: buildJiraListTransitionsDynamicToolSpec,
    execute: executeJiraListTransitionsDynamicToolCall,
  },
  {
    namespace: JIRA_DYNAMIC_TOOL_NAMESPACE,
    name: JIRA_TRANSITION_ISSUE_DYNAMIC_TOOL_NAME,
    planMode: "sideEffecting",
    buildSpecs: buildJiraTransitionIssueDynamicToolSpec,
    execute: executeJiraTransitionIssueDynamicToolCall,
  },
  {
    namespace: NOTION_DYNAMIC_TOOL_NAMESPACE,
    name: NOTION_SEARCH_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: buildNotionSearchDynamicToolSpec,
    execute: executeNotionSearchDynamicToolCall,
  },
  {
    namespace: NOTION_DYNAMIC_TOOL_NAMESPACE,
    name: NOTION_GET_BLOCK_CHILDREN_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: buildNotionGetBlockChildrenDynamicToolSpec,
    execute: executeNotionGetBlockChildrenDynamicToolCall,
  },
  {
    namespace: SENTRY_DYNAMIC_TOOL_NAMESPACE,
    name: SENTRY_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: buildSentryDynamicToolSpec,
    execute: executeSentryDynamicToolCall,
  },
  {
    namespace: SENTRY_DYNAMIC_TOOL_NAMESPACE,
    name: SENTRY_SEARCH_ISSUES_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: buildSentrySearchIssuesDynamicToolSpec,
    execute: executeSentrySearchIssuesDynamicToolCall,
    redactPersistedInput: redactSentryDynamicToolInputForPersistence,
  },
  {
    namespace: SLACK_DYNAMIC_TOOL_NAMESPACE,
    name: SLACK_GET_THREAD_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: buildSlackGetThreadDynamicToolSpec,
    execute: executeSlackGetThreadDynamicToolCall,
  },
  {
    namespace: SLACK_DYNAMIC_TOOL_NAMESPACE,
    name: SLACK_SEARCH_MESSAGES_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: buildSlackSearchMessagesDynamicToolSpec,
    execute: executeSlackSearchMessagesDynamicToolCall,
  },
  {
    namespace: SLACK_DYNAMIC_TOOL_NAMESPACE,
    name: SLACK_SEND_MESSAGE_DYNAMIC_TOOL_NAME,
    planMode: "sideEffecting",
    buildSpecs: buildSlackSendMessageDynamicToolSpec,
    execute: executeSlackSendMessageDynamicToolCall,
    redactPersistedInput: (args) =>
      redactSlackDynamicToolInputForPersistence(SLACK_SEND_MESSAGE_DYNAMIC_TOOL_NAME, args),
  },
  {
    namespace: TERRAFORM_DYNAMIC_TOOL_NAMESPACE,
    name: TERRAFORM_PLAN_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: buildTerraformPlanDynamicToolSpec,
    execute: executeTerraformPlanDynamicToolCall,
    redactPersistedInput: redactTerraformPlanDynamicToolInput,
  },
  {
    namespace: VERCEL_DYNAMIC_TOOL_NAMESPACE,
    name: VERCEL_GET_DEPLOYMENT_FOR_REF_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: buildVercelGetDeploymentForRefDynamicToolSpec,
    execute: executeVercelGetDeploymentForRefDynamicToolCall,
    redactPersistedInput: redactVercelDynamicToolInputForPersistence,
  },
  {
    namespace: VERCEL_DYNAMIC_TOOL_NAMESPACE,
    name: VERCEL_GET_PREVIEW_URL_DYNAMIC_TOOL_NAME,
    planMode: "readOnly",
    buildSpecs: buildVercelGetPreviewUrlDynamicToolSpec,
    execute: executeVercelGetPreviewUrlDynamicToolCall,
    redactPersistedInput: redactVercelDynamicToolInputForPersistence,
  },
];

const MERGED_FIRST_PARTY_DYNAMIC_TOOL_REGISTRY: readonly FirstPartyDynamicToolRegistration[] =
  mergeFirstPartyDynamicToolRegistrations(
    FIRST_PARTY_DYNAMIC_TOOL_REGISTRY,
    buildLoadedFirstPartyDynamicToolRegistrations(),
  );

const FIRST_PARTY_DYNAMIC_TOOL_REGISTRY_BY_KEY = new Map(
  MERGED_FIRST_PARTY_DYNAMIC_TOOL_REGISTRY.map((registration) => [
    firstPartyDynamicToolKey(registration.namespace, registration.name),
    registration,
  ]),
);

function mergeFirstPartyDynamicToolRegistrations(
  legacyRegistrations: readonly FirstPartyDynamicToolRegistration[],
  loadedRegistrations: readonly FirstPartyDynamicToolRegistration[],
): FirstPartyDynamicToolRegistration[] {
  const merged = new Map<string, FirstPartyDynamicToolRegistration>();
  for (const registration of legacyRegistrations) {
    const key = firstPartyDynamicToolKey(registration.namespace, registration.name);
    if (merged.has(key)) throw new Error(`Duplicate legacy first-party dynamic tool registration: ${key}`);
    merged.set(key, registration);
  }
  for (const registration of loadedRegistrations) {
    const key = firstPartyDynamicToolKey(registration.namespace, registration.name);
    if (merged.has(key))
      throw new Error(`Loaded first-party dynamic tool unexpectedly duplicates legacy registration: ${key}`);
    merged.set(key, registration);
  }
  return [...merged.values()];
}

export type FirstPartyDynamicToolPlanMode = FirstPartyDynamicToolRegistration["planMode"];

export function getFirstPartyDynamicToolPlanMode(toolKey: string): FirstPartyDynamicToolPlanMode | null {
  return FIRST_PARTY_DYNAMIC_TOOL_REGISTRY_BY_KEY.get(toolKey)?.planMode ?? null;
}

export function getFirstPartyDynamicToolPlanModeDeclarations(): Array<{
  key: string;
  namespace: string;
  planMode: FirstPartyDynamicToolPlanMode;
}> {
  return MERGED_FIRST_PARTY_DYNAMIC_TOOL_REGISTRY.map((registration) => ({
    key: firstPartyDynamicToolKey(registration.namespace, registration.name),
    namespace: registration.namespace,
    planMode: registration.planMode,
  }));
}

export function getRegisteredFirstPartyDynamicToolKeys(): ReadonlySet<string> {
  return new Set(getFirstPartyDynamicToolPlanModeDeclarations().map((declaration) => declaration.key));
}

type DynamicToolBuildOptions = {
  agentRole?: AgentRole;
};

function normalizeDynamicToolAgentRole(value: unknown): AgentRole | null {
  if (value === "implementation" || value === "verification" || value === "review") {
    return value;
  }
  return null;
}

function resolveDynamicToolAgentRole(
  env: NodeJS.ProcessEnv | Record<string, string>,
  options?: DynamicToolBuildOptions,
): AgentRole | null {
  return normalizeDynamicToolAgentRole(options?.agentRole) ?? normalizeDynamicToolAgentRole(env.ARCANIST_AGENT_ROLE);
}

function isDynamicToolRegistrationAllowedForAgentRole(
  registration: FirstPartyDynamicToolRegistration,
  agentRole: AgentRole | null,
): boolean {
  if (!isQaTesterAgentRole(agentRole) && !isCodeReviewerAgentRole(agentRole)) return true;
  if (registration.planMode === "readOnly") return true;
  const toolKey = firstPartyDynamicToolKey(registration.namespace, registration.name);
  if (isQaTesterAgentRole(agentRole)) return VERIFICATION_SIDE_EFFECTING_DYNAMIC_TOOL_ALLOWLIST.has(toolKey);
  return REVIEW_SIDE_EFFECTING_DYNAMIC_TOOL_ALLOWLIST.has(toolKey);
}

export function buildAllDynamicToolSpecs(
  env: NodeJS.ProcessEnv | Record<string, string>,
  options: DynamicToolBuildOptions = {},
): FirstPartyDynamicToolSpec[] {
  const agentRole = resolveDynamicToolAgentRole(env, options);
  return MERGED_FIRST_PARTY_DYNAMIC_TOOL_REGISTRY.filter((registration) =>
    isFirstPartyDynamicToolAvailable(registration, env),
  )
    .filter((registration) => isDynamicToolRegistrationAllowedForAgentRole(registration, agentRole))
    .flatMap((registration) => registration.buildSpecs(env));
}

export function getAvailableFirstPartyDynamicToolNames(
  env: NodeJS.ProcessEnv | Record<string, string>,
  options: DynamicToolBuildOptions = {},
): ReadonlySet<string> {
  return new Set(
    buildAllDynamicToolSpecs(env, options).map((tool) => firstPartyDynamicToolKey(tool.namespace, tool.name)),
  );
}

export function redactFirstPartyDynamicToolInputForPersistence(
  namespace: string,
  name: string,
  args: unknown,
): Record<string, unknown> | null | undefined {
  const registration = FIRST_PARTY_DYNAMIC_TOOL_REGISTRY_BY_KEY.get(firstPartyDynamicToolKey(namespace, name));
  return registration?.redactPersistedInput?.(args);
}

export function getFirstPartyDynamicToolTextContentItems(
  result: FirstPartyDynamicToolCallResult,
): FirstPartyDynamicToolTextContentItem[] {
  return result.contentItems.filter((item): item is FirstPartyDynamicToolTextContentItem => item.type === "inputText");
}

export function serializeFirstPartyDynamicToolResultForPersistence(result: FirstPartyDynamicToolCallResult): string {
  return serializeFirstPartyDynamicToolContentItemsForPersistence(result.contentItems, result.success);
}

export function serializeFirstPartyDynamicToolContentItemsForPersistence(
  contentItems: readonly unknown[],
  success: boolean,
): string {
  const textContentItems = contentItems.filter(
    (item): item is FirstPartyDynamicToolTextContentItem =>
      isUnknownRecord(item) && item.type === "inputText" && typeof item.text === "string",
  );
  if (textContentItems.length > 0) return JSON.stringify(textContentItems);
  return JSON.stringify({ success });
}

export async function executeFirstPartyDynamicToolCall(
  namespace: string,
  name: string,
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const toolKey = firstPartyDynamicToolKey(namespace, name);
  const registration = FIRST_PARTY_DYNAMIC_TOOL_REGISTRY_BY_KEY.get(toolKey);
  if (!registration || !isFirstPartyDynamicToolAvailable(registration, context.env)) {
    const result: FirstPartyDynamicToolCallResult = {
      success: false,
      errorCode: "not_registered",
      contentItems: [
        {
          type: "inputText",
          text: `First-party dynamic tool '${toolKey}' is not registered for this session.`,
        },
      ],
    };
    const guidedResult = appendRecoveryGuidance(result);
    logDynamicToolFailure({ namespace, name, args, context, result: guidedResult });
    return guidedResult;
  }
  const agentRole = resolveDynamicToolAgentRole(context.env, context);
  if (!isDynamicToolRegistrationAllowedForAgentRole(registration, agentRole)) {
    const result: FirstPartyDynamicToolCallResult = {
      success: false,
      errorCode: DYNAMIC_TOOL_ERROR_CODES.BLOCKED,
      contentItems: [
        {
          type: "inputText",
          text: `Policy block: ${agentRole} sessions cannot use side-effecting first-party dynamic tool '${toolKey}'.`,
        },
      ],
    };
    const guidedResult = appendRecoveryGuidance(result);
    logDynamicToolFailure({ namespace, name, args, context, result: guidedResult });
    return guidedResult;
  }
  if (
    context.agentProfile === PLAN_AGENT_NAME &&
    registration.planMode !== "readOnly" &&
    registration.namespace !== DESKTOP_DYNAMIC_TOOL_NAMESPACE
  ) {
    const result: FirstPartyDynamicToolCallResult = {
      success: false,
      errorCode: "blocked",
      contentItems: [
        {
          type: "inputText",
          text: `Policy block: plan mode is read-only; first-party dynamic tool '${toolKey}' is not permitted.`,
        },
      ],
    };
    const guidedResult = appendRecoveryGuidance(result);
    logDynamicToolFailure({ namespace, name, args, context, result: guidedResult });
    return guidedResult;
  }
  // Structural input gate shared by both agent backends. Tool-specific
  // semantic validation still runs inside each tool's execute function.
  const validation = validateDynamicToolRegistrationInput(registration, namespace, name, args);
  if (!validation.ok) {
    const result: FirstPartyDynamicToolCallResult = {
      success: false,
      errorCode: "invalid_input",
      contentItems: [{ type: "inputText", text: validation.message }],
    };
    const guidedResult = appendRecoveryGuidance(result);
    logDynamicToolFailure({ namespace, name, args, context, result: guidedResult });
    return guidedResult;
  }

  const integrationId =
    LIFECYCLE_INTEGRATION_BY_NAMESPACE[namespace as keyof typeof LIFECYCLE_INTEGRATION_BY_NAMESPACE];
  const sessionId = context.env["SESSION_ID"]?.trim() || null;

  if (integrationId && sessionId) {
    postLifecycleEventInBackground({
      sessionId,
      integrationId,
      stage: INTEGRATION_LIFECYCLE_STAGE.RUNTIME_ATTACHED,
      status: INTEGRATION_LIFECYCLE_STATUS.PASSED,
      message: `${integrationId} runtime attached in the sandbox bridge.`,
      context,
    });
  }

  let result: FirstPartyDynamicToolCallResult = {
    success: false,
    errorCode: "execution_failed",
    contentItems: [{ type: "inputText", text: "Tool execution failed" }],
  };
  for (let attempt = 1; attempt <= RATE_LIMIT_RETRY_MAX_ATTEMPTS; attempt++) {
    result = await registration.execute(validation.value, context);
    if (result.success) {
      break;
    }
    if (result.errorCode !== DYNAMIC_TOOL_ERROR_CODES.UPSTREAM_RATE_LIMITED) {
      break;
    }
    if (attempt < RATE_LIMIT_RETRY_MAX_ATTEMPTS) {
      const fallbackBackoffMs = RATE_LIMIT_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      const retryDelayMs =
        typeof result.retryAfterMs === "number" && result.retryAfterMs >= 0
          ? Math.max(result.retryAfterMs, fallbackBackoffMs)
          : fallbackBackoffMs;
      await delay(retryDelayMs, context.signal);
    }
  }

  const finalResult = appendRecoveryGuidance(result);

  if (!finalResult.success) {
    logDynamicToolFailure({ namespace, name, args: validation.value, context, result: finalResult });
  }

  if (integrationId && sessionId) {
    postLifecycleEventInBackground({
      sessionId,
      integrationId,
      stage: INTEGRATION_LIFECYCLE_STAGE.FIRST_TOOL_CALL_PASSED,
      status: finalResult.success ? INTEGRATION_LIFECYCLE_STATUS.PASSED : INTEGRATION_LIFECYCLE_STATUS.FAILED,
      reasonCode: finalResult.success ? null : lifecycleReasonForToolFailure(finalResult.errorCode),
      message: finalResult.success
        ? `${integrationId} first dynamic tool call succeeded in the sandbox bridge.`
        : `${integrationId} first dynamic tool call failed in the sandbox bridge.`,
      context,
      details: finalResult.success ? undefined : { providerErrorCode: finalResult.errorCode ?? null },
    });
  }

  return finalResult;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function validateDynamicToolRegistrationInput(
  registration: FirstPartyDynamicToolRegistration,
  namespace: string,
  name: string,
  args: unknown,
): { ok: true; value: unknown } | { ok: false; message: string } {
  if (!registration.validateInput) return validateFirstPartyDynamicToolInput(namespace, name, args);
  try {
    return { ok: true, value: registration.validateInput(args) };
  } catch (error) {
    return {
      ok: false,
      message: `${firstPartyDynamicToolKey(namespace, name)} input invalid: ${
        error instanceof Error ? error.message : "invalid input"
      }`,
    };
  }
}
