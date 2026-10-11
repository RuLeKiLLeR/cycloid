import {
  clearSandboxLayerBusinessDefaultSource,
  clearSandboxLayerRepoSourceAssignment,
  listSandboxLayerAssignments,
  resolveAndRepairSandboxLayer,
  SandboxLayerAssignmentError,
  type SandboxLayerAssignmentSourceInput,
  setSandboxLayerBusinessDefaultSource,
  setSandboxLayerRepoSourceAssignment,
} from "../sandbox/layer-assignment-service";
import { jsonErrorResponse, jsonResponse, parseJsonBody } from "../utils";
import { parsePattern, requireRouteAuth, type Route } from "./shared";

function assignmentErrorResponse(error: SandboxLayerAssignmentError): Response {
  return jsonResponse({ ok: false, error: error.message, code: error.code }, error.status);
}

async function parseAssignmentSourceBody(request: Request): Promise<SandboxLayerAssignmentSourceInput | Response> {
  const body = (await parseJsonBody(request)) ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    return jsonErrorResponse("Invalid JSON body", 400, { code: "invalid_request" });
  }
  return body as SandboxLayerAssignmentSourceInput;
}

export const sandboxLayerAssignmentRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/api/businesses/:businessId/sandbox-layer/assignments"),
    auth: "authenticated",
    handler: async (_request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const { businessId } = match.groups!;
      try {
        const result = await listSandboxLayerAssignments(env, routeAuth, { businessId });
        return jsonResponse({ ok: true, ...result });
      } catch (err) {
        if (err instanceof SandboxLayerAssignmentError) return assignmentErrorResponse(err);
        return jsonErrorResponse("Unable to load sandbox layer assignments", 500);
      }
    },
  },
  {
    method: "PUT",
    pattern: parsePattern("/api/businesses/:businessId/sandbox-layer/default-source"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const body = await parseAssignmentSourceBody(request);
      if (body instanceof Response) return body;
      const { businessId } = match.groups!;
      try {
        const result = await setSandboxLayerBusinessDefaultSource(env, routeAuth, { businessId, source: body });
        return jsonResponse({ ok: true, ...result });
      } catch (err) {
        if (err instanceof SandboxLayerAssignmentError) return assignmentErrorResponse(err);
        return jsonErrorResponse("Unable to update sandbox layer default source", 500);
      }
    },
  },
  {
    method: "DELETE",
    pattern: parsePattern("/api/businesses/:businessId/sandbox-layer/default-source"),
    auth: "authenticated",
    handler: async (_request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const { businessId } = match.groups!;
      try {
        const result = await clearSandboxLayerBusinessDefaultSource(env, routeAuth, { businessId });
        return jsonResponse({ ok: true, ...result });
      } catch (err) {
        if (err instanceof SandboxLayerAssignmentError) return assignmentErrorResponse(err);
        return jsonErrorResponse("Unable to clear sandbox layer default source", 500);
      }
    },
  },
  {
    method: "PUT",
    pattern: parsePattern("/api/businesses/:businessId/repos/:owner/:repo/sandbox-layer/assignment"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const body = await parseAssignmentSourceBody(request);
      if (body instanceof Response) return body;
      const { businessId, owner, repo } = match.groups!;
      try {
        const result = await setSandboxLayerRepoSourceAssignment(env, routeAuth, {
          businessId,
          targetRepoOwner: owner,
          targetRepoName: repo,
          source: body,
        });
        return jsonResponse({ ok: true, ...result });
      } catch (err) {
        if (err instanceof SandboxLayerAssignmentError) return assignmentErrorResponse(err);
        return jsonErrorResponse("Unable to update sandbox layer repo assignment", 500);
      }
    },
  },
  {
    method: "DELETE",
    pattern: parsePattern("/api/businesses/:businessId/repos/:owner/:repo/sandbox-layer/assignment"),
    auth: "authenticated",
    handler: async (_request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const { businessId, owner, repo } = match.groups!;
      try {
        const result = await clearSandboxLayerRepoSourceAssignment(env, routeAuth, {
          businessId,
          targetRepoOwner: owner,
          targetRepoName: repo,
        });
        return jsonResponse({ ok: true, ...result });
      } catch (err) {
        if (err instanceof SandboxLayerAssignmentError) return assignmentErrorResponse(err);
        return jsonErrorResponse("Unable to clear sandbox layer repo assignment", 500);
      }
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/api/businesses/:businessId/repos/:owner/:repo/sandbox-layer/resolution"),
    auth: "authenticated",
    handler: async (_request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const { businessId, owner, repo } = match.groups!;
      try {
        const result = await resolveAndRepairSandboxLayer(env, routeAuth, {
          businessId,
          repoOwner: owner,
          repoName: repo,
        });
        return jsonResponse({ ok: true, ...result });
      } catch (err) {
        if (err instanceof SandboxLayerAssignmentError) return assignmentErrorResponse(err);
        return jsonErrorResponse("Unable to resolve sandbox layer", 500);
      }
    },
  },
];
