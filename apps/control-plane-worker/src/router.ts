import * as Sentry from "@sentry/cloudflare";

import { ENVIRONMENT, normalizeEnvironment } from "../../../shared/constants/environment.js";
import { HTTP_HEADER_NAMES } from "../../../shared/constants/http-headers.js";
import { INTEGRATION_LIFECYCLE_STATUS } from "../../../shared/enums/integration-lifecycle.js";
import type { SpanAttributes } from "../../../shared/observability/trace.js";
import { deleteExpiredAuthSessions } from "./auth/db";
import { authenticateRequest } from "./auth/routes";
import {
  ADMIN_TOKEN_ROUTE_ALLOWLIST,
  CI_AUTOMATION_TOKEN_ROUTE_ALLOWLIST,
  type RouteAllowlist,
} from "./constants/auth-tokens";
import { CLI_TOKEN_ROUTE_ALLOWLIST } from "./constants/cli-tokens";
import { CONTROL_PLANE_SERVICE_NAME } from "./constants/observability";
import { GC_CRON } from "./constants/scheduler";
import { isTransientD1StorageError } from "./db/errors";
import { createLogger, type Logger, type LogLevel, setLoggerErrorHandler } from "./logger";
import { endSpan, extractTraceparent, runInSpan, setSpanAttributes, startSpan } from "./observability/context";
import { flushSpansToQueue } from "./observability/exporter";
import { resolveSentryRuntimeOptions } from "./observability/sentry";
import { captureRepeatedException } from "./observability/sentry-repeat-suppression";
import { tracedEnv } from "./observability/wrappers";
import { parsePattern, type Route } from "./routes/shared";
import { controlPlaneRoutes } from "./routes/table";
import { warnOnInvalidCriticalSecretsOnce } from "./services/secret-validation";
import { warmPublicFetchPath } from "./services/warm";
import type { AuthInfo, CliTokenScope, Env } from "./types";
import { applyStandardHeaders, corsOrigin, jsonErrorResponse, verifySandboxPromptCallbackAuth } from "./utils";
import { deleteExpiredSlackRepoDisambiguations, deleteExpiredWebhookIdempotencyClaims } from "./webhooks/db";

// Register logger error auto-capture once; the callback itself runs during requests.
// Repeat-suppressed: a permanently failing loop logging the same error every
// tick (e.g. the E2B client's "operation failed" error log) must not burn the
// Sentry quota; the log line itself still ships every occurrence to Datadog.
// The key includes stable classification context fields because bridged
// errors are often synthesized from a fixed log message (no `error` field),
// so the message alone cannot distinguish e.g. distinct E2B error codes.
setLoggerErrorHandler((err, context) => {
  const scope = [context.component ?? "logger", context.method, context.errorCode, context.status]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("|");
  captureRepeatedException(scope, err, { tags: context });
});

const SILENT_LOG_PATHS = new Set(["/health", "/api/health", "/api/health/warm"]);

/**
 * Source-network log fields for the "Request handled" line. `cf_ip`/`asn` are
 * non-indexed Datadog attributes used for abuse triage; both read defensively
 * because `request.cf` is absent in local/dev and on non-Cloudflare paths.
 */
export function requestSourceLogFields(request: Request): {
  cf: { colo?: string; country?: string } | null;
  cf_ip: string | null;
  asn: number | null;
} {
  const cf = (request as unknown as { cf?: { colo?: string; country?: string; asn?: number } }).cf;
  return {
    cf: cf ? { colo: cf.colo, country: cf.country } : null,
    // Only trust cf-connecting-ip when Cloudflare metadata is present. On a
    // non-Cloudflare path (direct origin, misconfigured proxy) the header is
    // attacker-controllable, so a spoofed value must not surface as a non-null
    // cf_ip that abuse triage would treat as Cloudflare-verified.
    cf_ip: cf ? request.headers.get("cf-connecting-ip")?.trim() || null : null,
    asn: typeof cf?.asn === "number" ? cf.asn : null,
  };
}

/**
 * Flatten the source-network fields into primitive span attributes, omitting
 * nulls. `startSpan`/`endSpan` do not drop null/undefined and `SpanAttributes`
 * must be primitive, so the nested `cf` object and nullable fields from
 * `requestSourceLogFields` cannot be spread in raw. The exporter prefixes every
 * span attribute with `span.`, so these surface in Datadog as `@span.cf_ip`,
 * `@span.asn`, `@span.cf.colo`, `@span.cf.country` (not bare `@cf_ip`). Retained
 * only on 4xx spans (see usage) for manual abuse triage while bounding client-IP
 * (PII) retention and per-request log cardinality.
 */
export function sourceNetworkSpanFields(request: Request): SpanAttributes {
  const { cf, cf_ip, asn } = requestSourceLogFields(request);
  const fields: SpanAttributes = {};
  if (cf_ip) fields["cf_ip"] = cf_ip;
  if (typeof asn === "number") fields["asn"] = asn;
  if (cf?.colo) fields["cf.colo"] = cf.colo;
  if (cf?.country) fields["cf.country"] = cf.country;
  return fields;
}

const routerLog = createLogger({ bindings: { component: "router" } });

export function buildRouteMatchers(entries: RouteAllowlist): Array<{ method: string; pattern: RegExp }> {
  return entries.map(([method, pattern]) => ({
    method,
    pattern: parsePattern(pattern),
  }));
}

const CLI_TOKEN_ROUTE_MATCHERS = Object.fromEntries(
  Object.entries(CLI_TOKEN_ROUTE_ALLOWLIST).map(([scope, entries]) => [scope, buildRouteMatchers(entries)]),
) as Record<CliTokenScope, Array<{ method: string; pattern: RegExp }>>;

const ADMIN_TOKEN_ROUTE_MATCHERS = buildRouteMatchers(ADMIN_TOKEN_ROUTE_ALLOWLIST);
const CI_AUTOMATION_TOKEN_ROUTE_MATCHERS = buildRouteMatchers(CI_AUTOMATION_TOKEN_ROUTE_ALLOWLIST);

const MUTATING_HTTP_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

interface RouteRecorder {
  route: string | undefined;
}

function recordRoute(matchedRoute: RouteRecorder, route: string): void {
  matchedRoute.route = route;
  Sentry.setTag("route", route);
  setSpanAttributes({ "http.route": route });
}

function tagAuthenticatedRequestSpan(auth: AuthInfo): void {
  const spanUserId = auth.actorUserId ?? auth.userId;
  const spanUserLogin = auth.actorUserId ? auth.actorUser?.login : auth.user?.login;
  setSpanAttributes({
    "user.id": spanUserId,
    "user.login": spanUserLogin,
  });
}

/**
 * Returns true when the router should reject this request because the caller
 * is impersonating and the route is considered mutating. Default policy is
 * "deny mutating HTTP methods, allow safe methods". A route can opt out with
 * `impersonationReadOnlyAllowed: true` (e.g. revoke, logout) or opt in for a
 * `GET` that has side effects with `impersonationMutatingGet: true`.
 */
export function routeMutatesUnderImpersonation(
  method: string,
  route: Pick<Route, "impersonationReadOnlyAllowed" | "impersonationMutatingGet">,
): boolean {
  if (route.impersonationReadOnlyAllowed) return false;
  if (MUTATING_HTTP_METHODS.has(method)) return true;
  if (route.impersonationMutatingGet) return true;
  return false;
}
const DAY_MS = 24 * 60 * 60 * 1000;
const REVIEW_LOOP_FAST_DISPATCH_CRON = "* * * * *";
const QUEUE_SEND_BATCH_MAX_MESSAGES = 100;
const QUEUE_SEND_BATCH_MAX_BYTES = 256 * 1000;
const QUEUE_SEND_BATCH_METADATA_BYTES_PER_MESSAGE = 100;
const INTEGRATION_LIFECYCLE_RETENTION_LIMIT = 12_000;
const INTEGRATION_LIFECYCLE_RETENTION_POLICIES = [
  { status: INTEGRATION_LIFECYCLE_STATUS.PASSED, retainForMs: 30 * DAY_MS },
  { status: INTEGRATION_LIFECYCLE_STATUS.FAILED, retainForMs: 90 * DAY_MS },
  { status: INTEGRATION_LIFECYCLE_STATUS.SKIPPED, retainForMs: 14 * DAY_MS },
] as const;

function queueSendBatchChunks<Body>(bodies: readonly Body[]): MessageSendRequest<Body>[][] {
  const encoder = new TextEncoder();
  const chunks: MessageSendRequest<Body>[][] = [];
  let current: MessageSendRequest<Body>[] = [];
  let currentBytes = 0;
  for (const body of bodies) {
    const bodyBytes = encoder.encode(JSON.stringify(body)).byteLength + QUEUE_SEND_BATCH_METADATA_BYTES_PER_MESSAGE;
    if (
      current.length > 0 &&
      (current.length >= QUEUE_SEND_BATCH_MAX_MESSAGES || currentBytes + bodyBytes > QUEUE_SEND_BATCH_MAX_BYTES)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push({ body });
    currentBytes += bodyBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// Scheduled task failure messages are expected to end in "failed" or "error".
function scheduledTaskLabel(taskName: string): string {
  return taskName.replace(/\s+(?:failed|error)$/i, "");
}

export function handleTransientOrFatalError(
  err: unknown,
  logger: Pick<Logger, "warn">,
  taskName: string,
  sentryTags: Record<string, string> = { component: "scheduler" },
): void {
  if (isTransientD1StorageError(err)) {
    logger.warn({ transientError: String(err) }, `${scheduledTaskLabel(taskName)} skipped due to transient D1 error`);
    return;
  }

  // At most one intentional Sentry event per scheduled failure per
  // suppression window — a permanently failing 5-minute task must not report
  // every tick. The follow-up log is emitted at warn level (not error) on
  // every occurrence because the worker-wide setLoggerErrorHandler bridge
  // converts every error-level log into a second Sentry event — even
  // synthesizing one from the `msg` arg when no `error` field is present.
  // Warn-level only triggers that bridge when an `error` field is present,
  // so this payload is safe and keeps Datadog visibility full-fidelity.
  captureRepeatedException(taskName, err, {
    tags: sentryTags,
    extra: { failureMessage: taskName },
  });
  logger.warn({ errorMessage: String(err), failureMessage: taskName, ...sentryTags }, taskName);
}

function canCliTokenAccessRoute(scope: CliTokenScope, method: string, pathname: string): boolean {
  return CLI_TOKEN_ROUTE_MATCHERS[scope].some((entry) => entry.method === method && entry.pattern.test(pathname));
}

// ARC-830: any /api/sessions/* path is session-scoped and requires
// explicit business-scope enforcement when reached by an MCP / CLI token.
const SESSION_SCOPED_PATH_PATTERN = /^\/api\/sessions(?:\/|$)/;
export function isSessionScopedPath(pathname: string): boolean {
  return SESSION_SCOPED_PATH_PATTERN.test(pathname);
}

export function canAccessAllowlistedRoute(
  entries: Array<{ method: string; pattern: RegExp }>,
  method: string,
  pathname: string,
): boolean {
  return entries.some((entry) => entry.method === method && entry.pattern.test(pathname));
}

function validateAuthRouteAccess(
  auth: AuthInfo,
  method: string,
  pathname: string,
  route: Route,
  requestId?: string | null,
): Response | null {
  if (route.auth === "automation") {
    const isAllowed =
      auth.authMode === "admin_token"
        ? canAccessAllowlistedRoute(ADMIN_TOKEN_ROUTE_MATCHERS, method, pathname)
        : auth.authMode === "ci_automation_token"
          ? canAccessAllowlistedRoute(CI_AUTOMATION_TOKEN_ROUTE_MATCHERS, method, pathname)
          : false;
    return isAllowed ? null : jsonErrorResponse("Forbidden: this token does not have access to this route", 403);
  }

  if (route.auth !== "authenticated") return null;

  if (auth.authMode === "cli_token") {
    if (!auth.cliTokenScope || !canCliTokenAccessRoute(auth.cliTokenScope, method, pathname)) {
      return jsonErrorResponse("Forbidden: CLI tokens cannot access this resource", 403);
    }
    if (isSessionScopedPath(pathname) && !route.mcpBusinessScopeEnforced) {
      routerLog.warn(
        {
          action: "cli_token_session_route_missing_business_scope_flag",
          method,
          path: pathname,
          requestId,
        },
        "CLI-token request hit a session-scoped route without mcpBusinessScopeEnforced; failing closed",
      );
      return jsonErrorResponse("Not found", 404);
    }
    return null;
  }

  if (auth.authMode === "admin_token" && !canAccessAllowlistedRoute(ADMIN_TOKEN_ROUTE_MATCHERS, method, pathname)) {
    return jsonErrorResponse("Forbidden: admin token cannot access this resource", 403);
  }

  if (
    auth.authMode === "ci_automation_token" &&
    !canAccessAllowlistedRoute(CI_AUTOMATION_TOKEN_ROUTE_MATCHERS, method, pathname)
  ) {
    return jsonErrorResponse("Forbidden: CI automation token cannot access this resource", 403);
  }

  return null;
}

export default Sentry.withSentry(
  (env: Env) => ({
    ...resolveSentryRuntimeOptions(env), // supplies dsn, enabled, environment
    release: env.SENTRY_RELEASE,
    tracesSampleRate: 0, // Custom tracing via observability/context.ts
  }),
  {
    async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);
      const start = Date.now();
      const requestId = crypto.randomUUID();

      // Extract incoming traceparent (from browser RUM or upstream)
      const incoming = extractTraceparent(request.headers.get("traceparent"));
      // Extract session ID from URL if present (e.g. /api/sessions/{id}/send)
      const sessionIdMatch = url.pathname.match(/\/(?:api\/)?sessions\/([^/]+)/);
      const urlSessionId = sessionIdMatch?.[1];

      const rootSpan = startSpan("worker.fetch", {
        "http.method": request.method,
        "http.route": url.pathname,
        "request.id": requestId,
        ...(urlSessionId ? { "session.id": urlSessionId } : {}),
        ...(incoming ? { "parent.trace_id": incoming.traceId } : {}),
      });
      // Override traceId if incoming traceparent exists
      if (incoming) {
        rootSpan.traceId = incoming.traceId;
        rootSpan.parentSpanId = incoming.parentSpanId;
      }

      const tEnv = tracedEnv(env);

      Sentry.setTag("route", url.pathname);
      Sentry.setTag("method", request.method);
      Sentry.setTag("requestId", requestId);
      if (urlSessionId) Sentry.setTag("sessionId", urlSessionId);

      const logger = createLogger({
        level: (env.LOG_LEVEL as LogLevel) || undefined,
        bindings: { component: "router", requestId },
      });
      const matchedRoute: RouteRecorder = { route: undefined };

      warnOnInvalidCriticalSecretsOnce(env, logger);

      // Attach requestId to request headers for downstream propagation
      const enrichedRequest = new Request(request, {
        headers: new Headers([...request.headers.entries(), [HTTP_HEADER_NAMES.REQUEST_ID, requestId]]),
      });

      // Run entire request lifecycle inside span context so endSpan + drainSpans
      // can read from AsyncLocalStorage (ALS scope ends when runInSpan returns).
      const { response, flushPromise } = (await runInSpan(rootSpan, async () => {
        let res: Response;
        try {
          res = await handleRequest(enrichedRequest, url, tEnv, matchedRoute, ctx);
          Sentry.setTag("route", matchedRoute.route ?? "unmatched");
          endSpan(rootSpan, "ok", {
            "http.status_code": res.status,
            // Attach source-network fields only on 4xx for manual abuse triage
            // without retaining client IPs on every request. Use the original
            // `request` (carries `request.cf`);
            // `enrichedRequest` is rebuilt and drops the `cf` property.
            ...(res.status >= 400 && res.status <= 499 ? sourceNetworkSpanFields(request) : {}),
          });
        } catch (err) {
          Sentry.setTag("route", matchedRoute.route ?? "unmatched");
          endSpan(rootSpan, "error", { "error.message": String(err) });
          Sentry.captureException(err);
          logger.error(
            {
              method: request.method,
              path: url.pathname,
              route: matchedRoute.route ?? "unmatched",
              error: String(err),
            },
            "Unhandled request error",
          );
          res = jsonErrorResponse("Internal server error", 500);
        }

        // Flush spans while still inside ALS scope so drainSpans() can read the store
        const flush = flushSpansToQueue(
          env.TRACE_QUEUE,
          CONTROL_PLANE_SERVICE_NAME,
          normalizeEnvironment(env.WORKER_ENV, ENVIRONMENT.Production),
        );
        return { response: res, flushPromise: flush };
      })) as { response: Response; flushPromise: Promise<void> };
      if (ctx) ctx.waitUntil(flushPromise);

      if (!SILENT_LOG_PATHS.has(url.pathname)) {
        const status = response.status;
        logger.info(
          {
            method: request.method,
            path: url.pathname,
            route: matchedRoute.route ?? "unmatched",
            status,
            duration_ms: Date.now() - start,
            ...requestSourceLogFields(request),
          },
          "Request handled",
        );
      }

      return applyStandardHeaders(response, request, env);
    },
    async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
      const isGcTick = controller.cron === GC_CRON;
      const shouldRunFastTier = !isGcTick;
      const logger = createLogger({
        level: (env.LOG_LEVEL as LogLevel) || undefined,
        bindings: { component: "scheduler", cron: controller.cron },
      });

      function withScheduledTask(
        failureMessage: string,
        fn: (db: D1Database) => Promise<void>,
        options: { requiresDb: true },
      ): Promise<void>;
      function withScheduledTask(
        failureMessage: string,
        fn: () => Promise<void>,
        options: { requiresDb: false },
      ): Promise<void>;
      async function withScheduledTask(
        failureMessage: string,
        fn: ((db: D1Database) => Promise<void>) | (() => Promise<void>),
        options: { requiresDb: boolean },
      ): Promise<void> {
        try {
          if (options.requiresDb === false) {
            await (fn as () => Promise<void>)();
          } else {
            if (!env.DB) return;
            await (fn as (db: D1Database) => Promise<void>)(env.DB);
          }
        } catch (err) {
          handleTransientOrFatalError(err, logger, failureMessage, {
            component: "scheduler",
            ...(controller.cron ? { cron: controller.cron } : {}),
          });
        }
      }

      if (controller.cron === REVIEW_LOOP_FAST_DISPATCH_CRON) {
        const scheduledAtMs =
          typeof controller.scheduledTime === "number" && Number.isFinite(controller.scheduledTime)
            ? controller.scheduledTime
            : Date.now();
        if (new Date(scheduledAtMs).getUTCMinutes() % 5 === 0) {
          logger.info({ scheduledAtMs }, "Skipping fast review-loop dispatch on full-sweep minute");
          return;
        }
        ctx.waitUntil(
          withScheduledTask(
            "Review-loop epoch dispatch sweep failed",
            async () => {
              const { runReviewLoopEpochDispatchSweep } = await import("./services/review-loop-sweep.js");
              await runReviewLoopEpochDispatchSweep(tracedEnv(env), { logger });
            },
            { requiresDb: true },
          ),
        );
        // Verification completion has a hard ten-minute budget. Sample total
        // verifier age on this existing one-minute cron so detection is bounded
        // to roughly one tick; full-sweep minutes run the same helper through
        // runSessionStallSweep below.
        ctx.waitUntil(
          withScheduledTask(
            "Verification session stall sweep failed",
            async () => {
              const { runVerificationSessionStallSweep } = await import("./services/session-stall-sweep.js");
              await runVerificationSessionStallSweep(env, { logger });
            },
            { requiresDb: true },
          ),
        );
        return;
      }

      if (shouldRunFastTier) {
        ctx.waitUntil(
          withScheduledTask(
            "Fetch-path warm probe failed",
            async () => {
              await warmPublicFetchPath(env, fetch);
            },
            { requiresDb: false },
          ),
        );

        // Scheduled-automation rule sweep. ARC-717: do NOT register a separate
        // cron trigger; this hooks into the existing every-5-minute sweep.
        ctx.waitUntil(
          withScheduledTask(
            "Automation scheduler tick failed",
            async () => {
              const { automationSchedulerTick } = await import("./automation/scheduler.js");
              await automationSchedulerTick(env);
            },
            { requiresDb: true },
          ),
        );

        ctx.waitUntil(
          withScheduledTask(
            "GitHub check automation tick failed",
            async () => {
              const { githubCheckAutomationTick } = await import("./automation/github-check-dispatch.js");
              await githubCheckAutomationTick(env);
            },
            { requiresDb: true },
          ),
        );

        ctx.waitUntil(
          withScheduledTask(
            "Automation event job stale sweep failed",
            async (db) => {
              const { failStaleAutomationEventJobs } = await import("./automation/db.js");
              const swept = await failStaleAutomationEventJobs(db, Date.now());
              for (const job of swept) {
                logger.warn(
                  {
                    automationEventJobId: job.id,
                    automationRuleId: job.ruleId,
                    businessId: job.businessId,
                    terminalReason: job.terminalReason,
                  },
                  "Terminalized stale automation event job",
                );
              }
            },
            { requiresDb: true },
          ),
        );

        // Linear webhook bootstrap recovery sweep (ARC-1051). Drains durable
        // bootstrap jobs left stuck by a crash/timeout/transient failure. Reuses
        // the existing 5-minute cron; no new trigger.
        ctx.waitUntil(
          withScheduledTask(
            "Linear webhook bootstrap sweep failed",
            async () => {
              const { linearBootstrapSweepTick } = await import("./webhooks/linear-bootstrap.js");
              await linearBootstrapSweepTick(env);
            },
            { requiresDb: true },
          ),
        );

        ctx.waitUntil(
          withScheduledTask(
            "OpenAI gateway reconciliation failed",
            async () => {
              if (!env.OPENAI_ADMIN_API_KEY) return;
              const { runOpenAIGatewayReconciliation } = await import("./openai-gateway/reconciliation.js");
              await runOpenAIGatewayReconciliation(env, { logger });
            },
            { requiresDb: true },
          ),
        );

        ctx.waitUntil(
          withScheduledTask(
            "GitHub integration health sweep failed",
            async () => {
              const { runDueGithubHealthChecks } = await import("./integrations/github-health.js");
              await runDueGithubHealthChecks(env, { logger });
            },
            { requiresDb: true },
          ),
        );

        ctx.waitUntil(
          withScheduledTask(
            "Review-loop epoch sweep failed",
            async () => {
              const { runReviewLoopSweep } = await import("./services/review-loop-sweep.js");
              // PR 47: thread the scheduled tick's ExecutionContext so live FSM side-effect execution
              // detaches from the sweep's sequential per-session loop.
              await runReviewLoopSweep(tracedEnv(env), { logger, waitUntil: (promise) => ctx.waitUntil(promise) });
            },
            { requiresDb: true },
          ),
        );

        // Live session-stall watch. Emits the age of the oldest session still in
        // each automated FSM state so a wedged session (e.g. the xyla OOM stuck in
        // FINALIZING 30+ min) pages via the arcanist.session.state_dwell_oldest_ms
        // monitor — the transition-based fsm.stage_dwell_ms cannot see a live stall.
        // Reuses this sweep; no new cron trigger.
        ctx.waitUntil(
          withScheduledTask(
            "Session stall sweep failed",
            async () => {
              const { runSessionStallSweep } = await import("./services/session-stall-sweep.js");
              await runSessionStallSweep(env, { logger });
            },
            { requiresDb: true },
          ),
        );

        ctx.waitUntil(
          withScheduledTask(
            "Session index reconciler sweep failed",
            async () => {
              const { runSessionIndexReconcilerSweep } = await import("./services/session-index-reconciler.js");
              const result = await runSessionIndexReconcilerSweep(env, { logger });
              if (result.fetched > 0 || result.failed > 0) {
                logger.info({ ...result }, "Session index reconciler sweep");
              }
            },
            { requiresDb: true },
          ),
        );

        ctx.waitUntil(
          withScheduledTask(
            "Linear integration health sweep failed",
            async () => {
              const { runDueLinearHealthChecks } = await import("./integrations/linear-health.js");
              await runDueLinearHealthChecks(env, { logger });
            },
            { requiresDb: true },
          ),
        );

        ctx.waitUntil(
          withScheduledTask(
            "Jira integration health sweep failed",
            async () => {
              const { runDueJiraHealthChecks } = await import("./integrations/jira-health.js");
              await runDueJiraHealthChecks(env, { logger });
            },
            { requiresDb: true },
          ),
        );

        ctx.waitUntil(
          withScheduledTask(
            "Jira personal-data reporting sweep failed",
            async () => {
              const { runDueJiraPersonalDataReports } = await import("./integrations/jira-personal-data-reporting.js");
              await runDueJiraPersonalDataReports(env, { logger });
            },
            { requiresDb: true },
          ),
        );

        ctx.waitUntil(
          withScheduledTask(
            "Jira webhook refresh sweep failed",
            async () => {
              const { refreshDueJiraWebhooks } = await import("./webhooks/jira-registration.js");
              await refreshDueJiraWebhooks(env, { logger });
            },
            { requiresDb: true },
          ),
        );

        // E2B runtime cleanup — kill expired/paused/malformed E2B sandboxes
        ctx.waitUntil(
          withScheduledTask(
            "E2B runtime cleanup failed",
            async () => {
              const { cleanupExpiredE2BRuntimes } = await import("./session/cleanup.js");
              const result = await cleanupExpiredE2BRuntimes(env, Date.now());
              if (result.paused > 0 || result.killed > 0 || result.terminalDisabled > 0 || result.errors > 0) {
                logger.info({ ...result }, "E2B runtime cleanup sweep");
              }
            },
            { requiresDb: true },
          ),
        );

        ctx.waitUntil(
          withScheduledTask(
            "Session phase cleanup failed",
            async () => {
              const { cleanupStaleSessionPhases } = await import("./session/cleanup.js");
              const result = await cleanupStaleSessionPhases(env, Date.now());
              if (result.archived > 0 || result.reviewListeningExited > 0 || result.skipped > 0 || result.errors > 0) {
                logger.info({ ...result }, "Session phase cleanup sweep");
              }
            },
            { requiresDb: true },
          ),
        );

        ctx.waitUntil(
          withScheduledTask(
            "E2B orphan sandbox reaper failed",
            async () => {
              const { runE2BOrphanSandboxReaper } = await import("./sandbox/e2b-orphan-reaper.js");
              const result = await runE2BOrphanSandboxReaper(env, { logger });
              if (
                result.candidates > 0 ||
                result.reaped > 0 ||
                result.missing > 0 ||
                result.protected > 0 ||
                result.deferred > 0 ||
                result.errors > 0
              ) {
                logger.info({ ...result }, "E2B orphan sandbox reaper sweep");
              }
            },
            { requiresDb: true },
          ),
        );

        ctx.waitUntil(
          withScheduledTask(
            "Sandbox layer rebuild campaign sweep failed",
            async () => {
              const { processSandboxLayerRebuildCampaignsTick } =
                await import("./sandbox/layer-rebuild-campaign-service.js");
              const result = await processSandboxLayerRebuildCampaignsTick(env);
              if (result.campaignsScanned > 0 || result.candidatesPlanned > 0 || result.itemsQueued > 0) {
                logger.info({ ...result }, "Sandbox layer rebuild campaign sweep");
              }
            },
            { requiresDb: true },
          ),
        );

        // Re-enqueue stale memory analysis jobs + terminalize exhausted ones
        ctx.waitUntil(
          withScheduledTask(
            "Memory job re-enqueue failed",
            async (db) => {
              const { getReenqueueableMemoryJobs, terminalizeExhaustedJobs } = await import("./memory/db.js");
              const { MEMORY_JOB_STALE_THRESHOLD_MS, MEMORY_JOB_MAX_ATTEMPTS } = await import("./constants/memory.js");

              // Terminalize jobs stuck at max attempts — only needs DB, not queue binding.
              const terminalized = await terminalizeExhaustedJobs(
                db,
                MEMORY_JOB_STALE_THRESHOLD_MS,
                MEMORY_JOB_MAX_ATTEMPTS,
              );
              if (terminalized > 0) {
                logger.warn(
                  { event: "memory.jobs_terminalized", count: terminalized },
                  "Memory analysis jobs terminalized after max attempts",
                );
                // Console logs are not shipped to Datadog (logpush is off);
                // direct-post so the [Memory] terminalized monitor can fire.
                const { postStructuredEventToDd } = await import("./observability/events-exporter.js");
                await postStructuredEventToDd(env, { event: "memory.jobs_terminalized", count: terminalized });
              }

              // Re-enqueue claimable jobs — requires queue binding
              if (env.MEMORY_ANALYSIS_QUEUE) {
                const jobs = await getReenqueueableMemoryJobs(
                  db,
                  MEMORY_JOB_STALE_THRESHOLD_MS,
                  MEMORY_JOB_MAX_ATTEMPTS,
                );
                for (const chunk of queueSendBatchChunks(jobs.map((job) => ({ jobId: job.id })))) {
                  await env.MEMORY_ANALYSIS_QUEUE.sendBatch(chunk);
                  for (const message of chunk) {
                    logger.info({ jobId: message.body.jobId }, "Re-enqueued stale memory analysis job");
                  }
                }
              }
            },
            { requiresDb: true },
          ),
        );

        ctx.waitUntil(
          withScheduledTask(
            "Company memory ingestion recovery failed",
            async (db) => {
              const { claimReenqueueableIngestionEvents, recoverStaleIngestionEvents } =
                await import("./company-memory/db.js");
              const { COMPANY_MEMORY_INGESTION_STALE_THRESHOLD_MS } = await import("./constants/company-memory.js");
              const recovered = await recoverStaleIngestionEvents(db, COMPANY_MEMORY_INGESTION_STALE_THRESHOLD_MS);
              if (recovered > 0) {
                logger.warn(
                  { event: "company_memory.ingestion_events_recovered", count: recovered },
                  "Recovered stale company memory ingestion events",
                );
              }
              if (!env.MEMORY_REFINE_QUEUE) return;
              const recoveredEvents = await claimReenqueueableIngestionEvents(
                db,
                COMPANY_MEMORY_INGESTION_STALE_THRESHOLD_MS,
              );
              const messages = recoveredEvents.map((event) => ({
                businessId: event.businessId,
                ingestionEventId: event.id,
                trigger: "auto" as const,
              }));
              for (const chunk of queueSendBatchChunks(messages)) {
                await env.MEMORY_REFINE_QUEUE.sendBatch(chunk);
                for (const message of chunk) {
                  logger.info(
                    { ingestionEventId: message.body.ingestionEventId, businessId: message.body.businessId },
                    "Re-enqueued stale company memory ingestion event",
                  );
                }
              }
            },
            { requiresDb: true },
          ),
        );

        ctx.waitUntil(
          withScheduledTask(
            "Memory context work processing failed",
            async (db) => {
              const { processPendingMemoryWorkItems } = await import("./company-memory/context-work.js");
              const result = await processPendingMemoryWorkItems(env, db, {
                batchSize: 10,
                metrics: { waitUntil: (promise) => ctx.waitUntil(promise) },
              });
              if (result.claimed > 0 || result.failed > 0 || result.retried > 0) {
                logger.info({ ...result }, "Memory context work processing sweep");
              }
            },
            { requiresDb: true },
          ),
        );

        ctx.waitUntil(
          withScheduledTask(
            "Memory review bot daily digest failed",
            async () => {
              const { runMemoryReviewBotDailyDigest } = await import("./memory-review-bot/review-service.js");
              const result = await runMemoryReviewBotDailyDigest(env, { logger });
              if (result.status !== "skipped") {
                logger.info({ ...result }, "Memory review bot daily digest sweep");
              }
            },
            { requiresDb: true },
          ),
        );

        ctx.waitUntil(
          withScheduledTask(
            "Company memory reconciliation failed",
            async () => {
              const { runScheduledMemoryReconciliation } = await import("./company-memory/reconcile.js");
              await runScheduledMemoryReconciliation(env, { logger });
            },
            { requiresDb: true },
          ),
        );

        // Flip due pending Slack interaction requests to `expired` so stale
        // buttons answer truthfully on click. Retention pruning of terminal
        // rows happens on the hourly GC tick below.
        ctx.waitUntil(
          withScheduledTask(
            "Slack interaction request expiry sweep failed",
            async (db) => {
              const { expireDue } = await import("./slack/interaction-requests-db.js");
              const expired = await expireDue(db, Date.now());
              if (expired > 0) {
                logger.info({ expired }, "Expired due Slack interaction requests");
              }
            },
            { requiresDb: true },
          ),
        );
      }

      if (isGcTick) {
        // Freestyle account VM audit — ALERT-ONLY orphan detection (ARC-1477).
        // Diffs account-wide vms.list() ids against the env registry and flags
        // unresolved create reservations; never terminates (ARC-1399 gate).
        ctx.waitUntil(
          withScheduledTask(
            "Freestyle VM audit failed",
            async () => {
              const { runFreestyleVmAudit } = await import("./sandbox/freestyle-vm-audit.js");
              await runFreestyleVmAudit(env, { logger });
            },
            { requiresDb: true },
          ),
        );

        ctx.waitUntil(
          withScheduledTask(
            "Integration lifecycle retention sweep failed",
            async (db) => {
              const { deleteIntegrationLifecycleEventsBefore } = await import("./integrations/lifecycle/db.js");
              const now = Date.now();
              const deletedEntries = await Promise.all(
                INTEGRATION_LIFECYCLE_RETENTION_POLICIES.map(
                  async ({ status, retainForMs }) =>
                    [
                      status,
                      await deleteIntegrationLifecycleEventsBefore(
                        db,
                        now - retainForMs,
                        INTEGRATION_LIFECYCLE_RETENTION_LIMIT,
                        status,
                      ),
                    ] as const,
                ),
              );
              const deletedByStatus = Object.fromEntries(deletedEntries);
              const deleted = deletedEntries.reduce((sum, [, count]) => sum + count, 0);
              if (deleted > 0) {
                logger.info({ deleted, deletedByStatus }, "Pruned integration lifecycle events");
              }
            },
            { requiresDb: true },
          ),
        );

        ctx.waitUntil(
          withScheduledTask(
            "Auth session cleanup failed",
            async (db) => {
              const deleted = await deleteExpiredAuthSessions(db);
              logger.info({ deleted }, "Pruned expired auth sessions");
            },
            { requiresDb: true },
          ),
        );

        ctx.waitUntil(
          withScheduledTask(
            "Slack repo disambiguation cleanup failed",
            async (db) => {
              const deleted = await deleteExpiredSlackRepoDisambiguations(db);
              logger.info({ deleted }, "Pruned expired Slack repo disambiguations");
            },
            { requiresDb: true },
          ),
        );

        ctx.waitUntil(
          withScheduledTask(
            "Webhook idempotency cleanup failed",
            async (db) => {
              const deleted = await deleteExpiredWebhookIdempotencyClaims(db);
              logger.info({ deleted }, "Pruned expired webhook idempotency claims");
            },
            { requiresDb: true },
          ),
        );

        ctx.waitUntil(
          withScheduledTask(
            "Slack interaction request retention sweep failed",
            async (db) => {
              const { pruneOldInteractionRequests } = await import("./slack/interaction-requests-db.js");
              const { SLACK_INTERACTION_REQUEST_RETENTION_MS } = await import("./constants/slack.js");
              const deleted = await pruneOldInteractionRequests(
                db,
                Date.now() - SLACK_INTERACTION_REQUEST_RETENTION_MS,
              );
              if (deleted > 0) {
                logger.info({ deleted }, "Pruned old Slack interaction requests");
              }
            },
            { requiresDb: true },
          ),
        );
      }
    },
  } satisfies ExportedHandler<Env>,
);

async function handleRequest(
  request: Request,
  url: URL,
  env: Env,
  matchedRoute: RouteRecorder,
  ctx?: ExecutionContext,
): Promise<Response> {
  // CORS preflight
  if (request.method === "OPTIONS") {
    recordRoute(matchedRoute, "preflight");
    const headers = new Headers({
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
      "access-control-allow-headers":
        "authorization,content-type,last-event-id,x-hub-signature-256,x-slack-signature,x-slack-request-timestamp,x-slack-retry-num,linear-signature",
      "access-control-max-age": "86400",
    });
    const allowedOrigin = corsOrigin(request, env);
    if (allowedOrigin) {
      headers.set("access-control-allow-origin", allowedOrigin);
      headers.set("access-control-allow-credentials", "true");
      headers.set("vary", "Origin");
    }
    return new Response(null, {
      status: 204,
      headers,
    });
  }

  for (const route of controlPlaneRoutes) {
    if (route.method !== request.method) continue;

    const match = url.pathname.match(route.pattern);
    if (!match) continue;

    recordRoute(matchedRoute, route.pattern.routeTemplate);

    // Apply auth based on route tier
    let auth: AuthInfo | null = null;
    switch (route.auth) {
      case "public":
      case "sandbox_do_verified":
      case "webhook":
        // Public: no auth. Sandbox-DO-verified routes forward auth to the
        // SessionDO. Webhook: handlers verify signatures internally.
        break;
      case "callback": {
        const callbackAuth = await verifySandboxPromptCallbackAuth(
          request,
          env,
          match.groups?.sessionId ?? "",
          match.groups?.promptId ?? "",
        );
        if (!callbackAuth.ok) return callbackAuth.response;
        break;
      }
      case "automation": {
        const authResult = await authenticateRequest(request, env);
        if (!authResult.ok) return authResult.response;
        auth = authResult.auth;
        tagAuthenticatedRequestSpan(auth);

        const accessError = validateAuthRouteAccess(auth, request.method, url.pathname, route);
        if (accessError) return accessError;
        break;
      }
      case "authenticated": {
        const authResult = await authenticateRequest(request, env);
        if (!authResult.ok) return authResult.response;
        auth = authResult.auth;
        // Sentry user binding represents who actually drove the request: the
        // operator under impersonation, otherwise the authenticated user. Do
        // not mix the two — if the actor record is missing email/login, leave
        // those fields empty rather than falling back to the impersonated
        // customer's data.
        Sentry.setUser(
          auth.actorUserId
            ? {
                id: auth.actorUserId,
                email: auth.actorUser?.email ?? undefined,
                username: auth.actorUser?.login ?? undefined,
              }
            : {
                id: auth.userId,
                email: auth.user?.email ?? undefined,
                username: auth.user?.login ?? undefined,
              },
        );
        // Tag the root `worker.fetch` span with the same principal Sentry binds
        // to (operator under impersonation, else the authenticated user) so
        // per-user Datadog alerts on @span.name:worker.fetch can name who was
        // hit via @span.user.login. `setSpanAttributes` writes to the active
        // root span and drops nullish values. Keep id and login on the SAME
        // principal, never the actor's login beside the target's id.
        tagAuthenticatedRequestSpan(auth);
        if (auth.impersonationId) {
          Sentry.setTag("impersonation_id", auth.impersonationId);
          Sentry.setTag("impersonation_target_user_id", auth.userId);
        }

        if (auth.readOnly && routeMutatesUnderImpersonation(request.method, route)) {
          routerLog.warn(
            {
              action: auth.impersonationId ? "impersonation_write_blocked" : "read_only_auth_write_blocked",
              method: request.method,
              path: url.pathname,
              impersonationId: auth.impersonationId,
              actorUserId: auth.actorUserId,
              targetUserId: auth.userId,
            },
            "Blocked mutating request from read-only authenticated session",
          );
          return jsonErrorResponse(
            auth.impersonationId ? "Forbidden: impersonation is read-only" : "Forbidden: this credential is read-only",
            403,
          );
        }

        const accessError = validateAuthRouteAccess(
          auth,
          request.method,
          url.pathname,
          route,
          request.headers.get(HTTP_HEADER_NAMES.REQUEST_ID),
        );
        if (accessError) return accessError;
        break;
      }
    }

    return route.handler(request, env, match, auth, ctx);
  }

  recordRoute(matchedRoute, "unmatched");
  return jsonErrorResponse("Not found", 404);
}
