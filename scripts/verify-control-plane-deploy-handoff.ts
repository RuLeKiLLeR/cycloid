#!/usr/bin/env tsx

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { sleep } from "../shared/utils/timing.js";

type Artifact = {
  schemaVersion: 1;
  classification: "pass" | "failed_deploy" | "failed_handoff";
  sessionId: string | null;
  promptId: string | null;
  originalPromptId: string | null;
  finalPromptId: string | null;
  runtimeSandboxId: string | null;
  beforeVersionId: string | null;
  afterVersionId: string | null;
  events: string[];
  error: string | null;
  startedAt: string;
  completedAt: string | null;
};

type Args = { baseUrl: string; token: string; deployUrl: string; artifact: string; timeoutMs: number };

function args(): Args {
  const values = new Map(
    process.argv.slice(2).map((value) => {
      const [key, ...rest] = value.replace(/^--/, "").split("=");
      return [key, rest.join("=")];
    }),
  );
  const baseUrl = values.get("base-url") || process.env.ARCANIST_API_URL || "https://qa.app.trycycloid.com";
  const token = values.get("token") || process.env.ARCANIST_TOKEN;
  const deployUrl = values.get("deploy-url");
  if (!token || !deployUrl)
    throw new Error("Usage: --token=<token> --deploy-url=<QA deploy probe URL> [--artifact=<path>]");
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    token,
    deployUrl,
    artifact: values.get("artifact") || "test-results/control-plane-deploy-handoff.json",
    timeoutMs: Number(values.get("timeout-ms") || 15 * 60 * 1000),
  };
}

async function request<T>(config: Args, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path.startsWith("http") ? path : `${config.baseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json", ...init.headers },
  });
  if (!response.ok) throw new Error(`${init.method || "GET"} ${path} returned HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function main(): Promise<void> {
  const config = args();
  const artifact: Artifact = {
    schemaVersion: 1,
    classification: "failed_handoff",
    sessionId: null,
    promptId: null,
    originalPromptId: null,
    finalPromptId: null,
    runtimeSandboxId: null,
    beforeVersionId: null,
    afterVersionId: null,
    events: [],
    error: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
  const deadline = Date.now() + config.timeoutMs;
  const writeArtifact = () => {
    mkdirSync(dirname(config.artifact), { recursive: true });
    writeFileSync(config.artifact, `${JSON.stringify(artifact, null, 2)}\n`);
  };
  let sessionId: string | null = null;
  try {
    const created = await request<{ sessionId: string }>(config, "/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        title: "control-plane deploy handoff verification",
        repoOwner: "trycycloid",
        repoName: "dummy-docker-app",
      }),
    });
    sessionId = created.sessionId;
    artifact.sessionId = sessionId;
    const prompt = await request<{ prompt?: { id?: string; promptId?: string } }>(
      config,
      `/api/sessions/${sessionId}/prompts`,
      {
        method: "POST",
        body: JSON.stringify({
          prompt: "Run a bounded 90-second verification task, then report completion. Do not modify the repository.",
        }),
      },
    );
    const promptId = prompt.prompt?.id ?? prompt.prompt?.promptId ?? null;
    artifact.promptId = promptId;
    artifact.originalPromptId = promptId;
    const before = await request<{ workerVersionId?: string; runtimeSandboxId?: string }>(
      config,
      `${config.deployUrl}/before`,
      { method: "POST", body: JSON.stringify({ sessionId }) },
    );
    artifact.beforeVersionId = before.workerVersionId ?? null;
    artifact.runtimeSandboxId = before.runtimeSandboxId ?? null;
    await request(config, config.deployUrl, { method: "POST", body: JSON.stringify({ sessionId }) });
    while (Date.now() < deadline) {
      const state = await request<{
        session?: { status?: string };
        prompts?: Array<{ id?: string; status?: string }>;
        workerVersionId?: string;
        runtimeSandboxId?: string;
        events?: string[];
      }>(config, `/api/sessions/${sessionId}/export`);
      const finalPrompt = state.prompts?.find((candidate) => candidate.id === artifact.originalPromptId);
      artifact.finalPromptId = finalPrompt?.id ?? artifact.finalPromptId;
      artifact.afterVersionId = state.workerVersionId ?? artifact.afterVersionId;
      artifact.runtimeSandboxId = state.runtimeSandboxId ?? artifact.runtimeSandboxId;
      artifact.events = state.events ?? artifact.events;
      if (finalPrompt?.status === "completed" || state.session?.status === "completed") {
        if (artifact.finalPromptId !== artifact.originalPromptId || artifact.runtimeSandboxId === null)
          throw new Error("Prompt or runtime sandbox changed during handoff");
        artifact.classification = "pass";
        artifact.completedAt = new Date().toISOString();
        return;
      }
      await sleep(5_000);
    }
    throw new Error("Timed out waiting for handoff verification");
  } catch (error) {
    artifact.error = error instanceof Error ? error.message : String(error);
    artifact.classification =
      artifact.beforeVersionId && artifact.afterVersionId === null ? "failed_deploy" : "failed_handoff";
    throw error;
  } finally {
    if (sessionId) await request(config, `/api/sessions/${sessionId}/stop`, { method: "POST" }).catch(() => undefined);
    artifact.completedAt = artifact.completedAt ?? new Date().toISOString();
    writeArtifact();
  }
}

main().catch((error) => {
  console.error(
    `Control-plane deploy handoff verification failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
