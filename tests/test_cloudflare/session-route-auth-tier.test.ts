import { describe, expect, it } from "vitest";

import { controlPlaneRoutes } from "../../apps/control-plane-worker/src/routes/table";

function routeKey(route: { method: string; pattern: { routeTemplate: string } }): string {
  return `${route.method} ${route.pattern.routeTemplate}`;
}

describe("session route auth tiers", () => {
  it("labels sandbox-DO-authenticated callback routes separately from truly public routes", () => {
    const sandboxVerifiedRoutes = controlPlaneRoutes
      .filter((route) => route.auth === "sandbox_do_verified")
      .map(routeKey)
      .sort();

    expect(sandboxVerifiedRoutes).toEqual(
      [
        "GET /api/sessions/:sessionId/cli-auth-token",
        "GET /api/sessions/:sessionId/clone-token",
        "GET /api/sessions/:sessionId/github-token",
        "GET /api/sessions/:sessionId/rollout",
        "GET /api/sessions/:sessionId/sandbox/telemetry/braintrust/version",
        "POST /api/sessions/:sessionId/artifacts",
        "POST /api/sessions/:sessionId/desktop/action-path",
        "POST /api/sessions/:sessionId/github-action",
        "POST /api/sessions/:sessionId/integration-lifecycle",
        "POST /api/sessions/:sessionId/platform-llm/post-execution",
        "POST /api/sessions/:sessionId/platform-llm/prompt-preparation",
        "POST /api/sessions/:sessionId/pr-close",
        "POST /api/sessions/:sessionId/pr-read",
        "POST /api/sessions/:sessionId/pr-review/publish",
        "POST /api/sessions/:sessionId/pr-title",
        "POST /api/sessions/:sessionId/review-loop/record-push",
        "POST /api/sessions/:sessionId/review-loop/reply",
        "POST /api/sessions/:sessionId/review-loop/summary-comment",
        "POST /api/sessions/:sessionId/sandbox/child-sessions",
        "POST /api/sessions/:sessionId/sandbox/company-memory/reasoning-chain",
        "POST /api/sessions/:sessionId/sandbox/memory/context",
        "POST /api/sessions/:sessionId/sandbox/telemetry/braintrust/api/apikey/login",
        "POST /api/sessions/:sessionId/sandbox/telemetry/braintrust/api/project/register",
        "POST /api/sessions/:sessionId/sandbox/telemetry/braintrust/logs3",
        "POST /api/sessions/:sessionId/sandbox/telemetry/dd-logs",
        "POST /api/sessions/:sessionId/sandbox/telemetry/sentry",
        "POST /api/sessions/:sessionId/slack/get-thread",
        "POST /api/sessions/:sessionId/slack/search-messages",
        "POST /api/sessions/:sessionId/slack/send-message",
        "POST /api/sessions/:sessionId/ticket-key",
        "PUT /api/sessions/:sessionId/rollout",
      ].sort(),
    );
  });

  it("keeps mixed browser/signed-token session routes public", () => {
    const authByRoute = new Map(controlPlaneRoutes.map((route) => [routeKey(route), route.auth]));

    expect(authByRoute.get("GET /api/sessions/:sessionId/ws")).toBe("public");
    expect(authByRoute.get("GET /api/sessions/:sessionId/artifacts/:artifactId/:filename")).toBe("public");
    expect(authByRoute.get("GET /api/users/me/feed/ws")).toBe("public");
  });
});
