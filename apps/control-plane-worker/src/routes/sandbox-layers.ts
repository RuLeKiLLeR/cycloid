import { createLogger } from "../logger";
import { canRepairSandboxLayerActiveArtifacts } from "../sandbox/layer-active-artifact-repair-service";
import { checkSandboxLayerBuildRequestRateLimit } from "../sandbox/layer-build-rate-limit";
import {
  ensureCompletedDefaultBranchBuildPromoted,
  queueSandboxLayerBuildRequest,
  SandboxLayerBuildQueueError,
} from "../sandbox/layer-provider-build-service";
import {
  getSandboxLayerBuildRequest,
  getSandboxLayerBuildRequestLogs,
  listSandboxLayerBuildRequests,
  prepareSandboxLayerBuildRequest,
  SandboxLayerBuildRequestError,
} from "../sandbox/layer-source-service";
import {
  beginIdempotentRequest,
  commitIdempotentRequest,
  type IdempotencyToken,
  readIdempotencyKeyHeader,
  releaseIdempotentRequest,
} from "../services/idempotency";
import { jsonErrorResponse, jsonResponse, parseJsonBody } from "../utils";
import { getRequestSearchParams, parsePattern, requireRouteAuth, type Route } from "./shared";

type BuildRequestBody = {
  ref?: unknown;
  manifestPath?: unknown;
  targetRepo?: { owner?: unknown; name?: unknown } | null;
};

const log = createLogger({ bindings: { component: "sandbox-layer-routes" } });

function sandboxLayerErrorResponse(error: SandboxLayerBuildRequestError): Response {
  return jsonResponse(
    {
      ok: false,
      error: error.message,
      code: error.code,
      diagnostics: error.diagnostics ?? null,
    },
    error.status,
  );
}

function parseOptionalInteger(value: string | null): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export const sandboxLayerRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/api/businesses/:businessId/repos/:owner/:repo/sandbox-layer/build-requests"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const { businessId, owner, repo } = match.groups!;
      const body = ((await parseJsonBody(request)) ?? {}) as BuildRequestBody;
      let idempotencyToken: IdempotencyToken | null = null;
      try {
        const idempotencyKey = readIdempotencyKeyHeader(request);
        if (idempotencyKey) {
          const decision = await beginIdempotentRequest(env.DB, {
            key: idempotencyKey,
            ownerUserId: routeAuth.userId,
            route: "sandbox_layer_build_request",
            requestBody: {
              businessId,
              sourceRepo: { owner, repo },
              targetRepo: body.targetRepo ?? null,
              ref: body.ref,
              manifestPath: body.manifestPath,
            },
          });
          if (decision.kind === "replay") {
            const buildRequest = await getSandboxLayerBuildRequest(env, routeAuth, {
              businessId,
              buildId: decision.resolvedId,
            });
            return jsonResponse({ ok: true, buildRequest, idempotentReplay: true }, 200);
          }
          if (decision.kind === "reject") {
            return jsonErrorResponse(
              decision.reason === "payload_mismatch"
                ? "Idempotency-Key was already used with a different request payload"
                : "A request with this Idempotency-Key is already in progress; retry shortly",
              409,
              { code: "duplicate_request", retryable: decision.reason === "in_progress" },
            );
          }
          if (decision.kind === "proceed") idempotencyToken = decision.token;
        }
        if (
          !(await checkSandboxLayerBuildRequestRateLimit(env, {
            businessId,
            userId: routeAuth.userId,
            repoOwner: owner,
            repoName: repo,
          }))
        ) {
          if (idempotencyToken) await releaseIdempotentRequest(env.DB, idempotencyToken);
          return jsonErrorResponse("Sandbox layer build request rate limit exceeded", 429, {
            code: "rate_limited",
          });
        }
        const result = await prepareSandboxLayerBuildRequest(env, routeAuth, {
          businessId,
          repoOwner: owner,
          repoName: repo,
          ref: body.ref,
          manifestPath: body.manifestPath,
          targetRepoOwner: body.targetRepo?.owner,
          targetRepoName: body.targetRepo?.name,
        });
        const buildRequest = await queueSandboxLayerBuildRequest(env, result.buildRequest);
        if (idempotencyToken) await commitIdempotentRequest(env.DB, idempotencyToken, buildRequest.id);
        return jsonResponse({ ok: true, buildRequest }, result.created ? 201 : 200);
      } catch (err) {
        if (idempotencyToken) await releaseIdempotentRequest(env.DB, idempotencyToken);
        if (err instanceof SandboxLayerBuildRequestError) return sandboxLayerErrorResponse(err);
        if (err instanceof SandboxLayerBuildQueueError) {
          return jsonResponse({ ok: false, error: err.message, code: err.code }, 503);
        }
        log.error({ businessId, repoOwner: owner, repoName: repo, error: err }, "Sandbox layer build request failed");
        return jsonErrorResponse("Unable to prepare sandbox layer build request", 500);
      }
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/api/businesses/:businessId/sandbox-layer/build-requests"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const { businessId } = match.groups!;
      const params = getRequestSearchParams(request);
      try {
        const builds = await listSandboxLayerBuildRequests(env, routeAuth, {
          businessId,
          sourceRepo: params.get("sourceRepo"),
          targetRepo: params.get("targetRepo"),
          status: params.get("status"),
          limit: parseOptionalInteger(params.get("limit")),
        });
        return jsonResponse({ ok: true, builds });
      } catch (err) {
        if (err instanceof SandboxLayerBuildRequestError) return sandboxLayerErrorResponse(err);
        return jsonErrorResponse("Unable to list sandbox layer build requests", 500);
      }
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/api/businesses/:businessId/sandbox-layer/build-requests/:buildId"),
    auth: "authenticated",
    handler: async (_request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const { businessId, buildId } = match.groups!;
      try {
        let buildRequest = await getSandboxLayerBuildRequest(env, routeAuth, { businessId, buildId });
        if (
          canRepairSandboxLayerActiveArtifacts(routeAuth) &&
          !buildRequest.activeTemplateRef &&
          buildRequest.status === "completed" &&
          buildRequest.promotionEligibility === "default_branch_head" &&
          buildRequest.willPromote === 1
        ) {
          try {
            const activeTemplateRef = await ensureCompletedDefaultBranchBuildPromoted(env, buildId);
            if (activeTemplateRef) buildRequest = { ...buildRequest, activeTemplateRef };
          } catch (err) {
            log.warn({ buildId, error: String(err) }, "Sandbox layer activation repair skipped during build read");
          }
        }
        return jsonResponse({ ok: true, buildRequest });
      } catch (err) {
        if (err instanceof SandboxLayerBuildRequestError) return sandboxLayerErrorResponse(err);
        return jsonErrorResponse("Unable to load sandbox layer build request", 500);
      }
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/api/businesses/:businessId/sandbox-layer/build-requests/:buildId/logs"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const { businessId, buildId } = match.groups!;
      const params = getRequestSearchParams(request);
      try {
        const logs = await getSandboxLayerBuildRequestLogs(env, routeAuth, {
          businessId,
          buildId,
          afterSequence: parseOptionalInteger(params.get("afterSequence")),
          limit: parseOptionalInteger(params.get("limit")),
        });
        return jsonResponse({ ok: true, logs });
      } catch (err) {
        if (err instanceof SandboxLayerBuildRequestError) return sandboxLayerErrorResponse(err);
        return jsonErrorResponse("Unable to load sandbox layer build request logs", 500);
      }
    },
  },
];
