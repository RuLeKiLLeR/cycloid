import { z } from "zod";

import { JSON_HEADERS, requestJsonValidated, requestVoid } from "./client";
const ruleSchema = z.object({
  id: z.string(),
  triggerKind: z.literal("github_check_failure"),
  repoOwner: z.string(),
  repoName: z.string(),
  checkName: z.string().nullable(),
  modelId: z.string().nullable(),
  promptTemplate: z.string(),
  name: z.string().nullable(),
  enabled: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type GithubCheckAutomationRule = z.infer<typeof ruleSchema>;
export async function fetchGithubCheckAutomations() {
  return (
    await requestJsonValidated("/api/automations/github-checks", undefined, "Failed to load GitHub check automations", {
      schema: z.object({ ok: z.literal(true), items: z.array(ruleSchema) }),
    })
  ).items;
}
export async function createGithubCheckAutomation(input: {
  repoOwner: string;
  repoName: string;
  checkName: string | null;
  modelId: string | null;
  promptTemplate: string;
  name: string | null;
}) {
  return (
    await requestJsonValidated(
      "/api/automations/github-checks",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(input) },
      "Failed to create GitHub check automation",
      { schema: z.object({ ok: z.literal(true), data: ruleSchema }) },
    )
  ).data;
}
export async function patchGithubCheckAutomation(
  id: string,
  input: Partial<Pick<GithubCheckAutomationRule, "checkName" | "modelId" | "promptTemplate" | "name" | "enabled">>,
) {
  return (
    await requestJsonValidated(
      `/api/automations/github-checks/${encodeURIComponent(id)}`,
      { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(input) },
      "Failed to update GitHub check automation",
      { schema: z.object({ ok: z.literal(true), data: ruleSchema }) },
    )
  ).data;
}
export async function deleteGithubCheckAutomation(id: string) {
  await requestVoid(
    `/api/automations/github-checks/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    "Failed to delete GitHub check automation",
  );
}
