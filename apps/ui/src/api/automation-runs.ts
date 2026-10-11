import { z } from "zod";

import { requestJson } from "./client";
const runSchema = z.object({
  source: z.union([z.literal("schedule"), z.literal("slack_alert"), z.literal("github_check_failure")]),
  id: z.string(),
  ruleId: z.string(),
  ruleName: z.string().nullable(),
  triggerProvider: z.string().nullable(),
  orchestrationStatus: z.string(),
  failureCode: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  sessionId: z.string().nullable(),
  sessionStatus: z.string().nullable(),
  executionOutcome: z
    .union([z.literal("completed"), z.literal("failed"), z.literal("blocked"), z.literal("superseded")])
    .nullable(),
  executionCompletedAt: z.number().nullable(),
  executionReason: z.string().nullable(),
});
export type AutomationRunHistoryItem = z.infer<typeof runSchema>;
const responseSchema = z.object({ ok: z.literal(true), items: z.array(runSchema), nextCursor: z.string().nullable() });
export async function fetchAutomationRuns(cursor?: string | null) {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return requestJson(`/api/automations/runs${query}`, undefined, "Failed to load automation runs", {
    schema: responseSchema,
  });
}
