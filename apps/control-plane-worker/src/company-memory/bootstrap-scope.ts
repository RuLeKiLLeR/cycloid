import type { CallbackContext, Env } from "../types";
import { getChannelIntake, type SlackChannelIntakeRow } from "./db";
import type { RetrieveScope } from "./retrieve";

type SlackCallbackContext = Extract<CallbackContext, { source: "slack" }>;

export async function resolveCompanyMemoryBootstrapScope(
  env: Env,
  input: {
    businessId: string;
    repoOwner?: string | null;
    repoName?: string | null;
    callbackContext?: CallbackContext | null;
  },
): Promise<RetrieveScope> {
  const callbackContext = input.callbackContext?.source === "slack" ? input.callbackContext : null;
  const intake = callbackContext ? await resolveSlackIntake(env, input.businessId, callbackContext) : null;
  const scope: RetrieveScope = {
    businessId: input.businessId,
    repoOwner: input.repoOwner ?? undefined,
    repoName: input.repoName ?? undefined,
    ...(callbackContext ? slackScope(callbackContext, { includeThread: !intake }) : {}),
  };

  if (intake?.scopeType === "customer" && intake.scopeId) scope.customerSlug = intake.scopeId;
  return scope;
}

export function normalizeCompanyMemoryCustomerScopeId(customerSlug: string | undefined): string | null {
  const normalized = customerSlug
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) return null;
  return normalized.startsWith("customer/") ? normalized.slice("customer/".length) || null : normalized;
}

function slackScope(
  callbackContext: SlackCallbackContext,
  opts: { includeThread: boolean },
): Pick<RetrieveScope, "teamId" | "channelId" | "threadTs"> {
  const scope: Pick<RetrieveScope, "teamId" | "channelId" | "threadTs"> = {
    teamId: callbackContext.slackTeamId,
    channelId: callbackContext.channel,
  };
  if (opts.includeThread) scope.threadTs = callbackContext.threadTs;
  return scope;
}

async function resolveSlackIntake(
  env: Env,
  businessId: string,
  callbackContext: SlackCallbackContext,
): Promise<SlackChannelIntakeRow | null> {
  return getChannelIntake(env.DB, businessId, callbackContext.slackTeamId, callbackContext.channel);
}
