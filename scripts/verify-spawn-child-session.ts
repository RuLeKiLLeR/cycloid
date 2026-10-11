#!/usr/bin/env tsx
/**
 * Local E2E: prove that the `cycloid.spawn_child_session` bridge tool is
 * actually wired and reaches PR.
 *
 *   1. Create a parent session against the local control plane.
 *   2. Enqueue a prompt that instructs the agent to spawn N child sessions,
 *      each making a tiny harmless edit and opening a PR.
 *   3. Poll the parent session until its prompt completes.
 *   4. Poll the child-sessions list endpoint until every spawned child
 *      reports either a terminal status or a PR URL.
 *   5. Exit non-zero if the parent did not spawn at least one child, if any
 *      child failed, or if any settled child has no PR URL.
 *
 * Run while `npm run dev:full` (or `npm run dogfood:e2e`) is up.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Args = {
  baseUrl: string;
  token: string;
  repoOwner: string;
  repoName: string;
  ownerUserId?: string;
  model: string;
  reasoningEffort: string;
  childCount: number;
  timeoutMs: number;
  pollMs: number;
};

const DEFAULT_BASE = "http://localhost:3000";
const DEFAULT_REPO_OWNER = "jeman-verification";
const DEFAULT_REPO_NAME = "verification-prod";
const DEFAULT_MODEL = "gpt-5.4-mini";
const DEFAULT_REASONING = "low";
const DEFAULT_TIMEOUT_MS = 25 * 60 * 1000;
const DEFAULT_POLL_MS = 5_000;

function readDevVar(key: string): string | undefined {
  try {
    const text = readFileSync(resolve(process.cwd(), "apps/control-plane-worker/.dev.vars"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (match && match[1] === key) return match[2];
    }
  } catch {
    /* missing file is fine — caller falls back to env */
  }
  return undefined;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case "--base-url":
        out.baseUrl = v;
        i++;
        break;
      case "--repo-owner":
        out.repoOwner = v;
        i++;
        break;
      case "--repo-name":
        out.repoName = v;
        i++;
        break;
      case "--owner-user-id":
        out.ownerUserId = v;
        i++;
        break;
      case "--model":
        out.model = v;
        i++;
        break;
      case "--reasoning-effort":
        out.reasoningEffort = v;
        i++;
        break;
      case "--children":
        out.childCount = Number(v);
        i++;
        break;
      case "--timeout-ms":
        out.timeoutMs = Number(v);
        i++;
        break;
      case "--poll-ms":
        out.pollMs = Number(v);
        i++;
        break;
    }
  }
  const token =
    process.env.ARCANIST_TOKEN?.trim() ||
    process.env.ARCANIST_ADMIN_TOKEN?.trim() ||
    readDevVar("ARCANIST_ADMIN_TOKEN")?.trim() ||
    "";
  if (!token) throw new Error("Missing ARCANIST_TOKEN / ARCANIST_ADMIN_TOKEN.");
  return {
    baseUrl: (out.baseUrl ?? DEFAULT_BASE).replace(/\/$/, ""),
    token,
    repoOwner: out.repoOwner ?? DEFAULT_REPO_OWNER,
    repoName: out.repoName ?? DEFAULT_REPO_NAME,
    ownerUserId: out.ownerUserId,
    model: out.model ?? DEFAULT_MODEL,
    reasoningEffort: out.reasoningEffort ?? DEFAULT_REASONING,
    childCount: Number.isFinite(out.childCount) && out.childCount! > 0 ? out.childCount! : 3,
    timeoutMs: Number.isFinite(out.timeoutMs) && out.timeoutMs! > 0 ? out.timeoutMs! : DEFAULT_TIMEOUT_MS,
    pollMs: Number.isFinite(out.pollMs) && out.pollMs! > 0 ? out.pollMs! : DEFAULT_POLL_MS,
  };
}

async function api(args: Args, path: string, init: RequestInit = {}): Promise<Response> {
  const r = await fetch(`${args.baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers as Record<string, string> | undefined),
      authorization: `Bearer ${args.token}`,
    },
  });
  if (!r.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${r.status} ${await r.text()}`);
  return r;
}

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

function buildSpawnPrompt(args: Args): string {
  const stamp = new Date().toISOString();
  return [
    `Use the cycloid.spawn_child_session tool to launch exactly ${args.childCount} child sessions against repositoryId "${args.repoOwner}/${args.repoName}" (same repo as this parent session).`,
    "",
    "Each child must run an independent prompt that:",
    "  1. appends a single dated line of the form `verify-spawn-child-session: <ISO timestamp> <child-label>` to the bottom of README.md (create README.md if it does not exist),",
    "  2. commits the change on a new branch named `verify-spawn-${SHORT_TIMESTAMP}-${CHILD_LABEL}` (slug-safe),",
    "  3. opens a pull request titled `verify spawn child session ${CHILD_LABEL}` against the default branch with a one-line body, then stops.",
    "",
    `Child labels to use: child-a, child-b, child-c (use the first ${args.childCount}).`,
    `Use this verification timestamp in each child's prompt so we can correlate: ${stamp}`,
    "",
    "Important guardrails:",
    "  - Call cycloid.spawn_child_session once per child. Do NOT narrate fake child sessions; if the tool errors, report the error verbatim.",
    "  - Do NOT touch the parent repo yourself; the parent session must not edit files, just orchestrate.",
    "  - After all child sessions are kicked off, return a JSON summary listing each childSessionId.",
  ].join("\n");
}

type CreatedSession = { sessionId: string; sessionUrl?: string };
async function createParent(args: Args): Promise<CreatedSession> {
  const r = await api(args, "/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      context: { repoUrl: `https://github.com/${args.repoOwner}/${args.repoName}` },
      autoVerify: false,
      ...(args.ownerUserId ? { ownerUserId: args.ownerUserId } : {}),
      model: args.model,
      reasoningEffort: args.reasoningEffort,
    }),
  });
  return (await r.json()) as CreatedSession;
}

async function enqueue(args: Args, sessionId: string, prompt: string): Promise<string> {
  const r = await api(args, `/api/sessions/${sessionId}/prompts`, { method: "POST", body: JSON.stringify({ prompt }) });
  const j = (await r.json()) as { prompt?: { id?: string; promptId?: string } };
  const id = j.prompt?.id ?? j.prompt?.promptId;
  if (!id) throw new Error("Prompt enqueue did not return an id");
  return id;
}

type PromptRecord = { id?: string; promptId?: string; status?: string; error?: string | null };
async function fetchPrompt(args: Args, sessionId: string, promptId: string): Promise<PromptRecord | undefined> {
  const r = await api(args, `/api/sessions/${sessionId}/export`);
  const j = (await r.json()) as { prompts?: PromptRecord[] };
  return j.prompts?.find((p) => (p.id ?? p.promptId) === promptId);
}

type ChildSummary = {
  childSessionId: string;
  childSessionUrl: string;
  title: string | null;
  status: "pending" | "running" | "completed" | "failed" | "canceled";
  prUrl: string | null;
  failureReason: string | null;
};
async function fetchChildren(args: Args, sessionId: string): Promise<ChildSummary[]> {
  const r = await api(args, `/api/sessions/${sessionId}/child-sessions?include=prUrl`);
  const j = (await r.json()) as { children?: ChildSummary[] };
  return j.children ?? [];
}

function isTerminal(status: ChildSummary["status"]): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    "[verify-spawn] base=",
    args.baseUrl,
    "repo=",
    `${args.repoOwner}/${args.repoName}`,
    "model=",
    args.model,
  );

  const parent = await createParent(args);
  console.log("[verify-spawn] parent sessionId=", parent.sessionId);

  const prompt = buildSpawnPrompt(args);
  const promptId = await enqueue(args, parent.sessionId, prompt);
  console.log("[verify-spawn] enqueued promptId=", promptId);

  const start = Date.now();
  let parentDone = false;
  let lastParentStatus = "";
  let lastChildCount = -1;
  const seenChildren = new Map<string, ChildSummary>();

  while (Date.now() - start < args.timeoutMs) {
    await sleep(args.pollMs);

    if (!parentDone) {
      const p = await fetchPrompt(args, parent.sessionId, promptId).catch(() => undefined);
      const status = p?.status ?? "?";
      if (status !== lastParentStatus) {
        console.log(`[verify-spawn] parent prompt status=${status}`);
        lastParentStatus = status;
      }
      if (p && status !== "queued" && status !== "processing") {
        parentDone = true;
        if (status !== "completed") {
          throw new Error(`Parent prompt did not complete (status=${status}, error=${p.error ?? "none"})`);
        }
      }
    }

    const children = await fetchChildren(args, parent.sessionId).catch(() => []);
    if (children.length !== lastChildCount) {
      console.log(`[verify-spawn] children visible: ${children.length}`);
      lastChildCount = children.length;
    }
    for (const c of children) seenChildren.set(c.childSessionId, c);

    if (parentDone && children.length > 0 && children.every((c) => isTerminal(c.status))) {
      break;
    }
  }

  if (seenChildren.size === 0) {
    throw new Error("FAIL: no child sessions were created");
  }
  const failures: string[] = [];
  for (const c of seenChildren.values()) {
    if (c.status === "failed") failures.push(`${c.childSessionId} failed: ${c.failureReason ?? "unknown"}`);
    if (c.status === "completed" && !c.prUrl) failures.push(`${c.childSessionId} completed but has no PR URL`);
  }
  if (failures.length) {
    throw new Error(`FAIL: child verification failed:\n  - ${failures.join("\n  - ")}`);
  }

  console.log("[verify-spawn] PASS");
  console.log(
    JSON.stringify(
      {
        parentSessionId: parent.sessionId,
        children: Array.from(seenChildren.values()),
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error("[verify-spawn] error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
