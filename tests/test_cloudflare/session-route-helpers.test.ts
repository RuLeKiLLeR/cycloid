import { describe, expect, it } from "vitest";

import {
  hasOversizedPlatformLlmContentLength,
  parsePlatformLlmBrokerBody,
} from "../../apps/control-plane-worker/src/routes/sessions/platform-llm-parser";
import {
  parsePromptFilePaths,
  parseSkillsPayload,
  parseUploadedFilesPayload,
  parseUploadedImagesPayload,
} from "../../apps/control-plane-worker/src/routes/sessions/prompt-upload-parser";
import {
  parseArtifactFilenameQuery,
  parseSessionEventsQuery,
  parseSessionListQuery,
  parseSessionReplayRequest,
  parseSessionWebSocketQuery,
} from "../../apps/control-plane-worker/src/routes/sessions/query-helpers";

describe("session route helper parsers", () => {
  it("parses session list query params through the shared request helpers", () => {
    const request = new Request(
      "https://app.test/api/sessions?status=%20running%20&scope=%20business%20&cursor=%20cur%20&limit=90&q=%20bug%20&repo=%20owner/repo%20",
    );

    expect(parseSessionListQuery(request)).toEqual({
      statusFilter: "running",
      scope: "business",
      pagination: { cursor: "cur", limit: 90 },
      search: { query: "bug", repo: "owner/repo" },
    });
  });

  it("normalizes session event queries to durable-object-safe values", () => {
    const request = new Request("https://app.test/api/sessions/s-1/events?limit=5000", {
      headers: { "last-event-id": "event-42" },
    });

    expect(parseSessionEventsQuery(request)).toEqual({ afterSequence: 42, limit: 1000 });
  });

  it("fails replay parsing visibly on malformed input", () => {
    const request = new Request("https://app.test/api/sessions/s-1/events/history?before_sequence=4&prompt_id=p-1");

    const result = parseSessionReplayRequest(request);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected replay parse to fail");
    expect(result.response.status).toBe(400);
  });

  it("parses websocket queries for sandbox and authenticated clients", () => {
    const sandboxRequest = new Request("https://app.test/api/sessions/s-1/ws?type=sandbox&sandboxId=sbox-1");
    expect(parseSessionWebSocketQuery(sandboxRequest)).toEqual({
      ok: true,
      value: { isSandbox: true, sandboxId: "sbox-1", afterSequence: 0 },
    });

    const authRequest = new Request("https://app.test/api/sessions/s-1/ws?afterSequence=7");
    expect(parseSessionWebSocketQuery(authRequest)).toEqual({
      ok: true,
      value: { isSandbox: false, sandboxId: "", afterSequence: 7 },
    });
  });

  it("rejects malformed websocket afterSequence values", async () => {
    const request = new Request("https://app.test/api/sessions/s-1/ws?afterSequence=oops");

    const result = parseSessionWebSocketQuery(request);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected websocket parse to fail");
    expect(result.response.status).toBe(400);
    await expect(result.response.json()).resolves.toMatchObject({
      error: expect.stringContaining("afterSequence"),
    });
  });

  it("parses artifact filenames and prompt file paths", async () => {
    const filename = parseArtifactFilenameQuery(new Request("https://app.test/path?filename=trace.log"));
    expect(filename).toEqual({ ok: true, value: "trace.log" });

    expect(parsePromptFilePaths(["src/index.ts", "src/index.ts", "   "])).toEqual({
      ok: true,
      value: ["src/index.ts"],
    });

    expect(parsePromptFilePaths(["file..backup.txt", "..config", "nested/..keep"])).toEqual({
      ok: true,
      value: ["file..backup.txt", "..config", "nested/..keep"],
    });

    const invalid = parsePromptFilePaths(["../secret.txt"]);
    expect(invalid.ok).toBe(false);
    if (invalid.ok) throw new Error("Expected invalid prompt files");
    await expect(invalid.response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Invalid file path"),
    });

    const nestedTraversal = parsePromptFilePaths(["foo/../bar.txt"]);
    expect(nestedTraversal.ok).toBe(false);
    if (nestedTraversal.ok) throw new Error("Expected nested traversal prompt files");
    await expect(nestedTraversal.response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Invalid file path"),
    });
  });

  it("parses prompt upload payloads and rejects invalid entries", async () => {
    expect(parseSkillsPayload(["review-spec", "review-spec"])).toEqual({
      ok: true,
      value: ["review-spec"],
    });

    expect(parseUploadedFilesPayload([{ name: "notes.md", content: "# Notes" }])).toEqual({
      ok: true,
      value: [{ name: "notes.md", content: "# Notes" }],
    });

    expect(parseUploadedImagesPayload([{ name: "screen.png", mediaType: "image/png", data: "YWJj" }])).toEqual({
      ok: true,
      value: [{ name: "screen.png", mediaType: "image/png", data: "YWJj" }],
    });

    const invalidSkill = parseSkillsPayload(["bad skill"]);
    expect(invalidSkill.ok).toBe(false);
    if (invalidSkill.ok) throw new Error("Expected invalid skill");
    await expect(invalidSkill.response.json()).resolves.toMatchObject({ error: "Invalid skill name" });
  });
});

describe("platform LLM route parser", () => {
  it("rejects oversized content-length before reading the body", () => {
    const request = new Request("https://app.test/api/sessions/s-1/platform-llm/prompt-preparation", {
      headers: { "content-length": String(10_000_000) },
    });

    expect(hasOversizedPlatformLlmContentLength(request)).toBe(true);
  });

  it("parses a valid broker body and rejects wrong phases", async () => {
    const valid = await parsePlatformLlmBrokerBody(
      new Request("https://app.test/path", {
        method: "POST",
        body: JSON.stringify({
          callType: "review_loop_triage",
          phase: "prompt_preparation",
          input: {
            repo: "trycycloid/cycloid",
            prNumber: 1,
            headSha: "abc123",
            items: [
              {
                sourceId: "comment:1",
                kind: "comment",
                authorLogin: "reviewer",
                authorType: "User",
                location: null,
                body: "Fix this",
              },
            ],
          },
        }),
      }),
      "prompt_preparation",
    );
    expect(valid).toEqual({
      ok: true,
      value: {
        body: {
          callType: "review_loop_triage",
          phase: "prompt_preparation",
          input: {
            repo: "trycycloid/cycloid",
            prNumber: 1,
            headSha: "abc123",
            items: [
              {
                sourceId: "comment:1",
                kind: "comment",
                authorLogin: "reviewer",
                authorType: "User",
                location: null,
                body: "Fix this",
              },
            ],
          },
        },
        bytes: expect.any(Number),
      },
    });

    const invalid = await parsePlatformLlmBrokerBody(
      new Request("https://app.test/path", {
        method: "POST",
        body: JSON.stringify({
          callType: "review_loop_triage",
          phase: "post_execution",
          input: {},
        }),
      }),
      "prompt_preparation",
    );
    expect(invalid.ok).toBe(false);
    if (invalid.ok) throw new Error("Expected invalid phase");
    expect(invalid.response.status).toBe(400);
  });
});
