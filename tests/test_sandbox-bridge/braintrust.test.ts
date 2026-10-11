// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("braintrust service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("braintrust");
    delete process.env.BRAINTRUST_API_KEY;
    delete process.env.CONTROL_PLANE_URL;
    delete process.env.SESSION_ID;
    delete process.env.SANDBOX_AUTH_TOKEN;
    delete process.env.WORKER_ENV;
    delete process.env.OWNER_USER_ID;
    delete process.env.OWNER_LOGIN;
    delete process.env.BUSINESS_ID;
    delete process.env.PROVIDER;
    delete process.env.BRANCH;
    delete process.env.FROM_REPO_IMAGE;
    delete process.env.SESSION_CONFIG;
  });

  describe("sanitizeText", () => {
    it("truncates text exceeding max length", async () => {
      const { sanitizeText } = await import("../../apps/sandbox-bridge/src/services/braintrust.js");
      const longText = "a".repeat(5000);
      const result = sanitizeText(longText);
      expect(result.length).toBeLessThan(5000);
      expect(result).toContain("[truncated");
    });

    it("redacts secrets from text", async () => {
      const { sanitizeText } = await import("../../apps/sandbox-bridge/src/services/braintrust.js");
      const text = "Authorization: Bearer sk-abc123def456ghi789jklmnop";
      const result = sanitizeText(text);
      expect(result).not.toContain("sk-abc123def456ghi789jklmnop");
      expect(result).toContain("[REDACTED]");
    });

    it("returns short safe text unchanged", async () => {
      const { sanitizeText } = await import("../../apps/sandbox-bridge/src/services/braintrust.js");
      expect(sanitizeText("hello world")).toBe("hello world");
    });
  });

  describe("getBtLogger", () => {
    it("returns noop logger when not initialized", async () => {
      const { getBtLogger } = await import("../../apps/sandbox-bridge/src/services/braintrust.js");
      const logger = getBtLogger();
      const span = logger.startSpan({ name: "test" });
      // noop span has empty id and callable methods
      expect(span.id).toBe("");
      expect(() => span.log({})).not.toThrow();
      expect(() => span.end()).not.toThrow();
    });

    it("no-ops when the broker is unreachable", async () => {
      delete process.env.CONTROL_PLANE_URL;
      delete process.env.SESSION_ID;
      delete process.env.SANDBOX_AUTH_TOKEN;
      const { initBraintrust, getBtLogger } = await import("../../apps/sandbox-bridge/src/services/braintrust.js");
      await initBraintrust();
      const logger = getBtLogger();
      const span = logger.startSpan({ name: "test" });
      // noop span
      expect(span.id).toBe("");
    });

    it("initializes the SDK with project and session token, leaving URLs to SDK env handling", async () => {
      process.env.CONTROL_PLANE_URL = "https://cp.test.trycycloid.com";
      process.env.SESSION_ID = "sess-abc";
      process.env.SANDBOX_AUTH_TOKEN = "sbx-token-1";
      const initLogger = vi.fn(() => ({
        startSpan: vi.fn(),
        log: vi.fn(),
      }));
      vi.doMock("braintrust", () => ({
        initLogger,
        flush: vi.fn(),
      }));

      const { initBraintrust } = await import("../../apps/sandbox-bridge/src/services/braintrust.js");
      await initBraintrust();

      expect(initLogger).toHaveBeenCalledWith({
        projectName: "cycloid",
        apiKey: "sbx-token-1",
      });
    });

    it("falls back to noop logger and keeps flush silent when initLogger throws", async () => {
      process.env.CONTROL_PLANE_URL = "https://cp.test.trycycloid.com";
      process.env.SESSION_ID = "sess-abc";
      process.env.SANDBOX_AUTH_TOKEN = "sbx-token-1";
      const flush = vi.fn();
      vi.doMock("braintrust", () => ({
        initLogger: vi.fn(() => {
          throw new Error("login failed");
        }),
        flush,
      }));
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      const { initBraintrust, getBtLogger, flushBraintrust } =
        await import("../../apps/sandbox-bridge/src/services/braintrust.js");
      await initBraintrust();

      const span = getBtLogger().startSpan({ name: "test" });
      expect(span.id).toBe("");
      expect(consoleError).toHaveBeenCalled();

      // Init failure resets btModule, so shutdown flush must not call the SDK or log again.
      consoleError.mockClear();
      await flushBraintrust();
      expect(flush).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
      consoleError.mockRestore();
    });
  });

  describe("flushBraintrust", () => {
    it("no-ops when the SDK was never loaded", async () => {
      const { flushBraintrust } = await import("../../apps/sandbox-bridge/src/services/braintrust.js");
      await expect(flushBraintrust()).resolves.toBeUndefined();
    });

    it("calls the SDK top-level flush after init", async () => {
      process.env.CONTROL_PLANE_URL = "https://cp.test.trycycloid.com";
      process.env.SESSION_ID = "sess-abc";
      process.env.SANDBOX_AUTH_TOKEN = "sbx-token-1";
      const flush = vi.fn(async () => {});
      vi.doMock("braintrust", () => ({
        initLogger: vi.fn(() => ({ startSpan: vi.fn(), log: vi.fn() })),
        flush,
      }));

      const { initBraintrust, flushBraintrust } = await import("../../apps/sandbox-bridge/src/services/braintrust.js");
      await initBraintrust();
      await flushBraintrust();

      expect(flush).toHaveBeenCalledTimes(1);
    });

    it("swallows and logs flush failures", async () => {
      process.env.CONTROL_PLANE_URL = "https://cp.test.trycycloid.com";
      process.env.SESSION_ID = "sess-abc";
      process.env.SANDBOX_AUTH_TOKEN = "sbx-token-1";
      vi.doMock("braintrust", () => ({
        initLogger: vi.fn(() => ({ startSpan: vi.fn(), log: vi.fn() })),
        flush: vi.fn(async () => {
          throw new Error("network down");
        }),
      }));
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      const { initBraintrust, flushBraintrust } = await import("../../apps/sandbox-bridge/src/services/braintrust.js");
      await initBraintrust();
      await expect(flushBraintrust()).resolves.toBeUndefined();

      expect(consoleError).toHaveBeenCalledWith("[braintrust] flush failed:", expect.any(Error));
      consoleError.mockRestore();
    });
  });

  describe("btMetadata", () => {
    it("includes context fields and env metadata", async () => {
      process.env.WORKER_ENV = "production";
      process.env.OWNER_LOGIN = "testuser";
      const { btMetadata } = await import("../../apps/sandbox-bridge/src/services/braintrust.js");
      const meta = btMetadata({ sessionId: "s1", promptId: "p1", repo: "owner/repo" });
      expect(meta).toMatchObject({
        sessionId: "s1",
        promptId: "p1",
        repo: "owner/repo",
        env: "production",
      });
    });

    it("defaults env to 'production' when WORKER_ENV is not set", async () => {
      delete process.env.WORKER_ENV;
      const { btMetadata } = await import("../../apps/sandbox-bridge/src/services/braintrust.js");
      const meta = btMetadata({});
      expect(meta.env).toBe("production");
    });
  });

  describe("btScores", () => {
    it("keeps Braintrust scores limited to prompt outcome", async () => {
      const { btScores } = await import("../../apps/sandbox-bridge/src/services/braintrust.js");
      const scores = btScores(
        {
          toolCallCount: 20,
          editCount: 5,
          questionCount: 1,
          contextFillPercent: 0.42,
        },
        "success",
      );
      expect(scores).toEqual({ success: 1 });
    });

    it("sets success=0 for non-success outcomes", async () => {
      const { btScores } = await import("../../apps/sandbox-bridge/src/services/braintrust.js");
      const scores = btScores(
        {
          toolCallCount: 10,
          editCount: 2,
          questionCount: 0,
          contextFillPercent: 0.1,
        },
        "error",
      );
      expect(scores.success).toBe(0);
    });

    it("emits outcome score without behavior signals", async () => {
      const { btScores } = await import("../../apps/sandbox-bridge/src/services/braintrust.js");
      expect(btScores(undefined, "error")).toEqual({ success: 0 });
    });
  });

  describe("btTags", () => {
    it("builds tags from context", async () => {
      const { btTags } = await import("../../apps/sandbox-bridge/src/services/braintrust.js");
      const tags = btTags({
        businessId: "biz-acme",
        agent: "build",
        outcome: "success",
        isRestored: false,
      });
      expect(tags).toEqual(["biz-acme", "agent:build", "success"]);
    });

    it("includes restored tag when session is restored", async () => {
      const { btTags } = await import("../../apps/sandbox-bridge/src/services/braintrust.js");
      const tags = btTags({ isRestored: true });
      expect(tags).toContain("restored");
    });

    it("returns empty array when no context provided", async () => {
      const { btTags } = await import("../../apps/sandbox-bridge/src/services/braintrust.js");
      expect(btTags({})).toEqual([]);
    });
  });

  describe("btStructuredOutput", () => {
    it("includes outcome and signal counts", async () => {
      const { btStructuredOutput } = await import("../../apps/sandbox-bridge/src/services/braintrust.js");
      const output = btStructuredOutput("success", {
        editCount: 3,
        toolCallCount: 15,
        questionCount: 0,
      });
      expect(output).toEqual({
        outcome: "success",
        editCount: 3,
        toolCallCount: 15,
        questionCount: 0,
      });
    });

    it("returns bare outcome when no signals", async () => {
      const { btStructuredOutput } = await import("../../apps/sandbox-bridge/src/services/braintrust.js");
      expect(btStructuredOutput("error")).toEqual({ outcome: "error" });
    });
  });

  describe("prompt span input shape", () => {
    it("noop logger span accepts object input without error", async () => {
      const { getBtLogger, sanitizeText } = await import("../../apps/sandbox-bridge/src/services/braintrust.js");
      const logger = getBtLogger();
      const content = "Fix the login bug";
      const span = logger.startSpan({
        name: "prompt:p-1",
        type: "task",
        event: {
          input: { user: sanitizeText(content) },
        },
      });
      // Updating with system context should also work
      expect(() => {
        span.log({ input: { user: sanitizeText(content), system: "You are a helpful assistant." } });
      }).not.toThrow();
      span.end();
    });

    it("span.log receives structured input with user and system fields", async () => {
      const { sanitizeText } = await import("../../apps/sandbox-bridge/src/services/braintrust.js");
      const mockSpan = { id: "span-1", log: vi.fn(), end: vi.fn() };

      const content = "Implement feature X";
      const systemContext = "## Behavioral guidance\nYou are an expert coder.";

      // Simulate bridge.ts behavior: initial input, then update with system context
      mockSpan.log({ input: { user: sanitizeText(content), system: systemContext } });

      expect(mockSpan.log).toHaveBeenCalledWith({
        input: {
          user: "Implement feature X",
          system: "## Behavioral guidance\nYou are an expert coder.",
        },
      });
    });

    it("guard skips logging when systemContext is falsy", async () => {
      const { sanitizeText } = await import("../../apps/sandbox-bridge/src/services/braintrust.js");
      // Mirrors the bridge.ts guard: `if (systemContext && btSpan)`
      const mockSpan = { id: "span-1", log: vi.fn(), end: vi.fn() };
      const content = "Quick question";

      const systemContext: string | undefined = undefined;
      if (systemContext && mockSpan) {
        mockSpan.log({ input: { user: sanitizeText(content), system: systemContext } });
      }
      expect(mockSpan.log).not.toHaveBeenCalled();

      // When systemContext is an empty string, guard also skips
      const emptyContext = "";
      if (emptyContext && mockSpan) {
        mockSpan.log({ input: { user: sanitizeText(content), system: emptyContext } });
      }
      expect(mockSpan.log).not.toHaveBeenCalled();
    });

    it("redacts secrets in system context but does not truncate", async () => {
      const { redact } = await import("../../shared/observability/redact.js");
      const systemContext = "Use token sk-supersecretkey12345678901234567890 for auth";
      const result = redact(systemContext);
      expect(result).not.toContain("sk-supersecretkey12345678901234567890");
      expect(result).toContain("[REDACTED]");
      // No truncation -- system context can be longer than BT_MAX_TEXT_LENGTH
      const longContext = "x".repeat(10000);
      expect(redact(longContext)).toHaveLength(10000);
    });

    it("redacts OpenAI legacy, project, and service account keys", async () => {
      const { redact } = await import("../../shared/observability/redact.js");
      const keys = [
        "sk-abc123def456ghi789jklmnop",
        "sk-proj-abc123def456ghi789jklmnop",
        "sk-svcacct-abc123def456ghi789jklmnop",
        "sk-proj-abc123_def456-ghi789jklmnop",
      ];

      for (const key of keys) {
        const result = redact(`Incorrect API key provided: ${key}`);
        expect(result).not.toContain(key);
        expect(result).toBe("Incorrect API key provided: [REDACTED]");
      }
    });

    it("does not redact short OpenAI key prefix mentions", async () => {
      const { redact } = await import("../../shared/observability/redact.js");
      const value = "Use a key that starts with sk-proj- or sk-svcacct-";

      expect(redact(value)).toBe(value);
    });

    it("redacts injected secret shell references from Braintrust text", async () => {
      const { sanitizeText } = await import("../../apps/sandbox-bridge/src/services/braintrust.js");
      const text = [
        "Authorization: Bearer $GITHUB_USER_TOKEN",
        "clone with ${GITHUB_CLONE_TOKEN}",
        "forward $OPENAI_API_KEY to the helper",
        "forward $ARCANIST_OPENAI_API_KEY to the helper",
        "curl -H 'Authorization: Bearer $SANDBOX_AUTH_TOKEN'",
        "TOKEN_ENCRYPTION_KEY=${TOKEN_ENCRYPTION_KEY}",
        "$(env | grep TOKEN)",
      ].join("\n");

      const result = sanitizeText(text);

      expect(result).not.toContain("$GITHUB_USER_TOKEN");
      expect(result).not.toContain("${GITHUB_CLONE_TOKEN}");
      expect(result).not.toContain("$OPENAI_API_KEY");
      expect(result).not.toContain("$ARCANIST_OPENAI_API_KEY");
      expect(result).not.toContain("$SANDBOX_AUTH_TOKEN");
      expect(result).not.toContain("${TOKEN_ENCRYPTION_KEY}");
      expect(result).not.toContain("$(env | grep TOKEN)");
      expect(result).toContain("[REDACTED]");
    });

    it("redacts narrow generic assignment and authorization secret references", async () => {
      const { redact } = await import("../../shared/observability/redact.js");
      const text = [
        "export CI_SECRET=$CI_SECRET",
        "SOME_API_KEY=${CUSTOM_KEY}",
        "Authorization: Bearer $TOKEN",
        "Authorization: Basic ${PASSWORD}",
        "Authorization: Bearer ${MY_TOKEN_V2_PROD}",
      ].join("\n");

      const result = redact(text);

      expect(result).not.toContain("CI_SECRET=$CI_SECRET");
      expect(result).not.toContain("SOME_API_KEY=${CUSTOM_KEY}");
      expect(result).not.toContain("Authorization: Bearer $TOKEN");
      expect(result).not.toContain("Authorization: Basic ${PASSWORD}");
      expect(result).not.toContain("Authorization: Bearer ${MY_TOKEN_V2_PROD}");
      expect(result.match(/\[REDACTED\]/g)).toHaveLength(5);
    });

    it("preserves assignment delimiters and redacts quoted values containing spaces", async () => {
      const { redact } = await import("../../shared/observability/redact.js");

      const result = redact("prefix CI_SECRET=\"pass phrase\" OTHER_TOKEN=$OTHER_TOKEN;API_KEY='two words' suffix");

      expect(result).toBe("prefix [REDACTED] [REDACTED];[REDACTED] suffix");
      expect(result).not.toContain("pass phrase");
      expect(result).not.toContain("two words");
    });

    it("redacts database connection strings and common database URL assignments", async () => {
      const { redact } = await import("../../shared/observability/redact.js");
      const text = [
        "database_url=postgres://user:pass@localhost:5432/app",
        "DATABASE_URL='postgresql://user:pass@db.example/app'",
        "MONGODB_URI=mongodb+srv://user:pass@example.mongodb.net/app",
        "redis://:pass@localhost:6379/0",
      ].join("\n");

      const result = redact(text);

      expect(result).not.toContain("postgres://user:pass");
      expect(result).not.toContain("postgresql://user:pass");
      expect(result).not.toContain("mongodb+srv://user:pass");
      expect(result).not.toContain("redis://:pass");
      expect(result.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(4);
    });

    it("does not redact longer variable names sharing an injected secret prefix", async () => {
      const { redact } = await import("../../shared/observability/redact.js");
      const value = "echo $TOKEN_ENCRYPTION_KEY_SUFFIX and ${GITHUB_USER_TOKEN_BACKUP}";

      expect(redact(value)).toBe(value);
    });

    it("does not redact ordinary uppercase words outside secret contexts", async () => {
      const { redact } = await import("../../shared/observability/redact.js");
      const value = "TODO: REVIEW TOKEN handling, SECRET naming, and API KEY docs before merging";

      expect(redact(value)).toBe(value);
    });

    it("does not redact prose that merely mentions a token/api key before a long identifier", async () => {
      const { redact } = await import("../../shared/observability/redact.js");
      // A UUID, git SHA, or filename following the word "token"/"api key" is not an assignment and
      // must survive — the generic backstops now require a `:`/`=` delimiter, not a bare space.
      const value = [
        "request token 550e8400-e29b-41d4-a716-446655440000 was accepted",
        "the api key rotation_procedure_documentation_v2 lives in the wiki",
        "cache token estimation_algorithm_final_revision handled here",
      ].join("\n");

      expect(redact(value)).toBe(value);
    });

    it("still redacts opaque token/api key assignments via the generic backstops", async () => {
      const { redact } = await import("../../shared/observability/redact.js");
      const result = redact(
        [
          "token: abcdefghijklmnopqrstuvwxyz123456",
          "api_key=abcdefghijklmnop123456",
          '"token":"opaquevalue1234567890abcd"',
        ].join("\n"),
      );

      expect(result).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
      expect(result).not.toContain("abcdefghijklmnop123456");
      expect(result).not.toContain("opaquevalue1234567890abcd");
      expect(result.match(/\[REDACTED\]/g)).toHaveLength(3);
    });

    it("redacts secret references in Datadog log object fields", async () => {
      const { redactObject } = await import("../../shared/observability/redact.js");

      const result = redactObject({
        msg: "Authorization: Bearer $GITHUB_USER_TOKEN",
        command: "$(env | grep TOKEN)",
        metadata: {
          note: "SOME_PASSWORD=$PASSWORD",
          safe: "TOKEN appears as a plain word",
        },
      });

      expect(result.msg).toBe("[REDACTED]");
      expect(result.command).toBe("[REDACTED]");
      expect(result.metadata).toMatchObject({
        note: "[REDACTED]",
        safe: "TOKEN appears as a plain word",
      });
    });
  });

  describe("tool output fidelity (redact then attach)", () => {
    it("fullRedactedToolOutput returns null for small results (the inline preview already holds them)", async () => {
      const { fullRedactedToolOutput } = await import("../../apps/sandbox-bridge/src/services/braintrust.js");
      expect(fullRedactedToolOutput("short result")).toBeNull();
      expect(fullRedactedToolOutput({ ok: true, rows: 3 })).toBeNull();
    });

    it("fullRedactedToolOutput returns the complete, untruncated, redacted output for large results", async () => {
      const { fullRedactedToolOutput } = await import("../../apps/sandbox-bridge/src/services/braintrust.js");
      const secret = `ghp_${"a".repeat(36)}`;
      const big = `HEAD_MARKER ${"x".repeat(5000)} ${secret} TAIL_MARKER`;

      const full = fullRedactedToolOutput(big);

      expect(full).not.toBeNull();
      // Untruncated: both the head and the tail survive (no length cap dropped the tail).
      expect(full).toContain("HEAD_MARKER");
      expect(full).toContain("TAIL_MARKER");
      expect(full).not.toContain("[truncated");
      // The secret is masked and never emitted verbatim.
      expect(full).toContain("[REDACTED]");
      expect(full).not.toContain(secret);
      // Full-length payload, far beyond the inline preview cap.
      expect((full as string).length).toBeGreaterThan(4000);
    });

    it("fullOutputAttachment returns null for small results and without an initialized logger", async () => {
      const { fullOutputAttachment } = await import("../../apps/sandbox-bridge/src/services/braintrust.js");
      // Small result: preview already holds it, no attachment.
      expect(fullOutputAttachment("small")).toBeNull();
      // Large result but no Braintrust module initialized: preview alone lands, no attachment.
      expect(fullOutputAttachment("y".repeat(200_000))).toBeNull();
    });

    it("fullOutputAttachment returns the complete redacted output as an Attachment once initialized", async () => {
      process.env.CONTROL_PLANE_URL = "https://cp.test.trycycloid.com";
      process.env.SESSION_ID = "sess-abc";
      process.env.SANDBOX_AUTH_TOKEN = "sbx-token-1";
      class FakeAttachment {
        params: { data: Blob; filename: string; contentType: string };
        constructor(params: { data: Blob; filename: string; contentType: string }) {
          this.params = params;
        }
      }
      vi.doMock("braintrust", () => ({
        initLogger: vi.fn(() => ({ startSpan: vi.fn(), log: vi.fn() })),
        flush: vi.fn(),
        Attachment: FakeAttachment,
      }));

      const { initBraintrust, fullOutputAttachment } =
        await import("../../apps/sandbox-bridge/src/services/braintrust.js");
      await initBraintrust();

      const secret = `ghp_${"b".repeat(36)}`;
      const big = `HEAD ${"z".repeat(5000)} ${secret} TAIL`;

      const att = fullOutputAttachment(big) as FakeAttachment | null;

      expect(att).toBeInstanceOf(FakeAttachment);
      expect(att!.params.filename).toBe("tool-output.txt");
      expect(att!.params.contentType).toBe("text/plain");
      const text = await att!.params.data.text();
      // The attachment carries the COMPLETE (untruncated) redacted text; secret masked.
      expect(text).toContain("HEAD");
      expect(text).toContain("TAIL");
      expect(text).toContain("[REDACTED]");
      expect(text).not.toContain(secret);
    });

    it("endSpan nests the full-output attachment under metadata (Braintrust drops unknown top-level keys)", async () => {
      process.env.CONTROL_PLANE_URL = "https://cp.test.trycycloid.com";
      process.env.SESSION_ID = "sess-abc";
      process.env.SANDBOX_AUTH_TOKEN = "sbx-token-1";
      class FakeAttachment {
        params: { data: Blob; filename: string; contentType: string };
        constructor(params: { data: Blob; filename: string; contentType: string }) {
          this.params = params;
        }
      }
      vi.doMock("braintrust", () => ({
        initLogger: vi.fn(() => ({ startSpan: vi.fn(), log: vi.fn() })),
        flush: vi.fn(),
        Attachment: FakeAttachment,
      }));

      const { initBraintrust } = await import("../../apps/sandbox-bridge/src/services/braintrust.js");
      await initBraintrust();
      const { ToolPartTracker } = await import("../../apps/sandbox-bridge/src/trackers/tool-part-tracker.js");

      const logged: Record<string, unknown>[] = [];
      const child = {
        id: "tool:bash",
        startSpan: () => child,
        log: (d: Record<string, unknown>) => logged.push(d),
        end: () => {},
      };
      const parent = { id: "p", log: () => {}, end: () => {}, startSpan: () => child };
      const tracker = new ToolPartTracker({
        getActiveBtPromptSpan: () => parent as never,
        getSessionId: () => "s",
        getSandboxId: () => "sbx",
        getPromptId: () => "p",
        getAgentSessionId: () => "a",
        log: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} } as never,
      });

      const secret = `ghp_${"c".repeat(36)}`;
      const big = `HEAD ${"z".repeat(5000)} ${secret} TAIL`;
      tracker.startSpan("call-1", "bash", { command: "rg pattern ." });
      tracker.endSpan("call-1", "completed", 12, 5000, big);

      expect(logged).toHaveLength(1);
      const entry = logged[0] as { output: unknown; metadata: Record<string, unknown> };
      // Inline preview: bounded string (NOT the raw payload).
      expect(typeof entry.output).toBe("string");
      expect((entry.output as string).length).toBeLessThan(big.length);
      // The attachment is nested under metadata (a recognized field) — NOT a dropped top-level key.
      expect(entry.metadata.status).toBe("completed");
      expect(entry.metadata.fullOutput).toBeInstanceOf(FakeAttachment);
      expect("output_full" in logged[0]).toBe(false);
      // And the attachment holds the complete redacted text.
      const text = await (entry.metadata.fullOutput as FakeAttachment).params.data.text();
      expect(text).toContain("TAIL");
      expect(text).toContain("[REDACTED]");
      expect(text).not.toContain(secret);
    });
  });
});
