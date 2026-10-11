import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WATCH_REPLAY_PAGE_SIZE } from "../../apps/cli/src/constants/watch.js";

// ---------------------------------------------------------------------------
// Mock config so commands see a logged-in state (or not).
// ---------------------------------------------------------------------------

const mockConfig = {
  apiUrl: "https://app.trycycloid.com",
  token: "arc_test_token_123",
};

let configOverride: typeof mockConfig | null = mockConfig;

vi.mock("../../apps/cli/src/config", () => ({
  loadConfig: () => configOverride,
  requireConfig: () => {
    if (!configOverride) {
      console.error("Error: Not logged in. Run `cycloid auth login` first.");
      process.exit(1);
    }
    return configOverride;
  },
  resolveLoginApiUrl: (apiUrl?: string) => apiUrl ?? "https://app.trycycloid.com",
  saveConfig: vi.fn(),
  validateApiUrl: vi.fn(() => null),
}));

// ---------------------------------------------------------------------------
// Capture console output and process.exit calls.
// ---------------------------------------------------------------------------

let consoleOutput: { log: string[]; error: string[]; warn: string[] };
let exitCode: number | undefined;
let stdoutWrites: string[];
let tempDirs: string[];

beforeEach(() => {
  consoleOutput = { log: [], error: [], warn: [] };
  exitCode = undefined;
  stdoutWrites = [];
  tempDirs = [];
  configOverride = { ...mockConfig };

  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    consoleOutput.log.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    consoleOutput.error.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    consoleOutput.warn.push(args.map(String).join(" "));
  });
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    stdoutWrites.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process, "exit").mockImplementation((code?: number | string | null | undefined) => {
    exitCode = typeof code === "number" ? code : undefined;
    throw new Error(`process.exit(${code})`);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------
// Helper to stub global fetch for API responses.
// ---------------------------------------------------------------------------

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    return handler(urlStr, init);
  });
}

async function writeTempUpload(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cycloid-cli-upload-"));
  tempDirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, content, "utf8");
  return path;
}

// ===========================================================================
// validateRepoUrl
// ===========================================================================

type ValidateRepoUrlModule = {
  validateRepoUrl: (url: string) => string | null;
};

describe("validateRepoUrl", () => {
  let mod: ValidateRepoUrlModule;

  beforeEach(async () => {
    const modulePath: string = "../../apps/cli/src/commands/create";
    mod = (await import(modulePath)) as unknown as ValidateRepoUrlModule;
  });

  it("accepts HTTPS GitHub URLs", () => {
    expect(mod.validateRepoUrl("https://github.com/org/repo")).toBeNull();
    expect(mod.validateRepoUrl("https://github.com/org/repo.git")).toBeNull();
    expect(mod.validateRepoUrl("https://github.com/org/repo/")).toBeNull();
  });

  it("accepts HTTP GitHub URLs", () => {
    expect(mod.validateRepoUrl("http://github.com/org/repo")).toBeNull();
  });

  it("accepts owner/repo shorthand", () => {
    expect(mod.validateRepoUrl("org/repo")).toBeNull();
    expect(mod.validateRepoUrl("my-org/my-repo.js")).toBeNull();
  });

  it("accepts SSH URLs", () => {
    expect(mod.validateRepoUrl("git@github.com:org/repo")).toBeNull();
    expect(mod.validateRepoUrl("git@github.com:org/repo.git")).toBeNull();
  });

  it("rejects bare words", () => {
    const result = mod.validateRepoUrl("cook");
    expect(result).not.toBeNull();
    expect(result).toContain("Invalid repo URL");
  });

  it("rejects empty string", () => {
    expect(mod.validateRepoUrl("")).not.toBeNull();
  });

  it("rejects URLs without owner/repo path", () => {
    expect(mod.validateRepoUrl("https://github.com/")).not.toBeNull();
    expect(mod.validateRepoUrl("https://github.com")).not.toBeNull();
  });

  it("rejects random URLs that are not GitHub", () => {
    expect(mod.validateRepoUrl("https://example.com/foo/bar")).not.toBeNull();
  });
});

// ===========================================================================
// createCommand
// ===========================================================================

type CreateModule = {
  createCommand: (
    repoUrl: string,
    prompt: string | undefined,
    options: {
      model?: string;
      backend?: string;
      reasoningEffort?: string;
      autoVerify?: boolean;
      baseBranch?: string;
      startBranch?: string;
      continuePr?: string;
      continueMode?: string;
      promptStdin?: boolean;
      uploadedFile?: string | string[];
      wait?: boolean;
      pollInterval?: string;
      json?: boolean;
      cold?: boolean;
      onboarding?: boolean;
    },
  ) => Promise<void>;
  validateRepoUrl: (url: string) => string | null;
};

type QaModule = {
  qaCommand: (
    prUrl: string,
    options: {
      model?: string;
      backend?: string;
      reasoningEffort?: string;
      wait?: boolean;
      pollInterval?: string;
      idempotencyKey?: string;
      json?: boolean;
    },
  ) => Promise<void>;
};

type LoginModule = {
  loginCommand: (options: { token?: string; apiUrl?: string; json?: boolean }) => Promise<void>;
};

describe("loginCommand", () => {
  let mod: LoginModule;

  beforeEach(async () => {
    const modulePath: string = "../../apps/cli/src/commands/login";
    mod = (await import(modulePath)) as unknown as LoginModule;
  });

  it("preserves the invalid-token warning for 401 verification failures", async () => {
    stubFetch(() => new Response("Unauthorized", { status: 401 }));

    await mod.loginCommand({ token: "arc_bad" });

    expect(consoleOutput.warn).toContain("Warning: Token could not be verified (401). It may be invalid or expired.");
  });
});

describe("createCommand", () => {
  let mod: CreateModule;

  beforeEach(async () => {
    const modulePath: string = "../../apps/cli/src/commands/create";
    mod = (await import(modulePath)) as unknown as CreateModule;
  });

  it("prints session ID and URL on success", async () => {
    stubFetch((url) => {
      if (url.includes("/api/sessions") && !url.includes("/prompts")) {
        return Response.json({ sessionId: "ses_abc123" });
      }
      if (url.includes("/prompts")) {
        return Response.json({ ok: true });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.createCommand("https://github.com/org/repo", "fix the bug", {});

    expect(consoleOutput.log).toContainEqual(expect.stringContaining("ses_abc123"));
    expect(consoleOutput.log).toContain("Follow with: cycloid sessions events ses_abc123 --follow --json");
    expect(consoleOutput.log).not.toContainEqual(expect.stringContaining(":5173"));
  });

  it("exits with error when not logged in", async () => {
    configOverride = null;

    await expect(mod.createCommand("https://github.com/org/repo", "test", {})).rejects.toThrow("process.exit(1)");
    expect(exitCode).toBe(1);
    expect(consoleOutput.error).toContainEqual(expect.stringContaining("Not logged in"));
  });

  it("rejects invalid repo URL before making any API call", async () => {
    let fetchCalled = false;
    stubFetch(() => {
      fetchCalled = true;
      return Response.json({ sessionId: "should-not-reach" });
    });

    await expect(mod.createCommand("cook", "fix the bug", {})).rejects.toThrow("Invalid repo URL");

    expect(exitCode).toBeUndefined();
    expect(fetchCalled).toBe(false);
  });

  it("blocks nested session creation from verification sessions before any API call", async () => {
    const previousRole = process.env.ARCANIST_AGENT_ROLE;
    process.env.ARCANIST_AGENT_ROLE = "verification";
    let fetchCalled = false;
    stubFetch(() => {
      fetchCalled = true;
      return Response.json({ sessionId: "should-not-reach" });
    });

    try {
      await expect(mod.createCommand("https://github.com/org/repo", "fix the bug", {})).rejects.toThrow(
        "disabled inside verification sessions",
      );
    } finally {
      if (previousRole === undefined) delete process.env.ARCANIST_AGENT_ROLE;
      else process.env.ARCANIST_AGENT_ROLE = previousRole;
    }

    expect(fetchCalled).toBe(false);
  });

  it("rejects non-GitHub HTTPS URLs", async () => {
    let fetchCalled = false;
    stubFetch(() => {
      fetchCalled = true;
      return Response.json({ sessionId: "should-not-reach" });
    });

    await expect(mod.createCommand("https://example.com/foo/bar", "test", {})).rejects.toThrow("Invalid repo URL");

    expect(exitCode).toBeUndefined();
    expect(fetchCalled).toBe(false);
  });

  it("handles partial failure: session created but prompt send fails", async () => {
    let callCount = 0;
    stubFetch((url) => {
      callCount++;
      if (url.includes("/api/sessions") && !url.includes("/prompts")) {
        return Response.json({ sessionId: "ses_partial" });
      }
      // Prompt endpoint fails
      if (url.includes("/prompts")) {
        return new Response("Internal Server Error", {
          status: 500,
          headers: { "x-request-id": "req_partial" },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    await expect(mod.createCommand("https://github.com/org/repo", "do something", {})).rejects.toMatchObject({
      exitCode: 10,
      message: expect.stringContaining("prompt failed"),
      requestId: "req_partial",
      data: { sessionId: "ses_partial" },
    });

    expect(exitCode).toBeUndefined();
  });

  it("handles session creation failure", async () => {
    stubFetch(() => new Response("Service Unavailable", { status: 503 }));

    await expect(mod.createCommand("https://github.com/org/repo", "test", {})).rejects.toThrow("API error 503");

    expect(exitCode).toBeUndefined();
  });

  it("does not guess a UI URL when the server omits sessionUrl", async () => {
    configOverride = { apiUrl: "https://localhost:3000", token: "arc_t" };

    stubFetch((url) => {
      if (url.includes("/api/sessions") && !url.includes("/prompts")) {
        return Response.json({ sessionId: "ses_1" });
      }
      return Response.json({ ok: true });
    });

    await mod.createCommand("https://github.com/org/repo", "test", {});

    expect(consoleOutput.log).not.toContainEqual(expect.stringContaining("https://localhost:5173"));
  });

  it("preserves raw stdin prompt whitespace", async () => {
    const bodies: string[] = [];
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* (): AsyncGenerator<
      Buffer,
      undefined,
      unknown
    > {
      yield Buffer.from("  keep indentation\n\n");
      return undefined;
    });
    stubFetch((url, init) => {
      if (init?.body) bodies.push(String(init.body));
      if (url.includes("/api/sessions") && !url.includes("/prompts")) {
        return Response.json({ sessionId: "ses_stdin" });
      }
      return Response.json({ ok: true });
    });

    await mod.createCommand("https://github.com/org/repo", undefined, { promptStdin: true });

    expect(bodies.some((body) => body.includes("  keep indentation\\n\\n"))).toBe(true);
  });

  it("sends reasoningEffort and includes it in JSON output", async () => {
    let createBody: Record<string, unknown> | undefined;

    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions")) {
        createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          sessionId: "ses_reasoning",
          sessionUrl: "https://app.trycycloid.com/sessions/ses_reasoning",
        });
      }
      if (url.endsWith("/api/sessions/ses_reasoning/prompts")) {
        return Response.json({ prompt: { promptId: "p-reasoning" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.createCommand("https://github.com/org/repo", "fix the bug", { reasoningEffort: "max", json: true });

    expect(createBody?.reasoningEffort).toBe("max");
    expect(JSON.parse(stdoutWrites.join(""))).toMatchObject({
      sessionId: "ses_reasoning",
      sessionUrl: "https://app.trycycloid.com/sessions/ses_reasoning",
      reasoningEffort: "max",
      promptId: "p-reasoning",
    });
    expect(JSON.parse(stdoutWrites.join(""))).not.toHaveProperty("nextSteps");
  });

  it("sends autoVerify:true in body and includes it in JSON output", async () => {
    let createBody: Record<string, unknown> | undefined;

    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions")) {
        createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          sessionId: "ses_auto_verify",
          sessionUrl: "https://app.trycycloid.com/sessions/ses_auto_verify",
        });
      }
      if (url.endsWith("/api/sessions/ses_auto_verify/prompts")) {
        return Response.json({ prompt: { promptId: "p-auto-verify" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.createCommand("https://github.com/org/repo", "fix the bug", { autoVerify: true, json: true });

    expect(createBody?.autoVerify).toBe(true);
    expect(JSON.parse(stdoutWrites.join(""))).toMatchObject({
      sessionId: "ses_auto_verify",
      sessionUrl: "https://app.trycycloid.com/sessions/ses_auto_verify",
      autoVerify: true,
      promptId: "p-auto-verify",
    });
  });

  it("omits autoVerify from body when --auto-verify is not passed", async () => {
    let createBody: Record<string, unknown> | undefined;

    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions")) {
        createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ sessionId: "ses_default_auto_verify" });
      }
      if (url.endsWith("/api/sessions/ses_default_auto_verify/prompts")) {
        return Response.json({ prompt: { promptId: "p-default-auto-verify" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.createCommand("https://github.com/org/repo", "fix the bug", {});

    expect(createBody).toBeDefined();
    expect("autoVerify" in (createBody ?? {})).toBe(false);
  });

  it("sends cold:true in body when --cold is passed", async () => {
    let createBody: Record<string, unknown> | undefined;

    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions")) {
        createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ sessionId: "ses_cold" });
      }
      if (url.endsWith("/api/sessions/ses_cold/prompts")) {
        return Response.json({ prompt: { promptId: "p-cold" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.createCommand("https://github.com/org/repo", "fix the bug", { cold: true });

    expect(createBody?.cold).toBe(true);
  });

  it("sends the canonical prompt for --onboarding without one supplied", async () => {
    let createBody: Record<string, unknown> | undefined;
    let promptBody: Record<string, unknown> | undefined;

    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions")) {
        createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ sessionId: "ses_onboard" });
      }
      if (url.endsWith("/api/sessions/ses_onboard/prompts")) {
        promptBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ prompt: { promptId: "p-onboard" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.createCommand("https://github.com/org/repo", undefined, { onboarding: true });

    expect(createBody?.onboarding).toBe(true);
    expect(promptBody?.prompt).toBe("Onboard this repository onto Cycloid.");
  });

  it("ignores a prompt supplied alongside --onboarding", async () => {
    let promptBody: Record<string, unknown> | undefined;
    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions")) {
        return Response.json({ sessionId: "ses_onboard2" });
      }
      if (url.endsWith("/api/sessions/ses_onboard2/prompts")) {
        promptBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ prompt: { promptId: "p-onboard2" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.createCommand("https://github.com/org/repo", "ignore me", { onboarding: true });

    expect(promptBody?.prompt).toBe("Onboard this repository onto Cycloid.");
  });

  it("still requires a prompt without --onboarding", async () => {
    let fetchCalled = false;
    stubFetch(() => {
      fetchCalled = true;
      return Response.json({ sessionId: "should-not-reach" });
    });

    await expect(mod.createCommand("https://github.com/org/repo", undefined, {})).rejects.toThrow("Missing prompt");

    expect(fetchCalled).toBe(false);
  });

  it("sends baseBranch in body and includes it in JSON output when --base-branch is passed", async () => {
    let createBody: Record<string, unknown> | undefined;

    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions")) {
        createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          sessionId: "ses_base_branch",
          sessionUrl: "https://app.trycycloid.com/sessions/ses_base_branch",
        });
      }
      if (url.endsWith("/api/sessions/ses_base_branch/prompts")) {
        return Response.json({ prompt: { promptId: "p-base-branch" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.createCommand("https://github.com/org/repo", "fix the bug", { baseBranch: " feature/x ", json: true });

    expect(createBody?.baseBranch).toBe("feature/x");
    expect(JSON.parse(stdoutWrites.join(""))).toMatchObject({
      sessionId: "ses_base_branch",
      sessionUrl: "https://app.trycycloid.com/sessions/ses_base_branch",
      baseBranch: "feature/x",
      promptId: "p-base-branch",
    });
  });

  it("omits baseBranch from body when --base-branch is not passed", async () => {
    let createBody: Record<string, unknown> | undefined;

    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions")) {
        createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ sessionId: "ses_default_branch" });
      }
      if (url.endsWith("/api/sessions/ses_default_branch/prompts")) {
        return Response.json({ prompt: { promptId: "p-default-branch" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.createCommand("https://github.com/org/repo", "fix the bug", {});

    expect(createBody).toBeDefined();
    expect("baseBranch" in (createBody ?? {})).toBe(false);
  });

  it("sends startBranch in body and JSON output when --start-branch is passed", async () => {
    let createBody: Record<string, unknown> | undefined;
    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions")) {
        createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ sessionId: "ses_start" });
      }
      if (url.endsWith("/api/sessions/ses_start/prompts")) {
        return Response.json({ prompt: { promptId: "p-start" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.createCommand("https://github.com/org/repo", "continue this", {
      startBranch: " wip/resume-me ",
      json: true,
    });

    expect(createBody?.startBranch).toBe("wip/resume-me");
    expect(JSON.parse(stdoutWrites.join(""))).toMatchObject({ startBranch: "wip/resume-me" });
  });

  it("sends a prompt preview and continuation options in the create body and JSON output", async () => {
    let createBody: Record<string, unknown> | undefined;
    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions")) {
        createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ sessionId: "ses_continue" });
      }
      if (url.endsWith("/api/sessions/ses_continue/prompts")) {
        return Response.json({ prompt: { promptId: "p-continue" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.createCommand("https://github.com/org/repo", "finish this PR", {
      continuePr: " https://github.com/org/repo/pull/123 ",
      continueMode: " update-pr ",
      json: true,
    });

    expect(createBody).toMatchObject({
      prompt: "finish this PR",
      continuePrUrl: "https://github.com/org/repo/pull/123",
      continueMode: "update-pr",
    });
    expect(JSON.parse(stdoutWrites.join(""))).toMatchObject({
      continuePrUrl: "https://github.com/org/repo/pull/123",
      continueMode: "update-pr",
      promptId: "p-continue",
    });
  });

  it("caps the create-body prompt preview while sending the full prompt to the prompt endpoint", async () => {
    let createBody: Record<string, unknown> | undefined;
    let promptBody: Record<string, unknown> | undefined;
    const largePrompt = `finish this PR https://github.com/org/repo/pull/123\n${"x".repeat(8_000)}`;

    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions")) {
        createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ sessionId: "ses_large" });
      }
      if (url.endsWith("/api/sessions/ses_large/prompts")) {
        promptBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ prompt: { promptId: "p-large" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.createCommand("https://github.com/org/repo", largePrompt, {});

    expect(typeof createBody?.prompt).toBe("string");
    expect((createBody?.prompt as string).length).toBe(4_000);
    expect(createBody?.prompt).toContain("https://github.com/org/repo/pull/123");
    expect(promptBody?.prompt).toBe(largePrompt);
  });

  it("rejects empty continuation CLI options before making any API call", async () => {
    let fetchCalled = false;
    stubFetch(() => {
      fetchCalled = true;
      return Response.json({ sessionId: "should-not-reach" });
    });

    await expect(
      mod.createCommand("https://github.com/org/repo", "finish this PR", { continuePr: "   " }),
    ).rejects.toThrow("--continue-pr must not be empty");
    await expect(
      mod.createCommand("https://github.com/org/repo", "finish this PR", { continueMode: "   " }),
    ).rejects.toThrow("--continue-mode must not be empty");
    expect(fetchCalled).toBe(false);
  });

  it("rejects whitespace-only --base-branch before making any API call", async () => {
    let fetchCalled = false;
    stubFetch(() => {
      fetchCalled = true;
      return Response.json({ sessionId: "should-not-reach" });
    });

    await expect(
      mod.createCommand("https://github.com/org/repo", "fix the bug", { baseBranch: "   " }),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: "--base-branch must not be empty.",
    });

    expect(fetchCalled).toBe(false);
  });

  it("omits cold from body when --cold is not passed", async () => {
    let createBody: Record<string, unknown> | undefined;

    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions")) {
        createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ sessionId: "ses_warm" });
      }
      if (url.endsWith("/api/sessions/ses_warm/prompts")) {
        return Response.json({ prompt: { promptId: "p-warm" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.createCommand("https://github.com/org/repo", "fix the bug", {});

    expect(createBody).toBeDefined();
    expect("cold" in (createBody ?? {})).toBe(false);
  });

  it("sends onboarding:true in body when --onboarding is passed, and omits it otherwise", async () => {
    let createBody: Record<string, unknown> | undefined;

    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions")) {
        createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ sessionId: "ses_onboard" });
      }
      if (url.endsWith("/api/sessions/ses_onboard/prompts")) {
        return Response.json({ prompt: { promptId: "p-onboard" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.createCommand("https://github.com/org/repo", undefined, { onboarding: true });
    expect(createBody?.onboarding).toBe(true);

    await mod.createCommand("https://github.com/org/repo", "onboard this repo", {});
    expect("onboarding" in (createBody ?? {})).toBe(false);
  });

  it("sends agentRuntimeBackend in the body when --backend claude_code with a matching model", async () => {
    let createBody: Record<string, unknown> | undefined;

    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions")) {
        createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ sessionId: "ses_claude" });
      }
      if (url.endsWith("/api/sessions/ses_claude/prompts")) {
        return Response.json({ prompt: { promptId: "p-claude" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.createCommand("https://github.com/org/repo", "fix the bug", {
      backend: "claude_code",
      model: "claude-opus-4-8",
    });

    expect(createBody).toMatchObject({ agentRuntimeBackend: "claude_code", model: "claude-opus-4-8" });
  });

  it("sends agentRuntimeBackend in the body when --backend opencode with a matching model", async () => {
    let createBody: Record<string, unknown> | undefined;

    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions")) {
        createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ sessionId: "ses_opencode" });
      }
      if (url.endsWith("/api/sessions/ses_opencode/prompts")) {
        return Response.json({ prompt: { promptId: "p-opencode" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.createCommand("https://github.com/org/repo", "fix the bug", {
      backend: "opencode",
      model: "kimi-k2.7-code",
    });

    expect(createBody).toMatchObject({ agentRuntimeBackend: "opencode", model: "kimi-k2.7-code" });
  });

  it("rejects opencode with a non-opencode model before any network call", async () => {
    stubFetch(() => {
      throw new Error("should not fetch");
    });

    await expect(
      mod.createCommand("https://github.com/org/repo", "fix the bug", { backend: "opencode", model: "gpt-5.5" }),
    ).rejects.toThrow(/not selectable for backend 'opencode'/);
  });

  it("accepts a provider-qualified model and forwards it raw (server normalizes)", async () => {
    let createBody: Record<string, unknown> | undefined;

    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions")) {
        createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ sessionId: "ses_pq" });
      }
      if (url.endsWith("/api/sessions/ses_pq/prompts")) {
        return Response.json({ prompt: { promptId: "p-pq" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.createCommand("https://github.com/org/repo", "fix the bug", {
      backend: "claude_code",
      model: "anthropic/claude-opus-4-8",
    });

    expect(createBody).toMatchObject({ agentRuntimeBackend: "claude_code", model: "anthropic/claude-opus-4-8" });
  });

  it("omits agentRuntimeBackend from body when --backend is not passed", async () => {
    let createBody: Record<string, unknown> | undefined;

    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions")) {
        createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ sessionId: "ses_default" });
      }
      if (url.endsWith("/api/sessions/ses_default/prompts")) {
        return Response.json({ prompt: { promptId: "p-default" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.createCommand("https://github.com/org/repo", "fix the bug", {});

    expect("agentRuntimeBackend" in (createBody ?? {})).toBe(false);
  });

  it("rejects an unknown --backend before any network call", async () => {
    stubFetch(() => {
      throw new Error("should not fetch");
    });

    await expect(mod.createCommand("https://github.com/org/repo", "fix the bug", { backend: "bogus" })).rejects.toThrow(
      /Invalid --backend/,
    );
  });

  it("rejects a model that does not match the chosen backend before any network call", async () => {
    stubFetch(() => {
      throw new Error("should not fetch");
    });

    await expect(
      mod.createCommand("https://github.com/org/repo", "fix the bug", { backend: "claude_code", model: "gpt-5.5" }),
    ).rejects.toThrow(/not selectable for backend 'claude_code'/);
  });

  it("sends uploaded files with the initial prompt", async () => {
    const uploadPath = await writeTempUpload("trace.txt", "stack trace line one\n");
    let promptBody: Record<string, unknown> | undefined;

    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions")) {
        return Response.json({ sessionId: "ses_upload" });
      }
      if (url.endsWith("/api/sessions/ses_upload/prompts")) {
        promptBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ prompt: { promptId: "p-upload" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.createCommand("https://github.com/org/repo", "review this trace", { uploadedFile: uploadPath });

    expect(promptBody).toMatchObject({
      prompt: "review this trace",
      uploadedFiles: [{ name: "trace.txt", content: "stack trace line one\n" }],
    });
  });

  it("rejects unreadable uploaded files before creating a session", async () => {
    let fetchCalled = false;
    stubFetch(() => {
      fetchCalled = true;
      return Response.json({});
    });

    await expect(
      mod.createCommand("https://github.com/org/repo", "review this trace", {
        uploadedFile: join(tmpdir(), "missing-cycloid-upload.txt"),
      }),
    ).rejects.toThrow("Failed to read uploaded file");

    expect(fetchCalled).toBe(false);
  });

  it("rejects binary uploaded files before creating a session", async () => {
    const uploadPath = await writeTempUpload("trace.txt", "line one\0line two");
    let fetchCalled = false;
    stubFetch(() => {
      fetchCalled = true;
      return Response.json({});
    });

    await expect(
      mod.createCommand("https://github.com/org/repo", "review this trace", { uploadedFile: uploadPath }),
    ).rejects.toThrow("Binary files are not supported");

    expect(fetchCalled).toBe(false);
  });

  it("rejects duplicate uploaded file basenames before creating a session", async () => {
    const firstUpload = await writeTempUpload("trace.txt", "first file");
    const secondUpload = await writeTempUpload("trace.txt", "second file");
    let fetchCalled = false;
    stubFetch(() => {
      fetchCalled = true;
      return Response.json({});
    });

    await expect(
      mod.createCommand("https://github.com/org/repo", "review these traces", {
        uploadedFile: [firstUpload, secondUpload],
      }),
    ).rejects.toThrow("Duplicate uploaded-file basenames: trace.txt");

    expect(fetchCalled).toBe(false);
  });

  it("rejects unsupported uploaded file extensions before creating a session", async () => {
    const uploadPath = await writeTempUpload("script.py", "print('hello')\n");
    let fetchCalled = false;
    stubFetch(() => {
      fetchCalled = true;
      return Response.json({});
    });

    await expect(
      mod.createCommand("https://github.com/org/repo", "review this script", { uploadedFile: uploadPath }),
    ).rejects.toThrow("Unsupported file type: script.py");

    expect(fetchCalled).toBe(false);
  });

  it("waits for the created prompt to complete before returning in interactive mode", async () => {
    let eventsCallCount = 0;
    let promptReads = 0;

    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions")) {
        return Response.json({ sessionId: "ses_wait", sessionUrl: "https://app.trycycloid.com/sessions/ses_wait" });
      }
      if (url.endsWith("/api/sessions/ses_wait/prompts")) {
        if (init?.method === "POST") {
          return Response.json({ prompt: { promptId: "p-1" } });
        }
        promptReads++;
        if (promptReads === 1) {
          return Response.json({ prompts: [{ promptId: "p-1", prompt: "Fix the login bug" }] });
        }
        return Response.json({ prompts: [{ promptId: "p-1", status: "completed", error: null }] });
      }
      if (url.includes("/api/sessions/ses_wait/events?")) {
        eventsCallCount++;
        if (eventsCallCount === 1) {
          return new Response(
            makeSse([
              { event: "status", data: { phase: "running", title: "Fix the login bug" } },
              { event: "text", id: 1, data: { text: "working" } },
            ]),
          );
        }
        return new Response(
          makeSse([
            { event: "status", data: { phase: "completed" } },
            { event: "prompt_completed", id: 2, data: { promptId: "p-1" } },
          ]),
        );
      }
      if (url.endsWith("/api/sessions/ses_wait")) {
        return Response.json({ session: { sessionId: "ses_wait", phase: "completed", baseBranch: "main" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.createCommand("https://github.com/org/repo", "fix the bug", { wait: true, pollInterval: "250" });

    expect(consoleOutput.log).toContain("Session: ses_wait");
    expect(consoleOutput.log).toContain("URL: https://app.trycycloid.com/sessions/ses_wait");
    expect(consoleOutput.log).toContainEqual(expect.stringContaining("[prompt] p-1 completed"));
    expect(consoleOutput.log).not.toContainEqual(expect.stringContaining("PR:"));
    expect(consoleOutput.log).not.toContainEqual(expect.stringContaining("Branch:"));
    expect(stdoutWrites.join("")).toContain("assistant> working");
  });

  it("prints the PR line after create --wait in human mode when publishing has populated it", async () => {
    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions")) {
        return Response.json({ sessionId: "ses_wait_pr" });
      }
      if (url.endsWith("/api/sessions/ses_wait_pr/prompts")) {
        if (init?.method === "POST") {
          return Response.json({ prompt: { promptId: "p-pr" } });
        }
        return Response.json({ prompts: [{ promptId: "p-pr", status: "completed", error: null }] });
      }
      if (url.includes("/api/sessions/ses_wait_pr/events?")) {
        return new Response(makeSse([{ event: "status", data: { phase: "completed" } }]));
      }
      if (url.endsWith("/api/sessions/ses_wait_pr")) {
        return Response.json({
          session: {
            sessionId: "ses_wait_pr",
            phase: "completed",
            prUrl: "https://github.com/org/repo/pull/42",
            publishedBranch: "agent/fix",
            baseBranch: "main",
          },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.createCommand("https://github.com/org/repo", "fix the bug", { wait: true, pollInterval: "250" });

    expect(consoleOutput.log).toContain("PR: https://github.com/org/repo/pull/42 (agent/fix)");
  });

  it("prints no result line after create --wait when publishing has not populated one yet", async () => {
    let sessionReads = 0;

    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions")) {
        return Response.json({ sessionId: "ses_wait_publish_race" });
      }
      if (url.endsWith("/api/sessions/ses_wait_publish_race/prompts")) {
        if (init?.method === "POST") {
          return Response.json({ prompt: { promptId: "p-race" } });
        }
        return Response.json({ prompts: [{ promptId: "p-race", status: "completed", error: null }] });
      }
      if (url.includes("/api/sessions/ses_wait_publish_race/events?")) {
        return new Response(makeSse([{ event: "status", data: { phase: "completed" } }]));
      }
      if (url.endsWith("/api/sessions/ses_wait_publish_race")) {
        sessionReads++;
        return Response.json({
          session: {
            sessionId: "ses_wait_publish_race",
            phase: "completed",
            baseBranch: "main",
          },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.createCommand("https://github.com/org/repo", "fix the bug", { wait: true, pollInterval: "250" });

    expect(consoleOutput.log).not.toContainEqual(expect.stringContaining("PR:"));
    expect(consoleOutput.log).not.toContainEqual(expect.stringContaining("Branch:"));
    expect(sessionReads).toBe(1);
  });

  it("does not fail create --wait when the post-wait result fetch fails", async () => {
    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions")) {
        return Response.json({ sessionId: "ses_wait_result_fetch_fails" });
      }
      if (url.endsWith("/api/sessions/ses_wait_result_fetch_fails/prompts")) {
        if (init?.method === "POST") {
          return Response.json({ prompt: { promptId: "p-result-fetch-fails" } });
        }
        return Response.json({ prompts: [{ promptId: "p-result-fetch-fails", status: "completed", error: null }] });
      }
      if (url.includes("/api/sessions/ses_wait_result_fetch_fails/events?")) {
        return new Response(makeSse([{ event: "status", data: { phase: "completed" } }]));
      }
      if (url.endsWith("/api/sessions/ses_wait_result_fetch_fails")) {
        return new Response("temporary failure", { status: 503 });
      }
      return new Response("Not found", { status: 404 });
    });

    await expect(
      mod.createCommand("https://github.com/org/repo", "fix the bug", { wait: true, pollInterval: "250" }),
    ).resolves.toBeUndefined();

    expect(consoleOutput.log).toContain("Session: ses_wait_result_fetch_fails");
  });

  it("waits quietly in JSON mode and only emits the final create payload after success", async () => {
    let sessionReads = 0;

    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions")) {
        return Response.json({
          sessionId: "ses_wait_json",
          sessionUrl: "https://app.trycycloid.com/sessions/ses_wait_json",
        });
      }
      if (url.endsWith("/api/sessions/ses_wait_json/prompts")) {
        if (init?.method === "POST") {
          return Response.json({ prompt: { promptId: "p-9" } });
        }
        return Response.json({ prompts: [{ promptId: "p-9", status: "completed", error: null }] });
      }
      if (url.endsWith("/api/sessions/ses_wait_json")) {
        sessionReads++;
        return Response.json({ session: { phase: sessionReads === 1 ? "running" : "completed" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.createCommand("https://github.com/org/repo", "fix the bug", {
      wait: true,
      pollInterval: "250",
      json: true,
    });

    expect(consoleOutput.log).toHaveLength(0);
    const output = JSON.parse(stdoutWrites.join("")) as Record<string, unknown>;
    expect(output).toMatchObject({ sessionId: "ses_wait_json" });
    expect(output).not.toHaveProperty("prUrl");
    expect(output).not.toHaveProperty("publishedBranch");
    expect(output).not.toHaveProperty("lastBranch");
    expect(stdoutWrites.join("")).not.toContain("assistant>");
  });

  it("includes settled result fields in create --wait --json output when available", async () => {
    let sessionReads = 0;

    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions")) {
        return Response.json({
          sessionId: "ses_wait_json_pr",
          sessionUrl: "https://app.trycycloid.com/sessions/ses_wait_json_pr",
        });
      }
      if (url.endsWith("/api/sessions/ses_wait_json_pr/prompts")) {
        if (init?.method === "POST") {
          return Response.json({ prompt: { promptId: "p-pr-json" } });
        }
        return Response.json({ prompts: [{ promptId: "p-pr-json", status: "completed", error: null }] });
      }
      if (url.endsWith("/api/sessions/ses_wait_json_pr")) {
        sessionReads++;
        return Response.json({
          session: {
            phase: "completed",
            ...(sessionReads === 1
              ? { lastBranch: "agent/fix" }
              : sessionReads >= 2
                ? {
                    prUrl: "https://github.com/org/repo/pull/42",
                    publishedBranch: "agent/fix",
                    lastBranch: "agent/fix",
                  }
                : {}),
          },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.createCommand("https://github.com/org/repo", "fix the bug", {
      wait: true,
      pollInterval: "250",
      json: true,
    });

    expect(JSON.parse(stdoutWrites.join(""))).toMatchObject({
      sessionId: "ses_wait_json_pr",
      prUrl: "https://github.com/org/repo/pull/42",
      publishedBranch: "agent/fix",
      lastBranch: "agent/fix",
    });
  });

  it("keeps create --wait --json successful when the result fetch fails", async () => {
    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions")) {
        return Response.json({
          sessionId: "ses_wait_json_result_fetch_fails",
          sessionUrl: "https://app.trycycloid.com/sessions/ses_wait_json_result_fetch_fails",
        });
      }
      if (url.endsWith("/api/sessions/ses_wait_json_result_fetch_fails/prompts")) {
        if (init?.method === "POST") {
          return Response.json({ prompt: { promptId: "p-json-result-fetch-fails" } });
        }
        return Response.json({
          prompts: [{ promptId: "p-json-result-fetch-fails", status: "completed", error: null }],
        });
      }
      if (url.endsWith("/api/sessions/ses_wait_json_result_fetch_fails")) {
        return new Response("temporary failure", { status: 503 });
      }
      return new Response("Not found", { status: 404 });
    });

    await expect(
      mod.createCommand("https://github.com/org/repo", "fix the bug", {
        wait: true,
        pollInterval: "250",
        json: true,
      }),
    ).resolves.toBeUndefined();

    expect(JSON.parse(stdoutWrites.join(""))).toMatchObject({
      sessionId: "ses_wait_json_result_fetch_fails",
      repoUrl: "https://github.com/org/repo",
      promptId: "p-json-result-fetch-fails",
    });
  });

  it("JSON wait returns when the created prompt completes before the session becomes terminal", async () => {
    let promptReads = 0;
    let sessionReads = 0;

    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions")) {
        return Response.json({
          sessionId: "ses_wait_prompt_done",
          sessionUrl: "https://app.trycycloid.com/sessions/ses_wait_prompt_done",
        });
      }
      if (url.endsWith("/api/sessions/ses_wait_prompt_done/prompts")) {
        if (init?.method === "POST") {
          return Response.json({ prompt: { promptId: "p-done" } });
        }
        promptReads++;
        return Response.json({
          prompts: [
            {
              promptId: "p-done",
              status: promptReads === 1 ? "processing" : "completed",
              error: null,
            },
          ],
        });
      }
      if (url.endsWith("/api/sessions/ses_wait_prompt_done")) {
        sessionReads++;
        return Response.json({ session: { phase: "running" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.createCommand("https://github.com/org/repo", "fix the bug", {
      wait: true,
      pollInterval: "250",
      json: true,
    });

    expect(consoleOutput.log).toHaveLength(0);
    expect(stdoutWrites.join("")).toContain('"sessionId":"ses_wait_prompt_done"');
    expect(sessionReads).toBeGreaterThanOrEqual(1);
  });

  it("JSON wait re-fetches prompt status when the session becomes terminal after a processing read", async () => {
    let promptReads = 0;
    let sessionReads = 0;

    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions")) {
        return Response.json({
          sessionId: "ses_wait_prompt_race",
          sessionUrl: "https://app.trycycloid.com/sessions/ses_wait_prompt_race",
        });
      }
      if (url.endsWith("/api/sessions/ses_wait_prompt_race/prompts")) {
        if (init?.method === "POST") {
          return Response.json({ prompt: { promptId: "p-race" } });
        }
        promptReads++;
        return Response.json({
          prompts: [
            {
              promptId: "p-race",
              status: promptReads === 1 ? "processing" : "completed",
              error: null,
            },
          ],
        });
      }
      if (url.endsWith("/api/sessions/ses_wait_prompt_race")) {
        sessionReads++;
        return Response.json({ session: { phase: "completed" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.createCommand("https://github.com/org/repo", "fix the bug", {
      wait: true,
      pollInterval: "250",
      json: true,
    });

    expect(consoleOutput.log).toHaveLength(0);
    expect(stdoutWrites.join("")).toContain('"sessionId":"ses_wait_prompt_race"');
    expect(promptReads).toBe(2);
    expect(sessionReads).toBeGreaterThanOrEqual(1);
  });

  it("fails when the created prompt cannot be found in the final prompt list", async () => {
    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions")) {
        return Response.json({
          sessionId: "ses_wait_missing",
          sessionUrl: "https://app.trycycloid.com/sessions/ses_wait_missing",
        });
      }
      if (url.endsWith("/api/sessions/ses_wait_missing/prompts")) {
        if (init?.method === "POST") {
          return Response.json({ prompt: { promptId: "p-new" } });
        }
        return Response.json({ prompts: [{ promptId: "p-old", status: "completed", error: null }] });
      }
      if (url.endsWith("/api/sessions/ses_wait_missing")) {
        return Response.json({ session: { phase: "completed" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await expect(
      mod.createCommand("https://github.com/org/repo", "fix the bug", { wait: true, pollInterval: "250", json: true }),
    ).rejects.toMatchObject({
      exitCode: 10,
      message: "Prompt status was unavailable after session ses_wait_missing reached a terminal state.",
      hint: "Inspect with: cycloid sessions transcript ses_wait_missing",
    });
  });

  it("returns a non-zero CLI error when the waited prompt fails after the session stops", async () => {
    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions")) {
        return Response.json({
          sessionId: "ses_wait_fail",
          sessionUrl: "https://app.trycycloid.com/sessions/ses_wait_fail",
        });
      }
      if (url.endsWith("/api/sessions/ses_wait_fail/prompts")) {
        if (init?.method === "POST") {
          return Response.json({ prompt: { promptId: "p-fail" } });
        }
        return Response.json({ prompts: [{ promptId: "p-fail", status: "failed", error: "sandbox failed" }] });
      }
      if (url.endsWith("/api/sessions/ses_wait_fail")) {
        return Response.json({ session: { phase: "stopped" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await expect(
      mod.createCommand("https://github.com/org/repo", "fix the bug", { wait: true, pollInterval: "250", json: true }),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining("Prompt failed in session ses_wait_fail: sandbox failed"),
      hint: "Inspect with: cycloid sessions transcript ses_wait_fail",
    });
  });

  it("rejects malformed pollInterval before creating a session", async () => {
    let fetchCalled = false;
    stubFetch(() => {
      fetchCalled = true;
      return Response.json({});
    });

    await expect(
      mod.createCommand("https://github.com/org/repo", "fix the bug", { wait: true, pollInterval: "oops" }),
    ).rejects.toThrow("Polling interval must be a non-negative integer");

    expect(fetchCalled).toBe(false);
  });

  it("rejects out-of-range pollInterval before creating a session", async () => {
    let fetchCalled = false;
    stubFetch(() => {
      fetchCalled = true;
      return Response.json({});
    });

    await expect(
      mod.createCommand("https://github.com/org/repo", "fix the bug", { wait: true, pollInterval: "0" }),
    ).rejects.toThrow("Polling interval must be between 250 and 60000 milliseconds");
    await expect(
      mod.createCommand("https://github.com/org/repo", "fix the bug", { wait: true, pollInterval: "60001" }),
    ).rejects.toThrow("Polling interval must be between 250 and 60000 milliseconds");

    expect(fetchCalled).toBe(false);
  });
});

// ===========================================================================
// qaCommand
// ===========================================================================

describe("qaCommand", () => {
  let mod: QaModule;

  beforeEach(async () => {
    const modulePath: string = "../../apps/cli/src/commands/qa";
    mod = (await import(modulePath)) as unknown as QaModule;
  });

  it("creates a QA session and enqueues the verifier prompt", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stubFetch((url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/api/sessions")) {
        return Response.json({ sessionId: "ses_qa", sessionUrl: "https://app.trycycloid.com/sessions/ses_qa" });
      }
      if (url.endsWith("/api/sessions/ses_qa/prompts")) {
        return Response.json({ prompt: { promptId: "p-qa" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.qaCommand(" https://github.com/org/repo/pull/123?ignored=true ", {
      idempotencyKey: "idem-1",
      json: true,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://app.trycycloid.com/api/sessions");
    expect(new Headers(calls[0]?.init?.headers).get("Idempotency-Key")).toBe("idem-1:session");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      context: { repoUrl: "https://github.com/org/repo" },
      qa: true,
      targetPrUrl: "https://github.com/org/repo/pull/123",
    });
    expect(calls[1]?.url).toBe("https://app.trycycloid.com/api/sessions/ses_qa/prompts");
    expect(new Headers(calls[1]?.init?.headers).get("Idempotency-Key")).toBe("idem-1:prompt");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ prompt: "Verify this pull request." });
    expect(JSON.parse(stdoutWrites.join(""))).toMatchObject({
      sessionId: "ses_qa",
      sessionUrl: "https://app.trycycloid.com/sessions/ses_qa",
      repoUrl: "https://github.com/org/repo",
      targetPrUrl: "https://github.com/org/repo/pull/123",
      promptId: "p-qa",
    });
  });

  it("waits for coordinator-enqueued QA prompts without posting a duplicate prompt", async () => {
    const calls: { url: string; method: string }[] = [];
    let promptReads = 0;
    stubFetch((url, init) => {
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.endsWith("/api/sessions")) {
        return Response.json({
          sessionId: "ses_qa_wait",
          sessionUrl: "https://app.trycycloid.com/sessions/ses_qa_wait",
          promptAlreadyEnqueued: true,
        });
      }
      if (url.endsWith("/api/sessions/ses_qa_wait/prompts")) {
        promptReads++;
        return Response.json({
          prompts: [
            {
              promptId: "p-coordinated",
              status: promptReads === 1 ? "processing" : "completed",
              error: null,
            },
          ],
        });
      }
      if (url.endsWith("/api/sessions/ses_qa_wait")) {
        return Response.json({ session: { phase: "running" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.qaCommand("https://github.com/org/repo/pull/123", {
      wait: true,
      pollInterval: "250",
      json: true,
    });

    expect(calls).not.toContainEqual({
      url: "https://app.trycycloid.com/api/sessions/ses_qa_wait/prompts",
      method: "POST",
    });
    expect(promptReads).toBe(2);
    expect(JSON.parse(stdoutWrites.join(""))).toMatchObject({
      sessionId: "ses_qa_wait",
      targetPrUrl: "https://github.com/org/repo/pull/123",
    });
  });

  it("rejects non-PR URLs before making any API call", async () => {
    let fetchCalled = false;
    stubFetch(() => {
      fetchCalled = true;
      return Response.json({});
    });

    await expect(mod.qaCommand("https://github.com/org/repo/issues/123", {})).rejects.toThrow(
      "Invalid pull request URL",
    );
    await expect(mod.qaCommand("https://github.com/org/repo", {})).rejects.toThrow("Invalid pull request URL");
    await expect(mod.qaCommand("https://example.com/org/repo/pull/123", {})).rejects.toThrow(
      "Invalid pull request URL",
    );
    await expect(mod.qaCommand("not a url", {})).rejects.toThrow("Invalid pull request URL");
    expect(fetchCalled).toBe(false);
  });

  it("sends model, backend, and reasoning effort when provided", async () => {
    let createBody: Record<string, unknown> | undefined;
    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions")) {
        createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ sessionId: "ses_qa_model" });
      }
      if (url.endsWith("/api/sessions/ses_qa_model/prompts")) {
        return Response.json({ prompt: { promptId: "p-qa-model" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.qaCommand("https://github.com/org/repo/pull/123", {
      backend: "claude_code",
      model: "claude-opus-4-8",
      reasoningEffort: "high",
      json: true,
    });

    expect(createBody).toMatchObject({
      agentRuntimeBackend: "claude_code",
      model: "claude-opus-4-8",
      reasoningEffort: "high",
    });
    expect(JSON.parse(stdoutWrites.join(""))).toMatchObject({
      agentRuntimeBackend: "claude_code",
      model: "claude-opus-4-8",
      reasoningEffort: "high",
    });
  });

  it("rejects a model that is not selectable for the backend before any network call", async () => {
    let fetchCalled = false;
    stubFetch(() => {
      fetchCalled = true;
      return Response.json({});
    });

    await expect(
      mod.qaCommand("https://github.com/org/repo/pull/123", { backend: "claude_code", model: "gpt-5.5" }),
    ).rejects.toThrow(/not selectable for backend 'claude_code'/);
    expect(fetchCalled).toBe(false);
  });

  it("surfaces active-verifier conflicts with the existing session", async () => {
    stubFetch(() =>
      Response.json(
        {
          error: { code: "verification_in_progress", message: "A verifier is already running for this PR." },
          sessionId: "ses_existing",
          sessionUrl: "https://app.trycycloid.com/sessions/ses_existing",
        },
        { status: 409 },
      ),
    );

    await expect(mod.qaCommand("https://github.com/org/repo/pull/123", {})).rejects.toMatchObject({
      exitCode: 4,
      message: expect.stringContaining("ses_existing"),
    });
  });

  it("maps per-PR run-limit conflicts to exit code 4", async () => {
    stubFetch(() =>
      Response.json(
        { error: { code: "run_limit_exceeded", message: "QA run limit reached for this pull request." } },
        { status: 409 },
      ),
    );

    await expect(mod.qaCommand("https://github.com/org/repo/pull/123", {})).rejects.toMatchObject({
      exitCode: 4,
      message: "QA run limit reached for this pull request.",
    });
  });

  it("handles partial failure: QA session created but prompt enqueue fails", async () => {
    stubFetch((url) => {
      if (url.endsWith("/api/sessions")) {
        return Response.json({
          sessionId: "ses_qa_partial",
          sessionUrl: "https://app.trycycloid.com/sessions/ses_qa_partial",
        });
      }
      if (url.endsWith("/api/sessions/ses_qa_partial/prompts")) {
        return new Response("Internal Server Error", {
          status: 500,
          headers: { "x-request-id": "req_qa_partial" },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    await expect(mod.qaCommand("https://github.com/org/repo/pull/123", {})).rejects.toMatchObject({
      exitCode: 10,
      message: expect.stringContaining("prompt enqueue failed"),
      requestId: "req_qa_partial",
      data: {
        sessionId: "ses_qa_partial",
        sessionUrl: "https://app.trycycloid.com/sessions/ses_qa_partial",
      },
    });

    expect(exitCode).toBeUndefined();
  });

  it("blocks nested QA sessions from verification sessions before any API call", async () => {
    const previousRole = process.env.ARCANIST_AGENT_ROLE;
    process.env.ARCANIST_AGENT_ROLE = "verification";
    let fetchCalled = false;
    stubFetch(() => {
      fetchCalled = true;
      return Response.json({});
    });

    try {
      await expect(mod.qaCommand("https://github.com/org/repo/pull/123", {})).rejects.toThrow(
        "`cycloid sessions qa` is disabled inside verification sessions",
      );
    } finally {
      if (previousRole === undefined) delete process.env.ARCANIST_AGENT_ROLE;
      else process.env.ARCANIST_AGENT_ROLE = previousRole;
    }

    expect(fetchCalled).toBe(false);
  });
});

// ===========================================================================
// messageCommand
// ===========================================================================

type MessageModule = {
  messageCommand: (
    sessionId: string,
    prompt: string,
    options?: { uploadedFile?: string | string[]; wait?: boolean; pollInterval?: string; json?: boolean },
  ) => Promise<void>;
};

describe("messageCommand", () => {
  let mod: MessageModule;

  beforeEach(async () => {
    const modulePath: string = "../../apps/cli/src/commands/message";
    mod = (await import(modulePath)) as unknown as MessageModule;
  });

  it("prints success message on successful send", async () => {
    stubFetch(() => Response.json({ ok: true }));

    await mod.messageCommand("ses_abc", "hello world");

    expect(consoleOutput.log).toContainEqual(expect.stringContaining("Message sent"));
    expect(consoleOutput.log).toContainEqual(expect.stringContaining("ses_abc"));
  });

  it("exits with error when not logged in", async () => {
    configOverride = null;

    await expect(mod.messageCommand("ses_abc", "test")).rejects.toThrow("process.exit(1)");
    expect(exitCode).toBe(1);
    expect(consoleOutput.error).toContainEqual(expect.stringContaining("Not logged in"));
  });

  it("prints user-friendly error on API failure", async () => {
    stubFetch(() => new Response("Bad Request", { status: 400 }));

    await expect(mod.messageCommand("ses_abc", "test")).rejects.toThrow("API error 400");

    expect(exitCode).toBeUndefined();
  });

  it("blocks nested prompt sends from verification sessions before any API call", async () => {
    const previousRole = process.env.ARCANIST_AGENT_ROLE;
    process.env.ARCANIST_AGENT_ROLE = "verification";
    let fetchCalled = false;
    stubFetch(() => {
      fetchCalled = true;
      return Response.json({ ok: true });
    });

    try {
      await expect(mod.messageCommand("ses_abc", "test")).rejects.toThrow("disabled inside verification sessions");
    } finally {
      if (previousRole === undefined) delete process.env.ARCANIST_AGENT_ROLE;
      else process.env.ARCANIST_AGENT_ROLE = previousRole;
    }

    expect(fetchCalled).toBe(false);
  });

  it("prints auth error on 401", async () => {
    stubFetch(() => new Response("Unauthorized", { status: 401 }));

    await expect(mod.messageCommand("ses_abc", "test")).rejects.toThrow("API error 401");

    expect(exitCode).toBeUndefined();
  });

  it("sends uploaded files with follow-up prompts", async () => {
    const firstUpload = await writeTempUpload("first.txt", "first file");
    const secondUpload = await writeTempUpload("second.txt", "second file");
    let promptBody: Record<string, unknown> | undefined;

    stubFetch((_url, init) => {
      promptBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ prompt: { promptId: "p-followup" } });
    });

    await mod.messageCommand("ses_abc", "use these files", { uploadedFile: [firstUpload, secondUpload] });

    expect(promptBody).toMatchObject({
      prompt: "use these files",
      uploadedFiles: [
        { name: "first.txt", content: "first file" },
        { name: "second.txt", content: "second file" },
      ],
    });
  });

  it("waits for a sent prompt and prints best-effort result fields in JSON mode", async () => {
    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions/ses_abc/prompts")) {
        if (init?.method === "POST") {
          return Response.json({ prompt: { promptId: "p-followup" } });
        }
        return Response.json({ prompts: [{ promptId: "p-followup", status: "completed", error: null }] });
      }
      if (url.endsWith("/api/sessions/ses_abc")) {
        return Response.json({
          session: {
            phase: "completed",
            prUrl: "https://github.com/org/repo/pull/42",
            publishedBranch: "agent/fix",
            lastBranch: "agent/fix",
          },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.messageCommand("ses_abc", "continue", { wait: true, pollInterval: "250", json: true });

    expect(JSON.parse(stdoutWrites.join(""))).toMatchObject({
      sessionId: "ses_abc",
      promptId: "p-followup",
      prUrl: "https://github.com/org/repo/pull/42",
      publishedBranch: "agent/fix",
      lastBranch: "agent/fix",
    });
    expect(consoleOutput.log).toHaveLength(0);
  });

  it("returns a non-zero CLI error when a sent prompt fails in wait mode", async () => {
    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions/ses_abc/prompts")) {
        if (init?.method === "POST") {
          return Response.json({ prompt: { promptId: "p-followup" } });
        }
        return Response.json({ prompts: [{ promptId: "p-followup", status: "failed", error: "tests failed" }] });
      }
      if (url.endsWith("/api/sessions/ses_abc")) {
        return Response.json({ session: { phase: "completed" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await expect(
      mod.messageCommand("ses_abc", "continue", { wait: true, pollInterval: "250", json: true }),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining("Prompt failed in session ses_abc: tests failed"),
      hint: "Inspect with: cycloid sessions transcript ses_abc",
    });
  });

  it("prints the PR line after sessions send --wait in human mode", async () => {
    stubFetch((url, init) => {
      if (url.endsWith("/api/sessions/ses_abc/prompts")) {
        if (init?.method === "POST") {
          return Response.json({ prompt: { promptId: "p-followup" } });
        }
        return Response.json({ prompts: [{ promptId: "p-followup", status: "completed", error: null }] });
      }
      if (url.includes("/api/sessions/ses_abc/events?")) {
        return new Response(
          makeSse([
            { event: "status", data: { phase: "completed" } },
            { event: "prompt_completed", id: 2, data: { promptId: "p-followup" } },
          ]),
        );
      }
      if (url.endsWith("/api/sessions/ses_abc")) {
        return Response.json({
          session: {
            phase: "completed",
            prUrl: "https://github.com/org/repo/pull/42",
            publishedBranch: "agent/followup",
            baseBranch: "main",
          },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.messageCommand("ses_abc", "continue", { wait: true, pollInterval: "250" });

    expect(consoleOutput.log).toContainEqual(expect.stringContaining("[prompt] p-followup completed"));
    expect(consoleOutput.log).toContain("PR: https://github.com/org/repo/pull/42 (agent/followup)");
  });
});

// ===========================================================================
// respondCommand
// ===========================================================================

type RespondModule = {
  respondCommand: (
    sessionId: string,
    answer: string | undefined,
    options?: { answerStdin?: boolean; questionId?: string; json?: boolean },
  ) => Promise<void>;
};

describe("respondCommand", () => {
  let mod: RespondModule;

  beforeEach(async () => {
    const modulePath: string = "../../apps/cli/src/commands/respond";
    mod = (await import(modulePath)) as unknown as RespondModule;
  });

  it("posts answers and question IDs", async () => {
    let body: Record<string, unknown> | undefined;
    stubFetch((_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ ok: true });
    });

    await mod.respondCommand("ses_abc", "Use PostgreSQL", { questionId: "q-1", json: true });

    expect(body).toEqual({ answer: "Use PostgreSQL", questionId: "q-1" });
    expect(JSON.parse(stdoutWrites.join(""))).toEqual({ sessionId: "ses_abc", ok: true });
  });

  it("maps phase-gate respond conflicts to actionable conflict errors", async () => {
    stubFetch(() => Response.json({ ok: false, error: "session_not_respondable", reason: "running" }, { status: 409 }));

    await expect(
      mod.respondCommand("ses_abc", "Use PostgreSQL", { questionId: "q-1", json: true }),
    ).rejects.toMatchObject({
      exitCode: 4,
      message: "Session cannot be answered from phase=running.",
      hint: "Inspect pending questions with: cycloid sessions events ses_abc --follow --json",
      data: { reason: "running" },
    });
  });

  it("maps stale pending-question conflicts to actionable conflict errors", async () => {
    stubFetch(() => Response.json({ ok: false, error: "session_not_respondable" }, { status: 409 }));

    await expect(
      mod.respondCommand("ses_abc", "Use PostgreSQL", { questionId: "q-1", json: true }),
    ).rejects.toMatchObject({
      exitCode: 4,
      message: "Session does not have a pending question.",
      hint: "Inspect pending questions with: cycloid sessions events ses_abc --follow --json",
      data: { reason: "session_not_respondable" },
    });
  });

  it("requires question ids for durable answers", async () => {
    let fetchCalled = false;
    stubFetch(() => {
      fetchCalled = true;
      return Response.json({ ok: true });
    });

    await expect(mod.respondCommand("ses_abc", "Use PostgreSQL", { json: true })).rejects.toMatchObject({
      exitCode: 1,
      message: "Missing --question-id for the pending question.",
      hint: "Find the question id with: cycloid sessions events ses_abc --follow --json",
    });
    expect(fetchCalled).toBe(false);
  });
});

// ===========================================================================
// discoverability commands
// ===========================================================================

type ReposModule = {
  reposListCommand: (options?: { json?: boolean }) => Promise<void>;
  repoBranchesCommand: (repo: string | undefined, options?: { json?: boolean }) => Promise<void>;
  repoSkillsCommand: (repo: string | undefined, options?: { json?: boolean }) => Promise<void>;
};

type ModelsModule = {
  modelsListCommand: (options?: { json?: boolean }) => Promise<void>;
};

describe("discoverability commands", () => {
  it("lists repos with SSO orgs in a stable JSON envelope", async () => {
    const mod = (await import("../../apps/cli/src/commands/repos")) as unknown as ReposModule;
    stubFetch(() =>
      Response.json({
        repos: [{ fullName: "org/repo", defaultBranch: "main" }],
        ssoOrgs: [{ id: 1, login: "acme" }],
      }),
    );

    await mod.reposListCommand({ json: true });

    expect(JSON.parse(stdoutWrites.join(""))).toEqual({
      repos: [{ fullName: "org/repo", defaultBranch: "main" }],
      ssoOrgs: [{ id: 1, login: "acme" }],
    });
  });

  it("lists repo branches and skills from owner/name args", async () => {
    const mod = (await import("../../apps/cli/src/commands/repos")) as unknown as ReposModule;
    const urls: string[] = [];
    stubFetch((url) => {
      urls.push(url);
      if (url.endsWith("/api/repos")) return Response.json({ repos: [], ssoOrgs: [] });
      if (url.endsWith("/branches")) return Response.json({ branches: [{ name: "main" }] });
      return Response.json({ skills: [{ name: "test", description: "Run tests", path: ".agents/skills/test" }] });
    });

    await mod.repoBranchesCommand("org/repo", { json: true });
    await mod.repoSkillsCommand("https://github.com/org/repo", { json: true });

    expect(urls).toEqual([
      "https://app.trycycloid.com/api/repos",
      "https://app.trycycloid.com/api/repos/org/repo/branches",
      "https://app.trycycloid.com/api/repos/org/repo/skills",
    ]);
  });

  it("renders repo branch and skill text output without object placeholders", async () => {
    const mod = (await import("../../apps/cli/src/commands/repos")) as unknown as ReposModule;
    stubFetch((url) => {
      if (url.endsWith("/api/repos")) return Response.json({ repos: [], ssoOrgs: [] });
      if (url.endsWith("/branches")) return Response.json({ branches: [{ branch: "develop" }, {}] });
      return Response.json({ skills: [{ description: "No name" }, { name: "test", description: "Run tests" }] });
    });

    await mod.repoBranchesCommand("org/repo");
    await mod.repoSkillsCommand("org/repo");

    expect(consoleOutput.log).toEqual(["develop", "", "\tNo name", "test\tRun tests"]);
  });

  it("flattens model provider groups and marks backend defaults", async () => {
    const mod = (await import("../../apps/cli/src/commands/models")) as unknown as ModelsModule;
    stubFetch(() =>
      Response.json([
        { id: "openai", models: [{ id: "gpt-5.4", name: "GPT", label: "GPT", backends: ["codex"] }] },
        {
          id: "anthropic",
          models: [{ id: "claude-opus-4-8", name: "Claude", label: "Claude", backends: ["claude_code"] }],
        },
      ]),
    );

    await mod.modelsListCommand({ json: true });

    expect(JSON.parse(stdoutWrites.join(""))).toEqual({
      models: [
        {
          id: "gpt-5.4",
          name: "GPT",
          label: "GPT",
          backend: "openai",
          provider: "openai",
          backends: ["codex"],
          default: true,
        },
        {
          id: "claude-opus-4-8",
          name: "Claude",
          label: "Claude",
          backend: "anthropic",
          provider: "anthropic",
          backends: ["claude_code"],
          default: true,
        },
      ],
    });
  });
});

// ===========================================================================
// stopCommand
// ===========================================================================

type StopModule = {
  stopCommand: (sessionId: string, options?: { json?: boolean }) => Promise<void>;
};

describe("stopCommand", () => {
  let mod: StopModule;

  beforeEach(async () => {
    const modulePath: string = "../../apps/cli/src/commands/stop";
    mod = (await import(modulePath)) as unknown as StopModule;
  });

  it("requests a stop and prints success", async () => {
    stubFetch(() => Response.json({ ok: true, status: "stopping" }));

    await mod.stopCommand("ses_stop");

    expect(consoleOutput.log).toContainEqual(expect.stringContaining("Stop requested"));
    expect(consoleOutput.log).toContainEqual(expect.stringContaining("ses_stop"));
  });

  it("preserves server stop status in JSON output", async () => {
    stubFetch(() => Response.json({ ok: true, status: "stopping" }));

    await mod.stopCommand("ses_stop", { json: true });

    expect(stdoutWrites.join("")).toContain('"status":"stopping"');
  });

  it("preserves a non-already-stopped 409 stop-block reason in JSON output", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: "session_not_stoppable", reason: "waiting_for_input" }), {
          status: 409,
        }),
    );

    await mod.stopCommand("ses_stop", { json: true });

    expect(JSON.parse(stdoutWrites.join(""))).toEqual({ sessionId: "ses_stop", status: "waiting_for_input" });
  });

  it("prints an error on API failure", async () => {
    stubFetch(() => new Response("Conflict", { status: 409 }));

    await expect(mod.stopCommand("ses_stop")).rejects.toThrow("API error 409");

    expect(exitCode).toBeUndefined();
  });
});

// ===========================================================================
// list/search session commands
// ===========================================================================

type SessionListModule = {
  listSessionsCommand: (options: {
    status?: string;
    scope?: "business" | "mine";
    search?: string;
    tag?: string;
    repo?: string;
    limit?: string;
    cursor?: string;
    all?: boolean;
    json?: boolean;
  }) => Promise<void>;
  searchSessionsCommand: (
    query: string,
    options: {
      status?: string;
      scope?: "business" | "mine";
      tag?: string;
      repo?: string;
      limit?: string;
      cursor?: string;
      all?: boolean;
      json?: boolean;
    },
  ) => Promise<void>;
};

describe("session list/search commands", () => {
  let mod: SessionListModule;

  beforeEach(async () => {
    const modulePath: string = "../../apps/cli/src/commands/sessions";
    mod = (await import(modulePath)) as unknown as SessionListModule;
  });

  it("passes metadata search filters and renders sessions", async () => {
    let requestedUrl = "";
    stubFetch((url) => {
      requestedUrl = url;
      return Response.json({
        sessions: [
          {
            sessionId: "ses_search",
            status: "idle",
            title: "Architect agent search",
          },
        ],
        nextCursor: null,
      });
    });

    await mod.listSessionsCommand({
      search: "architect agent",
      repo: "trycycloid/cycloid",
      limit: "20",
    });

    const parsed = new URL(requestedUrl);
    expect(parsed.pathname).toBe("/api/sessions");
    expect(parsed.searchParams.get("q")).toBe("architect agent");
    expect(parsed.searchParams.get("repo")).toBe("trycycloid/cycloid");
    expect(parsed.searchParams.get("limit")).toBe("20");
    expect(consoleOutput.log).toContain("ses_search\tidle Architect agent search");
  });

  it("implements sessions search as a list search alias", async () => {
    let requestedUrl = "";
    stubFetch((url) => {
      requestedUrl = url;
      return Response.json({ sessions: [], nextCursor: null });
    });

    await mod.searchSessionsCommand("architect agent", {
      repo: "trycycloid/cycloid",
      json: true,
    });

    const parsed = new URL(requestedUrl);
    expect(parsed.pathname).toBe("/api/sessions");
    expect(parsed.searchParams.get("q")).toBe("architect agent");
    expect(parsed.searchParams.get("repo")).toBe("trycycloid/cycloid");
    expect(JSON.parse(stdoutWrites.join(""))).toEqual({ sessions: [], nextCursor: null });
  });

  it("fetches all session pages when --all is requested", async () => {
    const requestedUrls: string[] = [];
    stubFetch((url) => {
      requestedUrls.push(url);
      const parsed = new URL(url);
      if (parsed.searchParams.get("cursor") === "cursor_2") {
        return Response.json({
          sessions: [{ sessionId: "ses_2", status: "completed" }],
          nextCursor: null,
        });
      }
      return Response.json({
        sessions: [{ sessionId: "ses_1", status: "idle" }],
        nextCursor: "cursor_2",
      });
    });

    await mod.listSessionsCommand({ limit: "1", all: true, json: true });

    expect(requestedUrls).toHaveLength(2);
    expect(new URL(requestedUrls[0]).searchParams.get("cursor")).toBeNull();
    expect(new URL(requestedUrls[1]).searchParams.get("cursor")).toBe("cursor_2");
    expect(JSON.parse(stdoutWrites.join(""))).toEqual({
      sessions: [
        { sessionId: "ses_1", status: "idle" },
        { sessionId: "ses_2", status: "completed" },
      ],
      nextCursor: null,
    });
  });

  it("stops sessions --all when pagination does not terminate", async () => {
    let requestCount = 0;
    stubFetch(() => {
      requestCount += 1;
      return Response.json({
        sessions: [{ sessionId: `ses_${requestCount}`, status: "idle" }],
        nextCursor: `cursor_${requestCount + 1}`,
      });
    });

    await expect(mod.listSessionsCommand({ all: true, json: true })).rejects.toThrow(
      "sessions list --all exceeded 1000 pages",
    );
    expect(requestCount).toBe(1000);
  });
});

// ===========================================================================
// automation commands
// ===========================================================================

type AutomationsModule = {
  createAutomationCommand: (
    repoUrl: string,
    prompt: string | undefined,
    options: { cron: string; name?: string; model?: string; promptStdin?: boolean; json?: boolean },
  ) => Promise<void>;
  listAutomationsCommand: (options: {
    limit?: string;
    cursor?: string;
    all?: boolean;
    json?: boolean;
  }) => Promise<void>;
  deleteAutomationCommand: (id: string, options: { yes?: boolean; json?: boolean }) => Promise<void>;
};

describe("automation commands", () => {
  let mod: AutomationsModule;

  beforeEach(async () => {
    const modulePath: string = "../../apps/cli/src/commands/automations";
    mod = (await import(modulePath)) as unknown as AutomationsModule;
  });

  it("creates an automation with repo split, cron, prompt, and name", async () => {
    let requestBody: Record<string, unknown> | undefined;
    stubFetch((_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json(
        {
          ok: true,
          data: {
            id: "rule-1",
            repoOwner: "trycycloid",
            repoName: "cycloid",
            normalizedCron: "*/15 * * * *",
            enabled: true,
            nextFireAt: Date.UTC(2026, 5, 24, 21, 0, 0),
          },
        },
        { status: 201 },
      );
    });

    await mod.createAutomationCommand("https://github.com/trycycloid/cycloid", "summarize regressions", {
      cron: "*/15 * * * *",
      name: "Regression summary",
    });

    expect(requestBody).toEqual({
      repoOwner: "trycycloid",
      repoName: "cycloid",
      cron: "*/15 * * * *",
      prompt: "summarize regressions",
      name: "Regression summary",
    });
    expect(consoleOutput.log).toContain("ID: rule-1");
    expect(consoleOutput.log).toContain("Repo: trycycloid/cycloid");
    expect(consoleOutput.log).toContain("Cron: */15 * * * *");
    expect(consoleOutput.log).toContain("Next fire: 2026-06-24T21:00:00.000Z");
  });

  it("pins an opencode model without sending a backend field", async () => {
    let requestBody: Record<string, unknown> | undefined;
    stubFetch((_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        ok: true,
        data: {
          id: "rule-glm",
          repoOwner: "trycycloid",
          repoName: "cycloid",
          normalizedCron: "0 13 * * 5",
          enabled: true,
          nextFireAt: null,
          modelId: "kimi-k2.7-code",
        },
      });
    });

    await mod.createAutomationCommand("trycycloid/cycloid", "audit N+1s", {
      cron: "0 13 * * 5",
      model: "kimi-k2.7-code",
    });

    expect(requestBody).toMatchObject({ modelId: "kimi-k2.7-code" });
    expect(requestBody).not.toHaveProperty("backend");
    expect(requestBody).not.toHaveProperty("agentRuntimeBackend");
    expect(consoleOutput.log).toContain("Model: kimi-k2.7-code");
  });

  it("pins a Claude model without requiring a backend flag", async () => {
    let requestBody: Record<string, unknown> | undefined;
    stubFetch((_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        ok: true,
        data: {
          id: "rule-claude",
          repoOwner: "trycycloid",
          repoName: "cycloid",
          normalizedCron: "0 13 * * 5",
          enabled: true,
          nextFireAt: null,
          modelId: "claude-opus-4-8",
        },
      });
    });

    await mod.createAutomationCommand("trycycloid/cycloid", "audit N+1s", {
      cron: "0 13 * * 5",
      model: "claude-opus-4-8",
    });

    expect(requestBody).toMatchObject({ modelId: "claude-opus-4-8" });
    expect(requestBody).not.toHaveProperty("backend");
    expect(requestBody).not.toHaveProperty("agentRuntimeBackend");
  });

  it("normalizes provider-qualified automation models before sending", async () => {
    let requestBody: Record<string, unknown> | undefined;
    stubFetch((_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        ok: true,
        data: {
          id: "rule-qualified",
          repoOwner: "trycycloid",
          repoName: "cycloid",
          normalizedCron: "0 13 * * 5",
          enabled: true,
          nextFireAt: null,
          modelId: "claude-opus-4-8",
        },
      });
    });

    await mod.createAutomationCommand("trycycloid/cycloid", "audit N+1s", {
      cron: "0 13 * * 5",
      model: "anthropic/claude-opus-4-8",
    });

    expect(requestBody).toMatchObject({ modelId: "claude-opus-4-8" });
    expect(requestBody).not.toHaveProperty("backend");
    expect(requestBody).not.toHaveProperty("agentRuntimeBackend");
  });

  it("rejects invalid automation models before calling the API", async () => {
    let fetchCalled = false;
    stubFetch(() => {
      fetchCalled = true;
      return Response.json({});
    });

    await expect(
      mod.createAutomationCommand("trycycloid/cycloid", "audit N+1s", {
        cron: "0 13 * * 5",
        model: "gpt-4o",
      }),
    ).rejects.toThrow("Model 'gpt-4o' is not selectable");

    expect(fetchCalled).toBe(false);
  });

  it("uses the provider-qualified backend for invalid automation model hints", async () => {
    let fetchCalled = false;
    stubFetch(() => {
      fetchCalled = true;
      return Response.json({});
    });

    await expect(
      mod.createAutomationCommand("trycycloid/cycloid", "audit N+1s", {
        cron: "0 13 * * 5",
        model: "anthropic/claude-opus-5-0",
      }),
    ).rejects.toThrow("Allowed: claude-opus-4-8, claude-sonnet-4-6, claude-sonnet-5, claude-fable-5.");

    expect(fetchCalled).toBe(false);
  });

  it("reads create prompt from stdin and prints the rule as JSON", async () => {
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* (): AsyncGenerator<
      Buffer,
      undefined,
      unknown
    > {
      yield Buffer.from("  keep whitespace\n\n");
      return undefined;
    });
    let requestBody: Record<string, unknown> | undefined;
    stubFetch((_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        ok: true,
        data: {
          id: "rule-json",
          repoOwner: "trycycloid",
          repoName: "cycloid",
          normalizedCron: "0 14 * * 1,2,3,4,5",
          enabled: true,
          nextFireAt: null,
        },
      });
    });

    await mod.createAutomationCommand("trycycloid/cycloid", undefined, {
      cron: "0 14 * * 1-5",
      promptStdin: true,
      json: true,
    });

    expect(requestBody?.prompt).toBe("  keep whitespace\n\n");
    expect(JSON.parse(stdoutWrites.join(""))).toMatchObject({ id: "rule-json", repoOwner: "trycycloid" });
    expect(consoleOutput.log).toHaveLength(0);
  });

  it("rejects non-GitHub SSH repos before calling the API", async () => {
    let fetchCalled = false;
    stubFetch(() => {
      fetchCalled = true;
      return Response.json({});
    });

    await expect(
      mod.createAutomationCommand("git@example.com:org/repo.git", "prompt", { cron: "*/15 * * * *" }),
    ).rejects.toThrow("repo-url must be owner/name or a GitHub URL");

    expect(fetchCalled).toBe(false);
  });

  it("maps automation API messages and hints", async () => {
    stubFetch(() =>
      Response.json(
        { ok: false, error: "rule_cap_reached", message: "Maximum enabled scheduled automations reached." },
        { status: 409 },
      ),
    );

    await expect(
      mod.createAutomationCommand("trycycloid/cycloid", "prompt", { cron: "*/15 * * * *" }),
    ).rejects.toMatchObject({
      exitCode: 4,
      message: "Maximum enabled scheduled automations reached.",
      hint: expect.stringContaining("20 enabled rules"),
    });
  });

  it("maps invalid automation model API errors to a hint", async () => {
    stubFetch(() => Response.json({ ok: false, error: "invalid_model", message: "Invalid model." }, { status: 400 }));

    await expect(
      mod.createAutomationCommand("trycycloid/cycloid", "prompt", { cron: "*/15 * * * *" }),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: "Invalid model.",
      hint: expect.stringContaining("not selectable"),
    });
  });

  it("maps unavailable automation model API errors to a hint", async () => {
    stubFetch(() =>
      Response.json({ ok: false, error: "model_not_available", message: "Model not available." }, { status: 403 }),
    );

    await expect(
      mod.createAutomationCommand("trycycloid/cycloid", "prompt", { cron: "*/15 * * * *" }),
    ).rejects.toMatchObject({
      exitCode: 2,
      message: "Model not available.",
      hint: expect.stringContaining("limited to Cycloid team businesses"),
    });
  });

  it("lists one page by default with pagination query params", async () => {
    let requestedUrl = "";
    stubFetch((url) => {
      requestedUrl = url;
      return Response.json({
        ok: true,
        data: {
          items: [
            {
              id: "rule-1",
              repoOwner: "trycycloid",
              repoName: "cycloid",
              normalizedCron: "*/15 * * * *",
              enabled: true,
              nextFireAt: 1782334800000,
            },
          ],
          nextCursor: "cursor-2",
        },
      });
    });

    await mod.listAutomationsCommand({ limit: "20", cursor: "cursor-1" });

    const parsed = new URL(requestedUrl);
    expect(parsed.pathname).toBe("/api/automation/schedules");
    expect(parsed.searchParams.get("limit")).toBe("20");
    expect(parsed.searchParams.get("cursor")).toBe("cursor-1");
    expect(consoleOutput.log).toContain("rule-1\ttrycycloid/cycloid\t*/15 * * * *\ttrue\t2026-06-24T21:00:00.000Z");
    expect(consoleOutput.log).toContain("Next cursor: cursor-2");
  });

  it("follows pagination with --all and prints aggregated JSON", async () => {
    const requestedUrls: string[] = [];
    stubFetch((url) => {
      requestedUrls.push(url);
      const cursor = new URL(url).searchParams.get("cursor");
      return Response.json({
        ok: true,
        data: {
          items: [
            {
              id: cursor ? "rule-2" : "rule-1",
              repoOwner: "trycycloid",
              repoName: "cycloid",
              normalizedCron: "*/15 * * * *",
              enabled: true,
              nextFireAt: null,
            },
          ],
          nextCursor: cursor ? null : "cursor-2",
        },
      });
    });

    await mod.listAutomationsCommand({ all: true, json: true });

    expect(requestedUrls).toHaveLength(2);
    expect(new URL(requestedUrls[1]).searchParams.get("cursor")).toBe("cursor-2");
    expect(JSON.parse(stdoutWrites.join(""))).toEqual({
      items: [expect.objectContaining({ id: "rule-1" }), expect.objectContaining({ id: "rule-2" })],
      nextCursor: null,
    });
  });

  it("stops automations list --all when pagination does not terminate", async () => {
    let requestCount = 0;
    stubFetch(() => {
      requestCount += 1;
      return Response.json({
        ok: true,
        data: {
          items: [],
          nextCursor: `cursor-${requestCount}`,
        },
      });
    });

    await expect(mod.listAutomationsCommand({ all: true })).rejects.toMatchObject({
      code: "user",
      message: "automations list --all exceeded 1000 pages without reaching the end.",
      exitCode: 1,
    });
    expect(requestCount).toBe(1000);
  });

  it("deletes with --yes using the no-content response path", async () => {
    let method: string | undefined;
    stubFetch((_url, init) => {
      method = init?.method;
      return new Response(null, { status: 204 });
    });

    await mod.deleteAutomationCommand("rule-1", { yes: true });

    expect(method).toBe("DELETE");
    expect(consoleOutput.log).toContain("Deleted automation rule-1.");
  });

  it("requires --yes when deleting in JSON mode", async () => {
    let fetchCalled = false;
    stubFetch(() => {
      fetchCalled = true;
      return new Response(null, { status: 204 });
    });

    await expect(mod.deleteAutomationCommand("rule-1", { json: true })).rejects.toThrow(
      "`automations delete --json` requires --yes.",
    );

    expect(fetchCalled).toBe(false);
  });

  it("maps automation not_found to exit code 3", async () => {
    stubFetch(() =>
      Response.json({ ok: false, error: "not_found", message: "Scheduled automation not found." }, { status: 404 }),
    );

    await expect(mod.deleteAutomationCommand("missing", { yes: true })).rejects.toMatchObject({
      exitCode: 3,
      message: "Scheduled automation not found.",
    });
  });
});

// ===========================================================================
// getSessionCommand
// ===========================================================================

type GetSessionModule = {
  getSessionCommand: (sessionId: string, options: { json?: boolean }) => Promise<void>;
};

describe("getSessionCommand", () => {
  let mod: GetSessionModule;

  beforeEach(async () => {
    const modulePath: string = "../../apps/cli/src/commands/sessions";
    mod = (await import(modulePath)) as unknown as GetSessionModule;
  });

  it("prints the lifecycle phase from the wrapped session payload", async () => {
    stubFetch((url) => {
      if (url.endsWith("/api/sessions/ses_get")) {
        return Response.json({ session: { sessionId: "ses_get", phase: "completed", status: "active" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.getSessionCommand("ses_get", {});

    expect(consoleOutput.log).toContain("Status: completed");
    expect(consoleOutput.log).not.toContainEqual(expect.stringContaining("Status: active"));
  });

  it("falls back to archival status when phase is absent", async () => {
    stubFetch((url) => {
      if (url.endsWith("/api/sessions/ses_no_phase")) {
        return Response.json({ session: { sessionId: "ses_no_phase", status: "archived" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.getSessionCommand("ses_no_phase", {});

    expect(consoleOutput.log).toContain("Status: archived");
  });

  it("prints unknown when neither phase nor status is present", async () => {
    stubFetch((url) => {
      if (url.endsWith("/api/sessions/ses_bare")) {
        return Response.json({ session: { sessionId: "ses_bare" } });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.getSessionCommand("ses_bare", {});

    expect(consoleOutput.log).toContain("Status: unknown");
  });

  it("prints the PR URL and branch when present", async () => {
    stubFetch((url) => {
      if (url.endsWith("/api/sessions/ses_pr")) {
        return Response.json({
          session: {
            sessionId: "ses_pr",
            phase: "completed",
            prUrl: "https://github.com/org/repo/pull/42",
            publishedBranch: "agent/fix",
            baseBranch: "main",
          },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.getSessionCommand("ses_pr", {});

    expect(consoleOutput.log).toContain("PR: https://github.com/org/repo/pull/42 (agent/fix)");
  });

  it("prints the published branch when no PR URL is present", async () => {
    stubFetch((url) => {
      if (url.endsWith("/api/sessions/ses_branch")) {
        return Response.json({
          session: {
            sessionId: "ses_branch",
            phase: "completed",
            prUrl: null,
            publishedBranch: "agent/fix",
            baseBranch: "main",
          },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.getSessionCommand("ses_branch", {});

    expect(consoleOutput.log).toContain("Branch: agent/fix");
    expect(consoleOutput.log).not.toContainEqual(expect.stringContaining("PR:"));
  });

  it("prints lastBranch when it differs from baseBranch and no publishedBranch exists", async () => {
    stubFetch((url) => {
      if (url.endsWith("/api/sessions/ses_last_branch")) {
        return Response.json({
          session: {
            sessionId: "ses_last_branch",
            phase: "completed",
            lastBranch: "agent/fix",
            baseBranch: "main",
          },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.getSessionCommand("ses_last_branch", {});

    expect(consoleOutput.log).toContain("Branch: agent/fix");
  });

  it("does not print a branch line when only baseBranch is present", async () => {
    stubFetch((url) => {
      if (url.endsWith("/api/sessions/ses_base_only")) {
        return Response.json({
          session: {
            sessionId: "ses_base_only",
            phase: "completed",
            baseBranch: "main",
          },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.getSessionCommand("ses_base_only", {});

    expect(consoleOutput.log).not.toContainEqual(expect.stringContaining("PR:"));
    expect(consoleOutput.log).not.toContainEqual(expect.stringContaining("Branch:"));
  });

  it("does not print a result line when no PR or produced branch is present", async () => {
    stubFetch((url) => {
      if (url.endsWith("/api/sessions/ses_no_change")) {
        return Response.json({
          session: {
            sessionId: "ses_no_change",
            phase: "completed",
          },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.getSessionCommand("ses_no_change", {});

    expect(consoleOutput.log).toContain("Status: completed");
    expect(consoleOutput.log).not.toContainEqual(expect.stringContaining("PR:"));
    expect(consoleOutput.log).not.toContainEqual(expect.stringContaining("Branch:"));
  });
});

// ===========================================================================
// transcriptCommand
// ===========================================================================

type TranscriptModule = {
  transcriptCommand: (sessionId: string, options: { last?: string; json?: boolean }) => Promise<void>;
};

describe("transcriptCommand", () => {
  let mod: TranscriptModule;

  beforeEach(async () => {
    const modulePath: string = "../../apps/cli/src/commands/transcript";
    mod = (await import(modulePath)) as unknown as TranscriptModule;
  });

  it("renders a readable transcript from session export data", async () => {
    stubFetch(() =>
      Response.json({
        ok: true,
        session: {
          id: "ses_transcript_1234",
          status: "idle",
          repoUrl: "https://github.com/org/repo",
          createdAt: "2026-03-27T12:00:00.000Z",
          closedAt: null,
        },
        prompts: [
          {
            id: "p-1",
            prompt: "Fix the login bug",
            status: "completed",
            createdAt: "2026-03-27T12:00:00.000Z",
            startedAt: "2026-03-27T12:00:01.000Z",
            completedAt: "2026-03-27T12:00:05.000Z",
          },
        ],
        events: [
          { type: "prompt_processing", sequence: 1, data: { promptId: "p-1" } },
          { type: "tool_call", sequence: 2, data: { id: "tc-1", tool: "Read", summary: "src/auth.ts" } },
          { type: "text", sequence: 3, data: { id: "t-1", text: "I found the issue and fixed it." } },
          { type: "prompt_completed", sequence: 4, data: { promptId: "p-1" } },
        ],
        tokens: {
          inputTokens: 1200,
          outputTokens: 300,
          totalTokens: 1500,
        },
        stats: {
          totalPrompts: 1,
          successCount: 1,
          failCount: 0,
          totalToolCalls: 1,
          totalDurationMs: 5000,
        },
        pr: null,
      }),
    );

    await mod.transcriptCommand("ses_transcript_1234", {});

    const rendered = consoleOutput.log.join("\n");
    expect(rendered).toContain("# Session transcript");
    expect(rendered).toContain("Fix the login bug");
    expect(rendered).toContain("**Tool call:** Read - src/auth.ts");
    expect(rendered).toContain("I found the issue and fixed it.");
  });

  it("prints raw export JSON when --json is requested", async () => {
    stubFetch(() =>
      Response.json({
        ok: true,
        session: {
          id: "ses_json",
          status: "idle",
          repoUrl: null,
          createdAt: "2026-03-27T12:00:00.000Z",
          closedAt: null,
        },
        prompts: [],
        events: [],
        tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        stats: { totalPrompts: 0, successCount: 0, failCount: 0, totalToolCalls: 0, totalDurationMs: 0 },
        pr: null,
      }),
    );

    await mod.transcriptCommand("ses_json", { json: true });

    expect(stdoutWrites.join("")).toContain('"id":"ses_json"');
    expect(consoleOutput.log).toHaveLength(0);
  });

  it("renders only the last requested transcript events", async () => {
    stubFetch(() =>
      Response.json({
        ok: true,
        session: {
          id: "ses_last",
          status: "idle",
          repoUrl: null,
          createdAt: "2026-03-27T12:00:00.000Z",
          closedAt: null,
        },
        prompts: [
          {
            id: "p-1",
            prompt: "Inspect output",
            status: "completed",
            createdAt: "2026-03-27T12:00:00.000Z",
            startedAt: "2026-03-27T12:00:01.000Z",
            completedAt: "2026-03-27T12:00:05.000Z",
          },
        ],
        events: [
          { type: "prompt_processing", sequence: 1, data: { promptId: "p-1" } },
          { type: "text", sequence: 2, data: { id: "t-1", text: "first line" } },
          { type: "text", sequence: 3, data: { id: "t-2", text: "second line" } },
        ],
        tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        stats: { totalPrompts: 0, successCount: 0, failCount: 0, totalToolCalls: 0, totalDurationMs: 0 },
        pr: null,
      }),
    );

    await mod.transcriptCommand("ses_last", { last: "1" });

    const rendered = consoleOutput.log.join("\n");
    expect(rendered).not.toContain("first line");
    expect(rendered).toContain("second line");
  });

  it("filters prompts and keeps JSON --last events bounded", async () => {
    stubFetch(() =>
      Response.json({
        ok: true,
        session: {
          id: "ses_last_json",
          status: "idle",
          repoUrl: null,
          createdAt: "2026-03-27T12:00:00.000Z",
          closedAt: null,
        },
        prompts: [
          {
            id: "p-1",
            prompt: "Older prompt",
            status: "completed",
            createdAt: "2026-03-27T12:00:00.000Z",
            startedAt: "2026-03-27T12:00:01.000Z",
            completedAt: "2026-03-27T12:00:05.000Z",
          },
          {
            id: "p-2",
            prompt: "Recent prompt",
            status: "completed",
            createdAt: "2026-03-27T12:01:00.000Z",
            startedAt: "2026-03-27T12:01:01.000Z",
            completedAt: "2026-03-27T12:01:05.000Z",
          },
        ],
        events: [
          { type: "prompt_processing", sequence: 1, data: { promptId: "p-1" } },
          { type: "text", sequence: 2, data: { id: "t-1", text: "old", promptId: "p-1" } },
          { type: "prompt_processing", sequence: 3, data: { promptId: "p-2" } },
          { type: "text", sequence: 4, data: { id: "t-2", text: "new", promptId: "p-2" } },
        ],
        tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        stats: { totalPrompts: 0, successCount: 0, failCount: 0, totalToolCalls: 0, totalDurationMs: 0 },
        pr: null,
      }),
    );

    await mod.transcriptCommand("ses_last_json", { last: "1", json: true });

    const payload = JSON.parse(stdoutWrites.join("")) as {
      prompts: Array<{ id: string }>;
      events: Array<{ sequence: number }>;
    };
    expect(payload.events).toEqual([{ type: "text", sequence: 4, data: { id: "t-2", text: "new", promptId: "p-2" } }]);
    expect(payload.prompts).toEqual([expect.objectContaining({ id: "p-2" })]);
  });

  it("rejects invalid --last values before fetching transcript data", async () => {
    let fetchCalled = false;
    stubFetch(() => {
      fetchCalled = true;
      return Response.json({});
    });

    await expect(mod.transcriptCommand("ses_last", { last: "0" })).rejects.toThrow("positive integer");

    expect(fetchCalled).toBe(false);
  });
});

// ===========================================================================
// token commands
// ===========================================================================

type TokensModule = {
  listTokensCommand: (options: { limit?: string; cursor?: string; all?: boolean; json?: boolean }) => Promise<void>;
  createTokenCommand: (options: {
    scope?: "read" | "write";
    expiresInDays?: string;
    idempotencyKey?: string;
    json?: boolean;
  }) => Promise<void>;
};

describe("createTokenCommand", () => {
  let mod: TokensModule;

  beforeEach(async () => {
    const modulePath: string = "../../apps/cli/src/commands/tokens";
    mod = (await import(modulePath)) as unknown as TokensModule;
  });

  it.each(["0", "-5", "3.5", "abc"])(
    "rejects invalid expiresInDays value %s before calling the API",
    async (expiresInDays) => {
      let fetchCalled = false;
      stubFetch(() => {
        fetchCalled = true;
        return Response.json({});
      });

      await expect(mod.createTokenCommand({ expiresInDays })).rejects.toThrow("positive integer");

      expect(fetchCalled).toBe(false);
    },
  );

  it("sends explicit idempotency keys when creating tokens", async () => {
    let requestInit: RequestInit | undefined;
    stubFetch((_url, init) => {
      requestInit = init;
      return Response.json({ ok: true, token: "arc_new", id: 1, scope: "read" });
    });

    await mod.createTokenCommand({ idempotencyKey: "retry-key", json: true });

    expect((requestInit?.headers as Headers).get("Idempotency-Key")).toBe("retry-key");
  });

  it("fetches all token pages when --all is requested", async () => {
    const requestedUrls: string[] = [];
    stubFetch((url) => {
      requestedUrls.push(url);
      const parsed = new URL(url);
      if (parsed.searchParams.get("cursor") === "cursor_2") {
        return Response.json({
          data: [{ id: 2, scope: "write", tokenPrefix: "arc_2", revokedAt: null }],
          nextCursor: null,
        });
      }
      return Response.json({
        data: [{ id: 1, scope: "read", tokenPrefix: "arc_1", revokedAt: null }],
        nextCursor: "cursor_2",
      });
    });

    await mod.listTokensCommand({ limit: "1", all: true, json: true });

    expect(requestedUrls).toHaveLength(2);
    expect(new URL(requestedUrls[0]).searchParams.get("cursor")).toBeNull();
    expect(new URL(requestedUrls[1]).searchParams.get("cursor")).toBe("cursor_2");
    expect(JSON.parse(stdoutWrites.join(""))).toEqual({
      data: [
        { id: 1, scope: "read", tokenPrefix: "arc_1", revokedAt: null },
        { id: 2, scope: "write", tokenPrefix: "arc_2", revokedAt: null },
      ],
      nextCursor: null,
    });
  });

  it("stops tokens --all when pagination does not terminate", async () => {
    let requestCount = 0;
    stubFetch(() => {
      requestCount += 1;
      return Response.json({
        data: [{ id: requestCount, scope: "read", tokenPrefix: "arc", revokedAt: null }],
        nextCursor: `cursor_${requestCount + 1}`,
      });
    });

    await expect(mod.listTokensCommand({ all: true, json: true })).rejects.toThrow(
      "tokens list --all exceeded 1000 pages",
    );
    expect(requestCount).toBe(1000);
  });

  it("adds an actionable hint for duplicate token idempotency keys", async () => {
    stubFetch(() =>
      Response.json(
        { ok: false, error: "A request with this Idempotency-Key already exists", code: "duplicate_request" },
        { status: 409 },
      ),
    );

    await expect(mod.createTokenCommand({ idempotencyKey: "retry-key", json: true })).rejects.toMatchObject({
      exitCode: 4,
      hint: "Use a new --idempotency-key for a new token, or retry the original command only if the first result was lost.",
      data: { serverCode: "duplicate_request" },
    });
  });
});

// ===========================================================================
// watchCommand
// ===========================================================================

type WatchModule = {
  watchCommand: (
    sessionId: string,
    options: { pollInterval?: string; afterSequence?: string; limit?: string },
  ) => Promise<void>;
};

function makeSse(messages: Array<{ event: string; data: Record<string, unknown>; id?: number }>): string {
  return messages
    .map((message) =>
      [
        ...(message.id !== undefined ? [`id: ${message.id}`] : []),
        `event: ${message.event}`,
        `data: ${JSON.stringify(message.data)}`,
        "",
      ].join("\n"),
    )
    .join("\n");
}

describe("watchCommand", () => {
  let mod: WatchModule;

  beforeEach(async () => {
    const modulePath: string = "../../apps/cli/src/commands/watch";
    mod = (await import(modulePath)) as unknown as WatchModule;
  });

  it("prints status, activity, and assistant text until the session completes", async () => {
    let eventsCallCount = 0;

    stubFetch((url) => {
      if (url.includes("/prompts")) {
        return Response.json({
          prompts: [{ promptId: "p-1", prompt: "Fix the login bug" }],
        });
      }
      if (url.includes("/events?")) {
        eventsCallCount++;
        if (eventsCallCount === 1) {
          return new Response(
            makeSse([
              { event: "status", data: { phase: "running", title: "Fix the login bug" } },
              { event: "prompt_processing", id: 1, data: { promptId: "p-1" } },
              { event: "tool_call", id: 2, data: { id: "tc-1", tool: "Read", summary: "src/auth.ts" } },
              { event: "text", id: 3, data: { id: "t-1", text: "I found the issue and fixed it." } },
            ]),
          );
        }
        return new Response(
          makeSse([
            { event: "status", data: { phase: "completed" } },
            { event: "prompt_completed", id: 4, data: { promptId: "p-1" } },
          ]),
        );
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.watchCommand("ses_watch", { pollInterval: "250" });

    expect(consoleOutput.log).toContainEqual(expect.stringContaining("Watching session ses_watch"));
    expect(consoleOutput.log).toContainEqual(expect.stringContaining("[status] running"));
    expect(consoleOutput.log).toContainEqual(expect.stringContaining("[tool] Read - src/auth.ts"));
    expect(consoleOutput.log).toContainEqual(expect.stringContaining("[prompt] p-1 completed"));
    expect(stdoutWrites.join("")).toContain("assistant> I found the issue and fixed it.");
  });

  it("prints the no-change outcome line from the latest completed prompt result", async () => {
    stubFetch((url) => {
      if (url.includes("/prompts")) {
        return Response.json({
          prompts: [{ promptId: "p-1", status: "completed", result: { noChanges: true, noChangeReason: "no_diff" } }],
        });
      }
      if (url.includes("/events?")) {
        return new Response(makeSse([{ event: "status", data: { phase: "completed" } }]));
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.watchCommand("ses_watch_nochange", { pollInterval: "250" });

    expect(consoleOutput.log).toContainEqual(
      expect.stringContaining("[outcome] Completed without code changes - no PR created."),
    );
  });

  it("prints abnormal no-change copy for prep_failed", async () => {
    stubFetch((url) => {
      if (url.includes("/prompts")) {
        return Response.json({
          prompts: [
            { promptId: "p-1", status: "completed", result: { noChanges: true, noChangeReason: "prep_failed" } },
          ],
        });
      }
      if (url.includes("/events?")) {
        return new Response(makeSse([{ event: "status", data: { phase: "completed" } }]));
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.watchCommand("ses_watch_prepfailed", { pollInterval: "250" });

    expect(consoleOutput.log).toContainEqual(
      expect.stringContaining("[outcome] Finalization failed before changes could be prepared."),
    );
  });

  it("does not print an outcome line when the latest completed prompt produced changes", async () => {
    stubFetch((url) => {
      if (url.includes("/prompts")) {
        return Response.json({
          prompts: [{ promptId: "p-1", status: "completed", result: { diffSummary: "Changes detected" } }],
        });
      }
      if (url.includes("/events?")) {
        return new Response(makeSse([{ event: "status", data: { phase: "completed" } }]));
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.watchCommand("ses_watch_plain", { pollInterval: "250" });

    expect(consoleOutput.log).not.toContainEqual(expect.stringContaining("[outcome]"));
  });

  it("does not print a completion outcome for a non-completed terminal phase (stopped)", async () => {
    stubFetch((url) => {
      if (url.includes("/prompts")) {
        return Response.json({
          prompts: [{ promptId: "p-1", status: "completed", result: { noChanges: true, noChangeReason: "no_diff" } }],
        });
      }
      if (url.includes("/events?")) {
        return new Response(makeSse([{ event: "status", data: { phase: "stopped" } }]));
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.watchCommand("ses_watch_stopped_nochange", { pollInterval: "250" });

    // Phase is `stopped`, not `completed`, so no completion outcome must print
    // even though a prior completed prompt was a no-change result.
    expect(consoleOutput.log).not.toContainEqual(expect.stringContaining("[outcome]"));
  });

  it("stops following when the session becomes stopped", async () => {
    stubFetch((url) => {
      if (url.includes("/prompts")) {
        return Response.json({ prompts: [] });
      }
      if (url.includes("/events?")) {
        return new Response(makeSse([{ event: "status", data: { phase: "stopped" } }]));
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.watchCommand("ses_watch_stopped", { pollInterval: "250" });

    expect(consoleOutput.log).toContainEqual(expect.stringContaining("Watching session ses_watch_stopped"));
    expect(consoleOutput.log).toContainEqual(expect.stringContaining("[status] stopped"));
  });

  it("keeps following when a session reports idle (regression: idle is not terminal)", async () => {
    // Pre-phase, the CLI watch loop exited as soon as a session reported `idle`,
    // which broke watch on brand-new repo sessions sitting in idle between
    // prompt enqueue and pickup. With the phase contract, `idle` is non-terminal;
    // the loop must keep polling until a true terminal state is reached.
    let eventsCallCount = 0;
    stubFetch((url) => {
      if (url.includes("/prompts")) {
        return Response.json({ prompts: [] });
      }
      if (url.includes("/events?")) {
        eventsCallCount++;
        if (eventsCallCount === 1) {
          return new Response(makeSse([{ event: "status", data: { phase: "idle" } }]));
        }
        return new Response(makeSse([{ event: "status", data: { phase: "completed" } }]));
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.watchCommand("ses_watch_idle", { pollInterval: "250" });

    expect(eventsCallCount).toBeGreaterThanOrEqual(2);
    expect(consoleOutput.log).toContainEqual(expect.stringContaining("[status] idle"));
    expect(consoleOutput.log).toContainEqual(expect.stringContaining("[status] completed"));
  });

  it("keeps following when the session is waiting_for_input (not terminal)", async () => {
    let eventsCallCount = 0;
    stubFetch((url) => {
      if (url.includes("/prompts")) {
        return Response.json({ prompts: [{ promptId: "p-1", prompt: "Refactor login" }] });
      }
      if (url.includes("/events?")) {
        eventsCallCount++;
        if (eventsCallCount === 1) {
          return new Response(
            makeSse([
              { event: "status", data: { phase: "waiting_for_input" } },
              { event: "question", id: 1, data: { id: "q-1", question: "Which file?" } },
            ]),
          );
        }
        return new Response(
          makeSse([
            { event: "status", data: { phase: "completed" } },
            { event: "prompt_completed", id: 2, data: { promptId: "p-1" } },
          ]),
        );
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.watchCommand("ses_watch_waiting", { pollInterval: "250" });

    // CLI must keep watching across the waiting_for_input status (no early
    // termination) and exit only after the session reaches a terminal state.
    expect(eventsCallCount).toBeGreaterThanOrEqual(2);
    expect(consoleOutput.log).toContainEqual(expect.stringContaining("[status] waiting_for_input"));
    expect(consoleOutput.log).toContainEqual(expect.stringContaining("[status] completed"));
  });

  it("logs a warning and continues when prompt labels cannot be fetched", async () => {
    stubFetch((url) => {
      if (url.includes("/prompts")) {
        return new Response("Unavailable", { status: 503 });
      }
      return new Response(makeSse([{ event: "status", data: { phase: "completed" } }]));
    });

    await mod.watchCommand("ses_watch", { pollInterval: "250" });

    expect(consoleOutput.error).toContainEqual(expect.stringContaining("failed to fetch prompt labels"));
    expect(consoleOutput.log).toContainEqual(expect.stringContaining("[status] completed"));
  });

  it("continues fetching until a completed replay backlog is drained", async () => {
    let eventsCallCount = 0;

    stubFetch((url) => {
      if (url.includes("/prompts")) {
        return Response.json({
          prompts: [{ promptId: "p-1", prompt: "Fix the login bug" }],
        });
      }
      if (url.includes("/events?")) {
        eventsCallCount++;
        if (eventsCallCount === 1) {
          return new Response(
            makeSse([
              { event: "status", data: { phase: "completed" } },
              ...Array.from({ length: WATCH_REPLAY_PAGE_SIZE }, (_, index) => ({
                event: "tool_call",
                id: index + 1,
                data: { id: `tc-${index + 1}`, tool: "Read", summary: `src/file-${index + 1}.ts` },
              })),
            ]),
          );
        }
        return new Response(
          makeSse([
            { event: "status", data: { phase: "completed" } },
            {
              event: "tool_call",
              id: WATCH_REPLAY_PAGE_SIZE + 1,
              data: {
                id: `tc-${WATCH_REPLAY_PAGE_SIZE + 1}`,
                tool: "Read",
                summary: `src/file-${WATCH_REPLAY_PAGE_SIZE + 1}.ts`,
              },
            },
          ]),
        );
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.watchCommand("ses_watch_backlog", { pollInterval: "250" });

    expect(eventsCallCount).toBe(2);
    expect(consoleOutput.log).toContainEqual(expect.stringContaining(`src/file-${WATCH_REPLAY_PAGE_SIZE + 1}.ts`));
  });

  it.each([
    ["pollInterval", { pollInterval: "10foo" }],
    ["afterSequence", { afterSequence: "1.5", pollInterval: "250" }],
  ])("rejects malformed numeric option %s", async (_name, options) => {
    await expect(mod.watchCommand("ses_watch", options)).rejects.toThrow("non-negative integer");
  });

  it("rejects out-of-range poll intervals", async () => {
    await expect(mod.watchCommand("ses_watch", { pollInterval: "0" })).rejects.toThrow(
      "Polling interval must be between 250 and 60000 milliseconds",
    );
    await expect(mod.watchCommand("ses_watch", { pollInterval: "60001" })).rejects.toThrow(
      "Polling interval must be between 250 and 60000 milliseconds",
    );
  });

  it("rejects zero limit before starting the follow loop", async () => {
    await expect(mod.watchCommand("ses_watch", { limit: "0", pollInterval: "250" })).rejects.toThrow(
      "--limit must be greater than 0",
    );
  });

  it("flushes an open text line when fetching the next page fails", async () => {
    let eventsCallCount = 0;
    stubFetch((url) => {
      if (url.includes("/prompts")) {
        return Response.json({ prompts: [] });
      }
      if (url.includes("/events?")) {
        eventsCallCount++;
        if (eventsCallCount === 1) {
          return new Response(makeSse([{ event: "text", id: 1, data: { text: "partial" } }]));
        }
        return new Response("Unavailable", { status: 503 });
      }
      return new Response("Not found", { status: 404 });
    });

    await expect(mod.watchCommand("ses_watch", { limit: "1", pollInterval: "250" })).rejects.toThrow("API error 503");

    expect(stdoutWrites.join("")).toContain("assistant> partial\n");
  });
});

// ===========================================================================
// sessionEventsCommand
// ===========================================================================

type SessionsModule = {
  sessionEventsCommand: (
    sessionId: string,
    options: {
      follow?: boolean;
      afterSequence?: string;
      after?: string;
      beforeSequence?: string;
      before?: string;
      limit?: string;
      pollInterval?: string;
      promptId?: string;
      json?: boolean;
    },
  ) => Promise<void>;
};

describe("sessionEventsCommand", () => {
  let mod: SessionsModule;

  beforeEach(async () => {
    const modulePath: string = "../../apps/cli/src/commands/sessions";
    mod = (await import(modulePath)) as unknown as SessionsModule;
  });

  it("passes after-sequence and limit through to follow mode", async () => {
    const eventUrls: string[] = [];
    stubFetch((url) => {
      if (url.includes("/prompts")) {
        return Response.json({ prompts: [] });
      }
      if (url.includes("/events?")) {
        eventUrls.push(url);
        return new Response(makeSse([{ event: "status", data: { phase: "completed" } }]));
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.sessionEventsCommand("ses_follow", {
      follow: true,
      afterSequence: "42",
      limit: "5",
      pollInterval: "250",
    });

    expect(eventUrls[0]).toContain("afterSequence=42");
    expect(eventUrls[0]).toContain("limit=5");
  });

  it("passes after alias and limit through to follow mode", async () => {
    const eventUrls: string[] = [];
    stubFetch((url) => {
      if (url.includes("/prompts")) {
        return Response.json({ prompts: [] });
      }
      if (url.includes("/events?")) {
        eventUrls.push(url);
        return new Response(makeSse([{ event: "status", data: { phase: "completed" } }]));
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.sessionEventsCommand("ses_follow", { follow: true, after: "42", limit: "5", pollInterval: "250" });

    expect(eventUrls[0]).toContain("afterSequence=42");
    expect(eventUrls[0]).toContain("limit=5");
  });

  it("rejects before alias in follow mode", async () => {
    await expect(
      mod.sessionEventsCommand("ses_follow", { follow: true, before: "42", pollInterval: "250" }),
    ).rejects.toThrow("--before-sequence/--before cannot be used with --follow");
  });

  it("rejects prompt filtering in follow mode because the follow endpoint cannot filter prompts", async () => {
    await expect(
      mod.sessionEventsCommand("ses_follow", { follow: true, promptId: "p-1", pollInterval: "250" }),
    ).rejects.toThrow("--prompt-id cannot be used with --follow");
  });

  it("sends canonical history pagination parameters", async () => {
    const historyUrls: string[] = [];
    stubFetch((url) => {
      if (url.includes("/events/history")) {
        historyUrls.push(url);
        return Response.json({ events: [] });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.sessionEventsCommand("ses_history", { afterSequence: "42", limit: "5", json: true });

    expect(historyUrls[0]).toContain("after_sequence=42");
    expect(historyUrls[0]).toContain("limit=5");
  });

  it("sends after alias as history after_sequence", async () => {
    const historyUrls: string[] = [];
    stubFetch((url) => {
      if (url.includes("/events/history")) {
        historyUrls.push(url);
        return Response.json({ events: [] });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.sessionEventsCommand("ses_history", { after: "42", limit: "5", json: true });

    expect(historyUrls[0]).toContain("after_sequence=42");
    expect(historyUrls[0]).toContain("limit=5");
  });

  it("sends before alias as history before_sequence", async () => {
    const historyUrls: string[] = [];
    stubFetch((url) => {
      if (url.includes("/events/history")) {
        historyUrls.push(url);
        return Response.json({ events: [] });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.sessionEventsCommand("ses_history", { before: "100", limit: "5", json: true });

    expect(historyUrls[0]).toContain("before_sequence=100");
    expect(historyUrls[0]).toContain("limit=5");
  });

  it("rejects conflicting after spellings", async () => {
    await expect(
      mod.sessionEventsCommand("ses_history", { afterSequence: "42", after: "43", json: true }),
    ).rejects.toThrow("--after cannot be combined with --after-sequence");
  });

  it("rejects conflicting before spellings", async () => {
    await expect(
      mod.sessionEventsCommand("ses_history", { beforeSequence: "42", before: "43", json: true }),
    ).rejects.toThrow("--before cannot be combined with --before-sequence");
  });

  it("uses prompt labels when rendering historical events", async () => {
    stubFetch((url) => {
      if (url.includes("/prompts")) {
        return Response.json({ prompts: [{ promptId: "p-1", prompt: "Fix     labels" }] });
      }
      if (url.includes("/events/history")) {
        return Response.json({
          events: [
            {
              sequence: 1,
              sessionId: "ses_history",
              promptId: "p-1",
              phase: "prompt.dispatch",
              timestampMs: 1_713_456_789_000,
              payload: {
                startupAttemptId: null,
                bridgeEventType: "prompt_accepted",
                bridgeData: {},
              },
            },
          ],
        });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.sessionEventsCommand("ses_history", {});

    expect(consoleOutput.log).toContainEqual("[prompt] p-1 started - Fix labels");
  });

  it("renders bridge-event tool updates with the original tool metadata in history mode", async () => {
    stubFetch((url) => {
      if (url.includes("/prompts")) {
        return Response.json({ prompts: [] });
      }
      if (url.includes("/events/history")) {
        return Response.json({
          events: [
            {
              sequence: 1,
              sessionId: "ses_history",
              promptId: "p-1",
              phase: "tool.call",
              timestampMs: 1_713_456_789_000,
              payload: {
                callId: "tool-1",
                tool: "Read",
                summary: "src/auth.ts",
                args: {},
              },
            },
            {
              sequence: 2,
              sessionId: "ses_history",
              promptId: "p-1",
              phase: "bridge.event",
              timestampMs: 1_713_456_789_100,
              payload: {
                bridgeEventType: "tool_update",
                bridgeData: {
                  callId: "tool-1",
                  status: "completed",
                },
              },
            },
          ],
        });
      }
      return new Response("Not found", { status: 404 });
    });

    await mod.sessionEventsCommand("ses_history", {});

    expect(consoleOutput.log).toContainEqual("[tool] Read - src/auth.ts");
    expect(consoleOutput.log).toContainEqual("[tool completed] Read - src/auth.ts");
  });
});

// ===========================================================================
// apiFetch
// ===========================================================================

type ApiFetchModule = {
  apiFetch: (config: { apiUrl: string; token: string }, path: string, init?: RequestInit) => Promise<unknown>;
  apiFetchText: (config: { apiUrl: string; token: string }, path: string, init?: RequestInit) => Promise<string>;
};

describe("apiFetch", () => {
  let mod: ApiFetchModule;

  beforeEach(async () => {
    const modulePath: string = "../../apps/cli/src/api";
    mod = (await import(modulePath)) as unknown as ApiFetchModule;
  });

  it("sends Authorization header with Bearer token", async () => {
    let capturedHeaders: HeadersInit | undefined;
    stubFetch((_url, init) => {
      capturedHeaders = init?.headers;
      return Response.json({ ok: true });
    });

    await mod.apiFetch(mockConfig, "/api/test");

    expect(capturedHeaders).toBeDefined();
    expect(new Headers(capturedHeaders).get("Authorization")).toBe(`Bearer ${mockConfig.token}`);
  });

  it("sends Content-Type application/json", async () => {
    let capturedHeaders: HeadersInit | undefined;
    stubFetch((_url, init) => {
      capturedHeaders = init?.headers;
      return Response.json({ ok: true });
    });

    await mod.apiFetch(mockConfig, "/api/test");

    expect(new Headers(capturedHeaders).get("Content-Type")).toBe("application/json");
  });

  it("preserves caller headers passed as header tuples", async () => {
    let capturedHeaders: HeadersInit | undefined;
    stubFetch((_url, init) => {
      capturedHeaders = init?.headers;
      return Response.json({ ok: true });
    });

    await mod.apiFetch(mockConfig, "/api/test", {
      headers: [["Idempotency-Key", "idem_123"]],
    });

    const headers = new Headers(capturedHeaders);
    expect(headers.get("Idempotency-Key")).toBe("idem_123");
    expect(headers.get("Authorization")).toBe(`Bearer ${mockConfig.token}`);
  });

  it("constructs full URL from config.apiUrl + path", async () => {
    let capturedUrl: string | undefined;
    stubFetch((url) => {
      capturedUrl = url;
      return Response.json({ ok: true });
    });

    await mod.apiFetch(mockConfig, "/api/sessions");

    expect(capturedUrl).toBe("https://app.trycycloid.com/api/sessions");
  });

  it("does not produce double-slash API paths when config.apiUrl has a trailing slash", async () => {
    configOverride = { ...mockConfig, apiUrl: "https://app.trycycloid.com/" };
    let capturedUrl: string | undefined;
    stubFetch((url) => {
      capturedUrl = url;
      return Response.json({ ok: true });
    });

    await mod.apiFetch(configOverride, "/api/sessions");

    expect(capturedUrl).toBe("https://app.trycycloid.com/api/sessions");
  });

  it("throws on 401 with re-auth message", async () => {
    stubFetch(() => new Response("Unauthorized", { status: 401 }));

    await expect(mod.apiFetch(mockConfig, "/api/test")).rejects.toThrow("API error 401");
  });

  it("throws on non-ok response with status code and body", async () => {
    stubFetch(() => new Response("Something went wrong", { status: 500 }));

    await expect(mod.apiFetch(mockConfig, "/api/test")).rejects.toThrow("API error 500");
  });

  it("returns parsed JSON on success", async () => {
    stubFetch(() => Response.json({ sessionId: "ses_1" }));

    const result = await mod.apiFetch(mockConfig, "/api/sessions");
    expect(result).toEqual({ sessionId: "ses_1" });
  });

  it("returns plain text with apiFetchText", async () => {
    stubFetch(() => new Response('event: status\ndata: {"status":"idle"}\n\n'));

    const result = await mod.apiFetchText(mockConfig, "/api/sessions/s-1/events");
    expect(result).toContain("event: status");
  });
});

// ===========================================================================
// CLI create option parsing
// ===========================================================================

describe("CLI create option parsing", () => {
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = [...process.argv];
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.doUnmock("../../apps/cli/src/commands/create.js");
    vi.doUnmock("../../apps/cli/src/commands/message.js");
    vi.doUnmock("../../apps/cli/src/commands/qa.js");
    vi.resetModules();
  });

  async function parseWithCreateCommand(args: string[]) {
    vi.resetModules();
    const createCommand = vi.fn(async () => undefined);
    const messageCommand = vi.fn(async () => undefined);
    const qaCommand = vi.fn(async () => undefined);
    vi.doMock("../../apps/cli/src/commands/create.js", () => ({ createCommand }));
    vi.doMock("../../apps/cli/src/commands/message.js", () => ({ messageCommand }));
    vi.doMock("../../apps/cli/src/commands/qa.js", () => ({ qaCommand }));

    process.argv = ["node", "cycloid", ...args];
    await import("../../apps/cli/src/index");

    await vi.waitFor(() => expect(createCommand).toHaveBeenCalled());
    return createCommand;
  }

  async function parseWithMessageCommand(args: string[]) {
    vi.resetModules();
    const createCommand = vi.fn(async () => undefined);
    const messageCommand = vi.fn(async () => undefined);
    const qaCommand = vi.fn(async () => undefined);
    vi.doMock("../../apps/cli/src/commands/create.js", () => ({ createCommand }));
    vi.doMock("../../apps/cli/src/commands/message.js", () => ({ messageCommand }));
    vi.doMock("../../apps/cli/src/commands/qa.js", () => ({ qaCommand }));

    process.argv = ["node", "cycloid", ...args];
    await import("../../apps/cli/src/index");

    await vi.waitFor(() => expect(messageCommand).toHaveBeenCalled());
    return messageCommand;
  }

  async function parseWithQaCommand(args: string[]) {
    vi.resetModules();
    const createCommand = vi.fn(async () => undefined);
    const messageCommand = vi.fn(async () => undefined);
    const qaCommand = vi.fn(async () => undefined);
    vi.doMock("../../apps/cli/src/commands/create.js", () => ({ createCommand }));
    vi.doMock("../../apps/cli/src/commands/message.js", () => ({ messageCommand }));
    vi.doMock("../../apps/cli/src/commands/qa.js", () => ({ qaCommand }));

    process.argv = ["node", "cycloid", ...args];
    await import("../../apps/cli/src/index");

    await vi.waitFor(() => expect(qaCommand).toHaveBeenCalled());
    return qaCommand;
  }

  it("passes --reasoning-effort through sessions create", async () => {
    const createCommand = await parseWithCreateCommand([
      "sessions",
      "create",
      "https://github.com/org/repo",
      "fix the bug",
      "--reasoning-effort",
      "max",
    ]);

    expect(createCommand).toHaveBeenCalledWith(
      "https://github.com/org/repo",
      "fix the bug",
      expect.objectContaining({ reasoningEffort: "max" }),
      expect.anything(),
    );
  });

  it("passes --auto-verify through sessions create", async () => {
    const createCommand = await parseWithCreateCommand([
      "sessions",
      "create",
      "https://github.com/org/repo",
      "fix the bug",
      "--auto-verify",
    ]);

    expect(createCommand).toHaveBeenCalledWith(
      "https://github.com/org/repo",
      "fix the bug",
      expect.objectContaining({ autoVerify: true }),
      expect.anything(),
    );
  });

  it("passes --cold through sessions create", async () => {
    const createCommand = await parseWithCreateCommand([
      "sessions",
      "create",
      "https://github.com/org/repo",
      "verify prod",
      "--cold",
    ]);

    expect(createCommand).toHaveBeenCalledWith(
      "https://github.com/org/repo",
      "verify prod",
      expect.objectContaining({ cold: true }),
      expect.anything(),
    );
  });

  it("passes --base-branch through sessions create", async () => {
    const createCommand = await parseWithCreateCommand([
      "sessions",
      "create",
      "https://github.com/org/repo",
      "fix the bug",
      "--base-branch",
      "feature/x",
    ]);

    expect(createCommand).toHaveBeenCalledWith(
      "https://github.com/org/repo",
      "fix the bug",
      expect.objectContaining({ baseBranch: "feature/x" }),
      expect.anything(),
    );
  });

  it("passes continuation flags through sessions create", async () => {
    const createCommand = await parseWithCreateCommand([
      "sessions",
      "create",
      "https://github.com/org/repo",
      "finish this PR",
      "--continue-pr",
      "https://github.com/org/repo/pull/123",
      "--continue-mode",
      "new-pr",
    ]);

    expect(createCommand).toHaveBeenCalledWith(
      "https://github.com/org/repo",
      "finish this PR",
      expect.objectContaining({
        continuePr: "https://github.com/org/repo/pull/123",
        continueMode: "new-pr",
      }),
      expect.anything(),
    );
  });

  it("passes repeated --uploaded-file through sessions create", async () => {
    const createCommand = await parseWithCreateCommand([
      "sessions",
      "create",
      "https://github.com/org/repo",
      "review these files",
      "--uploaded-file",
      "logs/trace.txt",
      "--uploaded-file",
      "data/input.json",
    ]);

    expect(createCommand).toHaveBeenCalledWith(
      "https://github.com/org/repo",
      "review these files",
      expect.objectContaining({ uploadedFile: ["logs/trace.txt", "data/input.json"] }),
      expect.anything(),
    );
  });

  it("passes repeated --uploaded-file through sessions send", async () => {
    const messageCommand = await parseWithMessageCommand([
      "sessions",
      "send",
      "ses_abc",
      "review these files",
      "--uploaded-file",
      "logs/trace.txt",
      "--uploaded-file",
      "data/input.json",
    ]);

    expect(messageCommand).toHaveBeenCalledWith(
      "ses_abc",
      "review these files",
      expect.objectContaining({ uploadedFile: ["logs/trace.txt", "data/input.json"] }),
      expect.anything(),
    );
  });

  it("passes QA options through sessions qa", async () => {
    const qaCommand = await parseWithQaCommand([
      "sessions",
      "qa",
      "https://github.com/org/repo/pull/123",
      "--backend",
      "claude_code",
      "--model",
      "claude-opus-4-8",
      "--reasoning-effort",
      "high",
      "--wait",
      "--poll-interval",
      "1000",
      "--idempotency-key",
      "idem-qa",
    ]);

    expect(qaCommand).toHaveBeenCalledWith(
      "https://github.com/org/repo/pull/123",
      expect.objectContaining({
        backend: "claude_code",
        model: "claude-opus-4-8",
        reasoningEffort: "high",
        wait: true,
        pollInterval: "1000",
        idempotencyKey: "idem-qa",
      }),
      expect.anything(),
    );
  });
});
