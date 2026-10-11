import { handleGithubWebhook } from "../webhooks/github";
import {
  handleJiraWebhook,
  handleLinearWebhook,
  handlePagerDutyWebhook,
  handleSandboxCallback,
  handleSlackEventsWebhook,
  handleSlackInteractionsWebhook,
} from "../webhooks/handlers";
import type { Route } from "./shared";
import { parsePattern } from "./shared";

export const webhookRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/api/webhooks/github"),
    auth: "webhook",
    handler: async (request, env, _match, _auth, ctx) => handleGithubWebhook(request, env, ctx),
  },
  {
    method: "POST",
    pattern: parsePattern("/api/webhooks/slack/events"),
    auth: "webhook",
    handler: async (request, env, _match, _auth, ctx) => handleSlackEventsWebhook(request, env, ctx),
  },
  {
    method: "POST",
    pattern: parsePattern("/api/webhooks/slack/interactions"),
    auth: "webhook",
    handler: async (request, env, _match, _auth, ctx) => handleSlackInteractionsWebhook(request, env, ctx),
  },
  {
    method: "POST",
    pattern: parsePattern("/api/webhooks/linear"),
    auth: "webhook",
    handler: async (request, env, _match, _auth, ctx) => handleLinearWebhook(request, env, ctx),
  },
  {
    method: "POST",
    pattern: parsePattern("/api/webhooks/jira/:token"),
    auth: "webhook",
    handler: async (request, env, match, _auth, ctx) => handleJiraWebhook(request, env, match.groups!.token, ctx),
  },
  {
    method: "POST",
    pattern: parsePattern("/api/webhooks/pagerduty/:token"),
    auth: "webhook",
    handler: async (request, env, match, _auth, ctx) => handlePagerDutyWebhook(request, env, match.groups!.token, ctx),
  },
  {
    method: "POST",
    pattern: parsePattern("/internal/sandbox/sessions/:sessionId/prompts/:promptId/callback"),
    auth: "callback",
    handler: async (request, env, match) =>
      handleSandboxCallback(request, env, match.groups!.sessionId, match.groups!.promptId),
  },
];
