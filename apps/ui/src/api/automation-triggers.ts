import { z } from "zod";

import { requestJson } from "./client";

export type ConnectedTrigger = {
  id: "github" | "slack" | "linear" | "jira" | "pagerduty" | "automatic_review" | "automatic_qa";
  label: string;
  status: "active" | "setup_needed" | "degraded" | "policy_enabled" | "policy_disabled";
  scope: "workspace" | "viewer" | "repository";
  gesture: string;
  behavior: "new_session" | "continues_pr_lifecycle";
  settingsPath: string;
  observedAt: number | null;
};

const triggerSchema: z.ZodType<ConnectedTrigger> = z.object({
  id: z.union([
    z.literal("github"),
    z.literal("slack"),
    z.literal("linear"),
    z.literal("jira"),
    z.literal("pagerduty"),
    z.literal("automatic_review"),
    z.literal("automatic_qa"),
  ]),
  label: z.string(),
  status: z.union([
    z.literal("active"),
    z.literal("setup_needed"),
    z.literal("degraded"),
    z.literal("policy_enabled"),
    z.literal("policy_disabled"),
  ]),
  scope: z.union([z.literal("workspace"), z.literal("viewer"), z.literal("repository")]),
  gesture: z.string(),
  behavior: z.union([z.literal("new_session"), z.literal("continues_pr_lifecycle")]),
  settingsPath: z.string(),
  observedAt: z.number().nullable(),
});
const responseSchema = z.object({ ok: z.literal(true), triggers: z.array(triggerSchema) });

export async function fetchConnectedTriggers(): Promise<ConnectedTrigger[]> {
  const response = await requestJson(
    "/api/automations/connected-triggers",
    undefined,
    "Failed to load connected triggers",
    { schema: responseSchema },
  );
  return response.triggers;
}
