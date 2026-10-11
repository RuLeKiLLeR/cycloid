import { resetAuthMeUserCache } from "../auth/auth-me";
import { clearJiraTokens, clearLinearTokens } from "../auth/db";
import { handleAuthGithubSso } from "../auth/github-sso";
import {
  handleAuthCallback,
  handleAuthGithub,
  handleAuthJira,
  handleAuthJiraBusiness,
  handleAuthJiraCallback,
  handleAuthLinear,
  handleAuthLinearBusiness,
  handleAuthLinearCallback,
  handleAuthLogout,
  handleAuthMe,
  handleAuthNotion,
  handleAuthNotionCallback,
  handleAuthSlack,
  handleAuthSlackCallback,
  handleAuthSlackInstall,
  handleAuthSlackInstallCallback,
  handleAuthSlackLink,
  handleAuthSlackLinkConfirm,
  handleAuthStatus,
  handleDisconnectNotion,
  handleDisconnectSlack,
  handleGetUserIntegrations,
  handleGithubReauthorize,
  handleGithubSetupCallback,
  handleJiraFinalize,
  handleJiraPendingSites,
  handleSeedSlackWorkspace,
} from "../auth/routes";
import { withRouteSpan } from "../observability/route-span";
import { jsonErrorResponse, jsonResponse } from "../utils";
import type { Route } from "./shared";
import { parsePattern } from "./shared";

export const authRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/auth/github"),
    auth: "public",
    handler: async (request, env) => handleAuthGithub(request, env),
  },
  {
    method: "POST",
    pattern: parsePattern("/auth/github"),
    auth: "public",
    handler: async (request, env) => handleAuthGithub(request, env),
  },
  {
    method: "GET",
    pattern: parsePattern("/auth/github/sso"),
    auth: "public",
    handler: async (request, env) => handleAuthGithubSso(request, env),
  },
  {
    method: "POST",
    pattern: parsePattern("/auth/github/sso"),
    auth: "public",
    handler: async (request, env) => handleAuthGithubSso(request, env),
  },
  {
    method: "GET",
    pattern: parsePattern("/auth/callback"),
    auth: "public",
    handler: async (request, env, _match, _auth, ctx) => {
      const url = new URL(request.url);
      return handleAuthCallback(request, url, env, ctx);
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/api/github/setup-callback"),
    auth: "public",
    handler: async (request, env) => {
      const url = new URL(request.url);
      return handleGithubSetupCallback(url, env);
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/auth/me"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) =>
      withRouteSpan("auth.me", { auth: auth! }, async (span) => {
        const response = await handleAuthMe(request, env, auth!);
        if (auth?.user) {
          span.setAttribute("db.rows_returned", 1);
        }
        return response;
      }),
  },
  {
    method: "GET",
    pattern: parsePattern("/api/auth/whoami"),
    auth: "authenticated",
    handler: async (_request, _env, _match, auth) =>
      withRouteSpan("auth.whoami", { auth: auth! }, async () =>
        jsonResponse({
          userId: auth!.userId,
          email: auth!.user?.email ?? null,
          tokenId: auth!.cliTokenId ?? null,
          tokenScope: auth!.cliTokenScope ?? null,
          authMode: auth!.authMode,
          businessId: auth!.user?.businessId ?? null,
          businessRole: auth!.user?.businessRole ?? null,
        }),
      ),
  },
  {
    method: "GET",
    pattern: parsePattern("/auth/status"),
    auth: "public",
    handler: async (request, env) => handleAuthStatus(request, env),
  },
  {
    method: "GET",
    pattern: parsePattern("/api/user/integrations"),
    auth: "authenticated",
    handler: async (_req, env, _match, auth) => handleGetUserIntegrations(env, auth!),
  },
  {
    method: "POST",
    pattern: parsePattern("/auth/logout"),
    auth: "authenticated",
    // Operator must always be able to exit, including while impersonating.
    // The handler clears both cookies and revokes the impersonation row.
    impersonationReadOnlyAllowed: true,
    handler: async (request, env) => handleAuthLogout(request, env),
  },
  {
    method: "GET",
    pattern: parsePattern("/auth/github/reauthorize"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      if (auth!.canAccessAllSessions) {
        return jsonErrorResponse("Browser-only feature", 403);
      }
      const { renderTurnstileAuthForm } = await import("../auth/turnstile");
      const challenge = renderTurnstileAuthForm(request, env);
      return (
        challenge ??
        new Response(
          '<!doctype html><form method="post" action="/auth/github/reauthorize"><button type="submit">Continue</button></form>',
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
        )
      );
    },
  },
  {
    method: "POST",
    pattern: parsePattern("/auth/github/reauthorize"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      if (auth!.canAccessAllSessions) {
        return jsonErrorResponse("Browser-only feature", 403);
      }
      const { verifyTurnstileAuthRequest } = await import("../auth/turnstile");
      const challengeError = await verifyTurnstileAuthRequest(request, env);
      if (challengeError) return challengeError;
      return handleGithubReauthorize(request, env, auth!);
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/auth/linear"),
    auth: "public",
    handler: async (request, env) => handleAuthLinear(request, env),
  },
  {
    method: "GET",
    pattern: parsePattern("/auth/linear/business"),
    auth: "public",
    handler: async (request, env) => handleAuthLinearBusiness(request, env),
  },
  {
    method: "GET",
    pattern: parsePattern("/auth/linear/callback"),
    auth: "public",
    handler: async (request, env) => {
      const url = new URL(request.url);
      return handleAuthLinearCallback(request, url, env);
    },
  },
  {
    method: "POST",
    pattern: parsePattern("/auth/linear/disconnect"),
    auth: "authenticated",
    handler: async (_req, env, _match, auth) => {
      await clearLinearTokens(env.DB, auth!.userId, env);
      resetAuthMeUserCache();
      return jsonResponse({ ok: true });
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/auth/jira"),
    auth: "public",
    handler: async (request, env) => handleAuthJira(request, env),
  },
  {
    method: "GET",
    pattern: parsePattern("/auth/jira/business"),
    auth: "public",
    handler: async (request, env) => handleAuthJiraBusiness(request, env),
  },
  {
    method: "GET",
    pattern: parsePattern("/auth/jira/callback"),
    auth: "public",
    handler: async (request, env) => {
      const url = new URL(request.url);
      return handleAuthJiraCallback(request, url, env);
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/auth/jira/pending"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => handleJiraPendingSites(request, env, auth!),
  },
  {
    method: "POST",
    pattern: parsePattern("/auth/jira/finalize"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => handleJiraFinalize(request, env, auth!),
  },
  {
    method: "POST",
    pattern: parsePattern("/auth/jira/disconnect"),
    auth: "authenticated",
    handler: async (_req, env, _match, auth) => {
      await clearJiraTokens(env.DB, auth!.userId);
      resetAuthMeUserCache();
      return jsonResponse({ ok: true });
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/auth/notion"),
    auth: "public",
    handler: async (request, env) => handleAuthNotion(request, env),
  },
  {
    method: "GET",
    pattern: parsePattern("/auth/notion/callback"),
    auth: "public",
    handler: async (request, env) => {
      const url = new URL(request.url);
      return handleAuthNotionCallback(request, url, env);
    },
  },
  {
    method: "POST",
    pattern: parsePattern("/auth/notion/disconnect"),
    auth: "authenticated",
    handler: async (_req, env, _match, auth) => handleDisconnectNotion(env, auth!),
  },
  // Slack OAuth
  {
    method: "GET",
    pattern: parsePattern("/auth/slack"),
    auth: "public",
    handler: async (request, env) => handleAuthSlack(request, env),
  },
  {
    method: "GET",
    pattern: parsePattern("/auth/slack/install"),
    auth: "public",
    handler: async (request, env) => handleAuthSlackInstall(request, env),
  },
  {
    method: "GET",
    pattern: parsePattern("/auth/slack/install/callback"),
    auth: "public",
    handler: async (request, env) => {
      const url = new URL(request.url);
      return handleAuthSlackInstallCallback(request, url, env);
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/auth/slack/callback"),
    auth: "public",
    handler: async (request, env) => {
      const url = new URL(request.url);
      return handleAuthSlackCallback(request, url, env);
    },
  },
  // Slack magic-link identity binding. Both are public so the handlers can
  // resolve the browser session themselves (unauthenticated GET renders a
  // sign-in prompt; POST enforces session + CSRF + origin internally).
  {
    method: "GET",
    pattern: parsePattern("/auth/slack/link"),
    auth: "public",
    handler: async (request, env) => handleAuthSlackLink(request, env),
  },
  {
    method: "POST",
    pattern: parsePattern("/auth/slack/link/confirm"),
    auth: "public",
    handler: async (request, env) => handleAuthSlackLinkConfirm(request, env),
  },
  {
    method: "POST",
    pattern: parsePattern("/auth/slack/disconnect"),
    auth: "authenticated",
    handler: async (_req, env, _match, auth) => handleDisconnectSlack(env, auth!),
  },
  {
    method: "POST",
    pattern: parsePattern("/api/internal/slack/workspaces/seed"),
    auth: "automation",
    handler: async (request, env, _match, auth) => handleSeedSlackWorkspace(request, env, auth!),
  },
];
