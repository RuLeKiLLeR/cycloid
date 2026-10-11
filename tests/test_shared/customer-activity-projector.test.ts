import { describe, expect, it } from "vitest";

import { projectCustomerActivityEvents } from "../../shared/transcript/customer-activity-projector.js";
import type { ActivityEvent } from "../../shared/transcript/projector.js";

describe("customer activity projector", () => {
  it("caps long detail lists with an overflow counter", () => {
    const events: ActivityEvent[] = Array.from({ length: 7 }, (_, i) => ({
      type: "tool_call",
      id: `read-${i}`,
      tool: "read",
      summary: "read",
      input: { file_path: `src/file-${i}.ts` },
      promptId: "p-1",
    }));

    const [activity] = projectCustomerActivityEvents(events);
    if (activity?.type !== "customer_activity") throw new Error("expected customer_activity");

    expect(activity.count).toBe(7);
    expect(activity.details).toEqual([
      { tool: "read", content: "src/file-0.ts" },
      { tool: "read", content: "src/file-1.ts" },
      { tool: "read", content: "src/file-2.ts" },
      { tool: "read", content: "src/file-3.ts" },
      { tool: "read", content: "src/file-4.ts" },
    ]);
    expect(activity.overflow).toBe(2);
    expect(activity.summary).toBe("Looked at src/file-0.ts (+6 more)");
  });

  it("keeps user-visible messages, reasoning, and questions while hiding raw tool details", () => {
    const events: ActivityEvent[] = [
      { type: "reasoning", id: "r-1", text: "internal thought", promptId: "p-1" },
      { type: "text", id: "t-1", text: "I found the issue.", promptId: "p-1" },
      {
        type: "tool_call",
        id: "bash-1",
        tool: "bash",
        summary: "npm test",
        input: { command: "npm test" },
        promptId: "p-1",
      },
      { type: "question", id: "q-1", question: "Proceed?", answer: null, promptId: "p-1" },
    ];

    const timeline = projectCustomerActivityEvents(events);

    expect(timeline).toEqual([
      { type: "reasoning", id: "r-1", text: "internal thought", promptId: "p-1" },
      { type: "text", id: "t-1", text: "I found the issue.", promptId: "p-1" },
      {
        type: "customer_activity",
        id: "customer-verify-bash-1-bash-1",
        category: "verify",
        title: "Ran targeted checks",
        summary: "Ran npm test",
        status: "completed",
        count: 1,
        details: [{ tool: "bash", content: "npm test" }],
        promptId: "p-1",
      },
      { type: "question", id: "q-1", question: "Proceed?", answer: null, promptId: "p-1" },
    ]);
  });

  it("uses generic tool inputs for unknown command details instead of repeating the tool name", () => {
    const events: ActivityEvent[] = [
      {
        type: "tool_call",
        id: "datadog-1",
        tool: "DATADOG.SEARCH_DATADOG_LOGS",
        summary: "datadog.search_datadog_logs",
        input: { query: "service:api status:error" },
        promptId: "p-1",
      },
    ];

    expect(projectCustomerActivityEvents(events)).toEqual([
      {
        type: "customer_activity",
        id: "customer-command-datadog-1-datadog-1",
        category: "command",
        title: "Ran supporting commands",
        summary: "Ran service:api status:error",
        status: "completed",
        count: 1,
        details: [{ tool: "datadog.search_datadog_logs", content: "service:api status:error" }],
        promptId: "p-1",
      },
    ]);
  });

  it("uses trace IDs for unknown namespaced tools when query-style fields are absent", () => {
    const events: ActivityEvent[] = [
      {
        type: "tool_call",
        id: "datadog-trace-1",
        tool: "datadog.get_datadog_trace",
        summary: "datadog.get_datadog_trace",
        input: { traceId: "1234567890" },
        promptId: "p-1",
      },
    ];

    expect(projectCustomerActivityEvents(events)).toEqual([
      {
        type: "customer_activity",
        id: "customer-command-datadog-trace-1-datadog-trace-1",
        category: "command",
        title: "Ran supporting commands",
        summary: "Ran 1234567890",
        status: "completed",
        count: 1,
        details: [{ tool: "datadog.get_datadog_trace", content: "1234567890" }],
        promptId: "p-1",
      },
    ]);
  });

  it("strips a namespaced tool prefix from fallback summaries", () => {
    const events: ActivityEvent[] = [
      {
        type: "tool_call",
        id: "datadog-summary-1",
        tool: "datadog.search_datadog_logs",
        summary: "datadog.search_datadog_logs ran a query",
        input: { limit: 10 },
        promptId: "p-1",
      },
    ];

    expect(projectCustomerActivityEvents(events)).toEqual([
      {
        type: "customer_activity",
        id: "customer-command-datadog-summary-1-datadog-summary-1",
        category: "command",
        title: "Ran supporting commands",
        summary: "Ran ran a query",
        status: "completed",
        count: 1,
        details: [{ tool: "datadog.search_datadog_logs", content: "ran a query" }],
        promptId: "p-1",
      },
    ]);
  });

  it("uses the strongest status from grouped tool calls", () => {
    const events: ActivityEvent[] = [
      {
        type: "tool_call",
        id: "read-1",
        tool: "read",
        summary: "read",
        toolStatus: "completed",
        promptId: "p-1",
      },
      {
        type: "tool_call",
        id: "grep-1",
        tool: "grep",
        summary: "grep",
        toolStatus: "error",
        promptId: "p-1",
      },
    ];

    expect(projectCustomerActivityEvents(events)).toMatchObject([
      {
        type: "customer_activity",
        category: "inspect",
        status: "error",
        count: 2,
      },
    ]);
  });

  it("treats command-category tool failures as completed customer activity", () => {
    const events: ActivityEvent[] = [
      {
        type: "tool_call",
        id: "ls-1",
        tool: "bash",
        summary: "ls missing-dir",
        input: { command: "ls missing-dir" },
        toolStatus: "error",
        failure: {
          category: "command",
          phase: "command",
          safeSummary: "No such file or directory",
          diagnosticsRedacted: true,
        },
        promptId: "p-1",
      },
    ];

    expect(projectCustomerActivityEvents(events)).toMatchObject([
      {
        type: "customer_activity",
        category: "inspect",
        status: "completed",
        count: 1,
      },
    ]);
  });

  it("keeps real tool failures as error customer activity", () => {
    const events: ActivityEvent[] = [
      {
        type: "tool_call",
        id: "push-1",
        tool: "bash",
        summary: "git push",
        input: { command: "git push" },
        toolStatus: "error",
        failure: {
          category: "auth",
          phase: "auth",
          safeSummary: "Authentication failed",
          diagnosticsRedacted: true,
        },
        promptId: "p-1",
      },
    ];

    expect(projectCustomerActivityEvents(events)).toMatchObject([
      {
        type: "customer_activity",
        category: "git",
        status: "error",
        count: 1,
      },
    ]);
  });

  it("does not let a benign command failure poison a grouped command bucket", () => {
    const events: ActivityEvent[] = [
      {
        type: "tool_call",
        id: "ls-1",
        tool: "bash",
        summary: "ls src",
        input: { command: "ls src" },
        toolStatus: "completed",
        promptId: "p-1",
      },
      {
        type: "tool_call",
        id: "sed-1",
        tool: "bash",
        summary: "sed missing file",
        input: { command: "sed -n '1,20p' missing-file.ts" },
        toolStatus: "error",
        failure: {
          category: "command",
          phase: "command",
          safeSummary: "No such file or directory",
          diagnosticsRedacted: true,
        },
        promptId: "p-1",
      },
    ];

    expect(projectCustomerActivityEvents(events)).toMatchObject([
      {
        type: "customer_activity",
        category: "inspect",
        status: "completed",
        count: 2,
      },
    ]);
  });

  it("keeps a grouped bucket in error when it has both benign and real failures", () => {
    const events: ActivityEvent[] = [
      {
        type: "tool_call",
        id: "ls-1",
        tool: "bash",
        summary: "ls missing-dir",
        input: { command: "ls missing-dir" },
        toolStatus: "error",
        failure: {
          category: "command",
          phase: "command",
          safeSummary: "No such file or directory",
          diagnosticsRedacted: true,
        },
        promptId: "p-1",
      },
      {
        type: "tool_call",
        id: "grep-1",
        tool: "bash",
        summary: "grep private file",
        input: { command: "grep secret private-file" },
        toolStatus: "error",
        failure: {
          category: "auth",
          phase: "auth",
          safeSummary: "Authentication failed",
          diagnosticsRedacted: true,
        },
        promptId: "p-1",
      },
    ];

    expect(projectCustomerActivityEvents(events)).toMatchObject([
      {
        type: "customer_activity",
        category: "inspect",
        status: "error",
        count: 2,
      },
    ]);
  });

  it("does not merge promptless tool calls across implicit boundaries", () => {
    const events: ActivityEvent[] = [
      { type: "tool_call", id: "read-1", tool: "read", summary: "read first" },
      { type: "tool_call", id: "grep-1", tool: "grep", summary: "grep second" },
    ];

    expect(projectCustomerActivityEvents(events)).toMatchObject([
      { type: "customer_activity", category: "inspect", count: 1 },
      { type: "customer_activity", category: "inspect", count: 1 },
    ]);
  });

  it("drops agent_timeline observability events from the transcript", () => {
    const events: ActivityEvent[] = [
      {
        type: "agent_timeline",
        id: "atl-1",
        eventType: "tools.run",
        source: "observed",
        observer: "bridge",
        summary: "Observed 4 tool call(s) across 3 tool type(s).",
        promptId: "p-1",
      },
      {
        type: "tool_call",
        id: "read-1",
        tool: "read",
        summary: "read",
        input: { file_path: "src/foo.ts" },
        promptId: "p-1",
      },
    ];

    const timeline = projectCustomerActivityEvents(events);

    expect(timeline).toEqual([
      {
        type: "customer_activity",
        id: "customer-inspect-read-1-read-1",
        category: "inspect",
        title: "Inspected code",
        summary: "Looked at src/foo.ts",
        status: "completed",
        count: 1,
        details: [{ tool: "read", content: "src/foo.ts" }],
        promptId: "p-1",
      },
    ]);
  });

  it("keeps customer-visible publish timeline events while dropping noisy timeline events", () => {
    const events: ActivityEvent[] = [
      {
        type: "agent_timeline",
        id: "atl-tools",
        eventType: "tools.run",
        source: "observed",
        observer: "bridge",
        status: "completed",
        summary: "Observed 4 tool call(s).",
        promptId: "p-1",
      },
      {
        type: "agent_timeline",
        id: "atl-typecheck",
        eventType: "publish_gate.result",
        source: "observed",
        observer: "bridge",
        status: "started",
        summary: "Running pre-publish typecheck before opening the pull request.",
        promptId: "p-1",
      },
      {
        type: "agent_timeline",
        id: "atl-push",
        eventType: "git.push",
        source: "observed",
        observer: "bridge",
        status: "completed",
        summary: "Pushed the session branch to origin.",
        promptId: "p-1",
      },
      {
        type: "agent_timeline",
        id: "atl-pr",
        eventType: "pr.open",
        source: "observed",
        observer: "control_plane",
        status: "started",
        summary: "Opening pull request on GitHub.",
        promptId: "p-1",
      },
    ];

    expect(projectCustomerActivityEvents(events)).toEqual([
      expect.objectContaining({ id: "atl-typecheck", eventType: "publish_gate.result" }),
      expect.objectContaining({ id: "atl-push", eventType: "git.push" }),
      expect.objectContaining({ id: "atl-pr", eventType: "pr.open" }),
    ]);
  });

  it("drops the synthetic apply_patch tool_call that fans out from a Codex file_change", () => {
    // The sandbox bridge emits both a `patch` event (with file paths) and an
    // `apply_patch` tool_call for every Codex `file_change` item. The patch
    // event already carries the file list, so the apply_patch row would
    // otherwise duplicate it as a useless "apply_patch apply_patch" entry.
    const events: ActivityEvent[] = [
      {
        type: "patch",
        id: "patch-1",
        files: ["src/a.ts", "src/b.ts"],
        promptId: "p-1",
      },
      {
        type: "tool_call",
        id: "apply-patch-1",
        tool: "apply_patch",
        summary: "",
        input: { path: "src/a.ts, src/b.ts" },
        toolStatus: "completed",
        promptId: "p-1",
      },
    ];

    const [activity, ...rest] = projectCustomerActivityEvents(events);
    expect(rest).toEqual([]);
    if (activity?.type !== "customer_activity") throw new Error("expected customer_activity");

    expect(activity.count).toBe(1);
    expect(activity.details).toEqual([
      { tool: "patch", content: "src/a.ts" },
      { tool: "patch", content: "src/b.ts" },
    ]);
  });

  it("does not double-count duplicates that exceed the detail cap", () => {
    const events: ActivityEvent[] = [
      ...Array.from({ length: 5 }, (_, i) => ({
        type: "tool_call" as const,
        id: `read-${i}`,
        tool: "read",
        summary: "read",
        input: { file_path: `src/file-${i}.ts` },
        promptId: "p-1",
      })),
      // Three more reads, all duplicates of file-0 — must collapse to overflow=0,
      // not inflate to overflow=3.
      ...Array.from({ length: 3 }, (_, i) => ({
        type: "tool_call" as const,
        id: `dup-${i}`,
        tool: "read",
        summary: "read",
        input: { file_path: "src/file-0.ts" },
        promptId: "p-1",
      })),
    ];

    const [activity] = projectCustomerActivityEvents(events);
    if (activity?.type !== "customer_activity") throw new Error("expected customer_activity");

    expect(activity.details.length).toBe(5);
    expect(activity.overflow).toBeUndefined();
  });

  it("deduplicates on the full content, not the truncated display value", () => {
    const long = "src/file-".padEnd(150, "x");
    const events: ActivityEvent[] = [
      {
        type: "tool_call",
        id: "read-1",
        tool: "read",
        summary: "read",
        input: { file_path: `${long}-A.ts` },
        promptId: "p-1",
      },
      {
        type: "tool_call",
        id: "read-2",
        tool: "read",
        summary: "read",
        input: { file_path: `${long}-B.ts` },
        promptId: "p-1",
      },
    ];

    const [activity] = projectCustomerActivityEvents(events);
    if (activity?.type !== "customer_activity") throw new Error("expected customer_activity");

    // Two distinct paths must remain two distinct details, even though their
    // display strings are both truncated to the same prefix.
    expect(activity.count).toBe(2);
    expect(activity.details.length).toBe(2);
  });

  describe("secret redaction in detail content", () => {
    function singleDetail(input: Record<string, unknown>, tool = "bash"): string {
      const events: ActivityEvent[] = [{ type: "tool_call", id: "t-1", tool, summary: "ran", input, promptId: "p-1" }];
      const [activity] = projectCustomerActivityEvents(events);
      if (activity?.type !== "customer_activity") throw new Error("expected customer_activity");
      return activity.details[0]?.content ?? "";
    }

    it("redacts URL basic-auth credentials", () => {
      const out = singleDetail({ command: "git push https://bob:supersecret123@github.com/foo/bar.git main" });
      expect(out).toContain("[redacted]@github.com");
      expect(out).not.toContain("supersecret123");
      expect(out).not.toContain("bob:");
    });

    it("redacts GitHub personal access tokens", () => {
      const out = singleDetail({
        command: "curl -H 'Authorization: token ghp_abcdefghijklmnopqrst1234' https://api.github.com",
      });
      expect(out).not.toContain("ghp_abcdefghijklmnopqrst1234");
      expect(out).toMatch(/redacted/);
    });

    it("redacts Bearer tokens", () => {
      const out = singleDetail({
        command:
          'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghij" https://api.example.com',
      });
      expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
      expect(out).toMatch(/redacted/);
    });

    it("redacts AWS access keys", () => {
      const out = singleDetail({ command: "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE aws s3 ls" });
      expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    });

    it("redacts env-var assignments where the name suggests a secret", () => {
      const out = singleDetail({ command: "OPENAI_API_KEY=sk-proj-abc123def456ghi789jkl012 node run.js" });
      expect(out).not.toContain("sk-proj-abc123def456ghi789jkl012");
      expect(out).toContain("OPENAI_API_KEY=[redacted]");
    });

    it("redacts query-string credentials in URLs", () => {
      const out = singleDetail({ url: "https://api.example.com/v1/data?api_key=abc123def456&cursor=10" }, "web_fetch");
      expect(out).not.toContain("abc123def456");
      expect(out).toContain("api_key=[redacted]");
      // Non-secret query params survive.
      expect(out).toContain("cursor=10");
    });

    it("redacts credentials in git remote URLs", () => {
      const out = singleDetail(
        { remote: "https://x-access-token:ghp_abcdefghijklmnopqrstuvwx@github.com/foo/bar.git" },
        "git_push",
      );
      expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwx");
      expect(out).toContain("[redacted]@github.com");
    });

    // ARC-1136: the generic rule stops at "/" in the password; scheme-scoped rule
    // catches non-DB schemes (amqp/ftp) whose passwords contain a literal "/".
    it("redacts non-DB URL credentials whose password contains '/'", () => {
      const out = singleDetail({ command: "amqp://admin:Aa1/bC2d@host:5672/vhost" });
      expect(out).toContain("amqp://[redacted]@host");
      expect(out).not.toContain("Aa1/bC2d");
      expect(out).not.toContain("admin:");
    });

    it("leaves credential-free URLs with a port and a later '@' untouched", () => {
      const url = "https://api.example.com:8080/v1/users?cc=x@y.com&ok=1";
      const out = singleDetail({ url }, "web_fetch");
      expect(out).toContain(url);
    });

    // The scheme-scoped rule must not mistake `host:port/path?x@y` for `user:pass@`.
    it("leaves credential-free amqp URLs with a port and '@'-in-query untouched", () => {
      const url = "amqp://host:5672/vhost?cc=x@y.com";
      const out = singleDetail({ command: url });
      expect(out).toContain(url);
    });

    it("leaves benign content untouched", () => {
      const out = singleDetail({ file_path: "apps/ui/src/Layout.tsx" }, "read");
      expect(out).toBe("apps/ui/src/Layout.tsx");
    });
  });

  describe("Codex /bin/bash -lc wrapper stripping", () => {
    function singleActivity(input: Record<string, unknown>): {
      detail: string;
      category: string;
    } {
      const events: ActivityEvent[] = [
        { type: "tool_call", id: "t-1", tool: "bash", summary: "", input, promptId: "p-1" },
      ];
      const [activity] = projectCustomerActivityEvents(events);
      if (activity?.type !== "customer_activity") throw new Error("expected customer_activity");
      return { detail: activity.details[0]?.content ?? "", category: activity.category };
    }

    it("strips the wrapper from a simple double-quoted command", () => {
      const { detail, category } = singleActivity({ command: '/bin/bash -lc "git status --short"' });
      expect(detail).toBe("git status --short");
      expect(category).toBe("git");
    });

    it("strips the wrapper from a single-quoted command", () => {
      const { detail, category } = singleActivity({ command: "/bin/bash -lc 'rg --files | head -5'" });
      expect(detail).toBe("rg --files | head -5");
      expect(category).toBe("inspect");
    });

    it("strips the wrapper from a complex Codex shell-quoted command", () => {
      // Real example from prod session d14e2169 — outer double quotes, inner
      // mixed single/double quotes that close and reopen the outer string.
      const command =
        "/bin/bash -lc \"rg --files | sed 's#\"'^#/#'\"' | awk -F/ '{print \"'$2}'\"' | sort | uniq -c | sort -nr | head -20\"";
      const { detail, category } = singleActivity({ command });
      expect(detail).toBe(
        "rg --files | sed 's#\"'^#/#'\"' | awk -F/ '{print \"'$2}'\"' | sort | uniq -c | sort -nr | head -20",
      );
      expect(category).toBe("inspect");
    });

    it("accepts the bare `bash -lc` form (no /bin/ prefix)", () => {
      const { detail } = singleActivity({ command: 'bash -lc "npm test"' });
      expect(detail).toBe("npm test");
    });

    it("leaves non-wrapper bash commands untouched", () => {
      const { detail, category } = singleActivity({ command: "npm test" });
      expect(detail).toBe("npm test");
      expect(category).toBe("verify");
    });

    it("strips the wrapper even when the body is unquoted", () => {
      const { detail } = singleActivity({ command: "/bin/bash -lc echo hello" });
      expect(detail).toBe("echo hello");
    });
  });

  describe("bash command classification does not over-match the word `test`", () => {
    function category(command: string): string {
      const events: ActivityEvent[] = [
        { type: "tool_call", id: "t-1", tool: "bash", summary: "", input: { command }, promptId: "p-1" },
      ];
      const [activity] = projectCustomerActivityEvents(events);
      if (activity?.type !== "customer_activity") throw new Error("expected customer_activity");
      return activity.category;
    }

    // A bare `test` token previously tagged any command containing the word as
    // "verify", reporting checks that never ran in the customer transcript.
    it.each([
      ["cat src/test.txt", "inspect"],
      ["ls test", "inspect"],
      ["mkdir test", "command"],
      ["cd test && npm i", "command"],
      ["rm -rf test", "command"],
    ])("classifies %s as %s, not verify", (command, expected) => {
      expect(category(command)).toBe(expected);
    });

    it.each(["npm test", "npm run test", "pnpm test", "yarn test", "vitest run", "pytest -q", "go test ./..."])(
      "still classifies the real test runner %s as verify",
      (command) => {
        expect(category(command)).toBe("verify");
      },
    );
  });

  describe("bash command classification does not over-match lint/typecheck/tsc/build in paths and args", () => {
    function category(command: string): string {
      const events: ActivityEvent[] = [
        { type: "tool_call", id: "t-1", tool: "bash", summary: "", input: { command }, promptId: "p-1" },
      ];
      const [activity] = projectCustomerActivityEvents(events);
      if (activity?.type !== "customer_activity") throw new Error("expected customer_activity");
      return activity.category;
    }

    // ARC-1545: the bare `\b(lint|typecheck|tsc|build)\b` rule tagged inspection
    // commands whose paths/args merely contained these tokens as "verify",
    // rendering spurious "Ran targeted checks" cards for checks that never ran.
    it.each([
      ["cat build.log", "inspect"],
      ["ls build", "inspect"],
      ["mkdir build", "command"],
      ["rm -rf build", "command"],
      ["grep 'lint' package.json", "inspect"],
      ["cat typecheck-output.txt", "inspect"],
      ["echo 'running lint'", "command"],
      ["cat tsc-errors.txt", "inspect"],
      // Quoted shell separators must not create a false verify segment.
      ["grep 'foo && tsc' package.json", "inspect"],
      ["echo 'x; eslint .'", "command"],
    ])("classifies %s as %s, not verify", (command, expected) => {
      expect(category(command)).toBe(expected);
    });

    it.each([
      "npm run lint",
      "pnpm lint",
      "yarn typecheck",
      "npm run build",
      "npm -w app run build",
      "CI=1 npm run lint",
      "tsc --noEmit",
      "npx tsc --noEmit",
      "eslint .",
      "prettier --check .",
      "go build ./...",
      "cargo build",
      // A genuine check chained after an inspection command still counts.
      "git diff && npm run lint",
    ])("still classifies the real check %s as verify", (command) => {
      expect(category(command)).toBe("verify");
    });
  });
});
