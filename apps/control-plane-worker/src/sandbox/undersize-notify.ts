// Internal "this customer needs a bigger sandbox" alert. Fired for any session
// when a kernel OOM-kill happens during a heavy build — the definitive signal
// that the repo's resource spec is too small. Posts to an internal Slack channel
// and emits a Datadog counter. Everything is best-effort: a telemetry/Slack
// hiccup must never break the session lifecycle, and the whole thing no-ops when
// its config (token/channel or DD key) is absent (local dev).

import { CONTROL_PLANE_SERVICE_NAME } from "../constants/observability";
import { postCountMetric } from "../observability/pr-metrics";
import {
  buildInternalAlertSessionFooter,
  escapeSlackText,
  resolveInternalAlertOwnerLabel,
} from "../slack/internal-alert-session-context";
import { postInternalAlert, resolveInternalAlertConfig } from "../slack/internal-alerts";
import type { Env } from "../types";
import { E2B_CLOUD_RUNTIME_BACKEND, type RuntimeBackend } from "./runtime-backend";

export interface SandboxUndersizedInput {
  sessionId: string;
  ownerUserId?: string | null;
  sandboxId?: string | null;
  runtimeBackend: RuntimeBackend | null;
  repoOwner: string | null;
  repoName: string | null;
  businessId: string | null;
  oomKills: number;
  // The process the kernel OOM-killed, when the bridge could read it from dmesg.
  // Turns "sandbox undersized" into "python3 (pytest) was killed" — the
  // actionable part. Null/absent when dmesg was unreadable in the sandbox.
  victimComm?: string | null;
  victimPid?: number | null;
  victimRssMb?: number | null;
  // The resolved sandbox spec that ran — names the template and the resources
  // that proved too small. Null when the repo could not be resolved.
  runtimeTemplateId?: string | null;
  cpuCount?: number | null;
  memoryMB?: number | null;
  // "repo" when the repo already has an explicit repo-sandbox-specs entry (so
  // the fix is bumping the existing tier, not adding one), "default" otherwise.
  specSource?: "default" | "repo" | null;
}

type UndersizeNotifyEnv = Pick<
  Env,
  "SLACK_BOT_TOKEN" | "SANDBOX_UNDERSIZED_NOTIFY_SLACK_CHANNEL" | "DD_API_KEY" | "FRONTEND_URL" | "WORKER_ENV"
> &
  Partial<Pick<Env, "DB">>;

function repoLabel(input: SandboxUndersizedInput): string {
  return input.repoOwner && input.repoName ? `${input.repoOwner}/${input.repoName}` : "(unknown repo)";
}

// "Template `X` (2 vCPU / 4096 MB) was too small. " when the spec is known, else
// "" so the message falls back to the generic phrasing.
function sizeClause(input: SandboxUndersizedInput): string {
  const hasResources = input.cpuCount != null && input.memoryMB != null;
  if (!input.runtimeTemplateId && !hasResources) return "";
  const tmpl = input.runtimeTemplateId ? `Template \`${input.runtimeTemplateId}\`` : "The sandbox";
  const resources = hasResources ? ` (${input.cpuCount} vCPU / ${input.memoryMB} MB)` : "";
  // When the repo already has a repo-sandbox-specs entry (`specSource === "repo"`)
  // the fix is to raise that existing tier, so say the tier was exceeded rather
  // than the misleading "was too small" (which reads as "no entry yet").
  const verb =
    input.specSource === "repo" && hasResources ? `— the ${input.memoryMB} MB tier was exceeded` : "was too small";
  return `${tmpl}${resources} ${verb}. `;
}

// "Killed `python3` (pid 30149, ~28 MB rss). " when the OOM victim was captured,
// else "" — the count-only fallback matches the pre-attribution behavior.
function victimClause(input: SandboxUndersizedInput): string {
  const comm = input.victimComm?.trim();
  if (!comm) return "";
  const pid = input.victimPid != null ? `pid ${input.victimPid}` : null;
  const rss = input.victimRssMb != null ? `~${input.victimRssMb} MB rss` : null;
  const detail = [pid, rss].filter(Boolean).join(", ");
  return detail ? `Killed \`${comm}\` (${detail}). ` : `Killed \`${comm}\`. `;
}

// When the repo already has a tier, tell the operator to raise it; otherwise the
// original "add an entry" guidance still applies.
function fixClause(input: SandboxUndersizedInput): string {
  return input.specSource === "repo"
    ? "Raise the repo's `repo-sandbox-specs` tier."
    : "The repo needs a larger `repo-sandbox-specs` entry.";
}

function sandboxIdLine(input: SandboxUndersizedInput): string | null {
  const sandboxId = input.sandboxId?.trim();
  if (!sandboxId) return null;
  if (input.runtimeBackend !== E2B_CLOUD_RUNTIME_BACKEND) {
    return `Sandbox: \`${escapeSlackText(sandboxId)}\``;
  }
  const url = `https://e2b.dev/dashboard/cycloid/sandboxes/${encodeURIComponent(sandboxId)}/`;
  return `E2B sandbox: <${url}|${escapeSlackText(sandboxId)}>`;
}

export async function notifySandboxUndersized(env: UndersizeNotifyEnv, input: SandboxUndersizedInput): Promise<void> {
  await Promise.allSettled([emitMetric(env, input), postSlack(env, input)]);
}

async function postSlack(env: UndersizeNotifyEnv, input: SandboxUndersizedInput): Promise<void> {
  const config = resolveInternalAlertConfig(env, env.SANDBOX_UNDERSIZED_NOTIFY_SLACK_CHANNEL);
  if (!config) return;

  const processes = input.oomKills === 1 ? "process" : "processes";
  const ownerUserLabel = await resolveInternalAlertOwnerLabel(env, input.ownerUserId ?? null, {
    sessionId: input.sessionId,
  });
  const sandboxLine = sandboxIdLine(input);
  const text = [
    `:warning: Sandbox undersized for *${repoLabel(input)}* — a kernel OOM-kill ` +
      `(${input.oomKills} ${processes}) during the session. ${victimClause(input)}${sizeClause(input)}` +
      fixClause(input),
    ...(sandboxLine ? [sandboxLine] : []),
    buildInternalAlertSessionFooter(env, {
      sessionId: input.sessionId,
      ownerUserLabel,
    }),
  ].join("\n");

  await postInternalAlert(env, config.channel, text, undefined, {
    sessionId: input.sessionId,
    ownerUserId: input.ownerUserId ?? null,
    ownerUserLabel,
    sandboxId: input.sandboxId ?? null,
  });
}

async function emitMetric(env: UndersizeNotifyEnv, input: SandboxUndersizedInput): Promise<void> {
  const ddApiKey = env.DD_API_KEY;
  if (!ddApiKey) return;

  const tags = [
    `service:${CONTROL_PLANE_SERVICE_NAME}`,
    `env:${env.WORKER_ENV || "production"}`,
    `reason:oom`,
    `repo_owner:${input.repoOwner ?? "unknown"}`,
    `repo_name:${input.repoName ?? "unknown"}`,
    ...(input.businessId ? [`business_id:${input.businessId}`] : []),
    ...(input.runtimeTemplateId ? [`template:${input.runtimeTemplateId}`] : []),
    ...(input.cpuCount != null ? [`cpu:${input.cpuCount}`] : []),
    ...(input.memoryMB != null ? [`memory_mb:${input.memoryMB}`] : []),
    // `victim_comm` is a process name (low cardinality) so it's safe as a tag —
    // lets the OOM monitor group by "python3 vs node vs jest". `victim_rss_mb`
    // is intentionally NOT a tag (unbounded numeric); it rides the Slack alert.
    ...(input.victimComm ? [`victim_comm:${input.victimComm}`] : []),
    ...(input.specSource ? [`spec_source:${input.specSource}`] : []),
  ];

  // postCountMetric handles the us5 v2-series POST, the 2s AbortSignal timeout,
  // and error swallowing — reused so this stays consistent with the other
  // control-plane counters.
  await postCountMetric(ddApiKey, "arcanist.sandbox.memory.undersized", tags, "sandbox-undersized");
}
