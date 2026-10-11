import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("@sentry/cloudflare", () => ({
  instrumentDurableObjectWithSentry: (_optionsCallback: unknown, DurableObjectClass: unknown) => DurableObjectClass,
  withSentry: (_optionsCallback: unknown, handler: unknown) => handler,
  setTag: () => {},
  setUser: () => {},
  captureException: () => {},
}));

type LinearMutationResult = { success: boolean; externalId: string | null };

type LinearModule = {
  linkSessionToLinearIssue: (
    linearToken: string,
    linearIssueId: string,
    sessionId: string,
    frontendUrl: string,
    repoFullName?: string,
  ) => Promise<LinearMutationResult>;
  postLinearIssueComment: (linearToken: string, linearIssueId: string, body: string) => Promise<LinearMutationResult>;
  findLinearAttachmentExternalIdByUrl: (
    linearToken: string,
    linearIssueId: string,
    attachmentUrl: string,
  ) => Promise<string | null>;
  fetchLinearIssuePickupContext: (linearToken: string, linearIssueId: string) => Promise<unknown>;
  updateLinearIssueForPickup: (
    linearToken: string,
    linearIssueId: string,
    update: unknown,
  ) => Promise<LinearMutationResult>;
  selectLinearIssuePickupUpdate: (context: unknown) => unknown;
  pickupCommentBody: (sessionUrl: string) => string;
  extractLinearContextFromPrompt: (prompt: string) => { identifier: string; url: string } | null;
};

let linearMod: LinearModule;

describe("linkSessionToLinearIssue", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    vi.resetModules();
    const path: string = "../../apps/control-plane-worker/src/webhooks/linear";
    linearMod = (await import(path)) as unknown as LinearModule;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends attachmentCreate mutation with correct payload and captures the external id", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(
        JSON.stringify({ data: { attachmentCreate: { success: true, attachment: { id: "att_123" } } } }),
        { status: 200 },
      );
    };

    const result = await linearMod.linkSessionToLinearIssue(
      "lin-token-123",
      "issue-abc",
      "session-uuid-1234-5678",
      "https://app.trycycloid.com",
    );

    expect(result).toEqual({ success: true, externalId: "att_123" });
    expect(capturedUrl).toBe("https://api.linear.app/graphql");
    expect(capturedInit?.method).toBe("POST");

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer lin-token-123");
    expect(headers["content-type"]).toBe("application/json");

    const body = JSON.parse(capturedInit?.body as string);
    expect(body.query).toContain("attachmentCreate");
    // The query must select the entity id, else the external id is unrecoverable.
    expect(body.query).toContain("attachment { id }");
    expect(body.variables.input).toEqual({
      issueId: "issue-abc",
      title: "Cycloid session",
      subtitle: "session-",
      url: "https://app.trycycloid.com/sessions/session-uuid-1234-5678",
      iconUrl: "https://app.trycycloid.com/favicon.ico",
    });
  });

  it("succeeds with a null external id when the response omits attachment.id", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: { attachmentCreate: { success: true } } }), { status: 200 });

    const result = await linearMod.linkSessionToLinearIssue(
      "valid-token",
      "issue-xyz",
      "abcdefgh-1234",
      "https://custom.example.com",
    );

    expect(result).toEqual({ success: true, externalId: null });
  });

  it("returns failure when Linear API returns non-200", async () => {
    globalThis.fetch = async () => new Response("Unauthorized", { status: 401 });

    const result = await linearMod.linkSessionToLinearIssue(
      "bad-token",
      "issue-abc",
      "session-uuid-1234-5678",
      "https://app.trycycloid.com",
    );

    expect(result).toEqual({ success: false, externalId: null });
  });

  it("returns success when Linear API returns 200", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: { attachmentCreate: { success: true, attachment: { id: "att_9" } } } }), {
        status: 200,
      });

    const result = await linearMod.linkSessionToLinearIssue(
      "valid-token",
      "issue-xyz",
      "abcdefgh-1234",
      "https://custom.example.com",
    );

    expect(result).toEqual({ success: true, externalId: "att_9" });
  });

  it("returns failure when Linear attachmentCreate reports GraphQL errors", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          errors: [{ message: "invalid attachment" }],
          data: { attachmentCreate: { success: true } },
        }),
        { status: 200 },
      );

    const result = await linearMod.linkSessionToLinearIssue(
      "valid-token",
      "issue-xyz",
      "abcdefgh-1234",
      "https://custom.example.com",
    );

    expect(result).toEqual({ success: false, externalId: null });
  });

  it("constructs session URL from frontendUrl and sessionId", async () => {
    let capturedBody = "";
    globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ data: { attachmentCreate: { success: true } } }), { status: 200 });
    };

    await linearMod.linkSessionToLinearIssue("token", "issue-1", "my-session-id", "https://custom.domain.com");

    const body = JSON.parse(capturedBody);
    expect(body.variables.input.url).toBe("https://custom.domain.com/sessions/my-session-id");
  });

  it("uses first 8 chars of sessionId as subtitle", async () => {
    let capturedBody = "";
    globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ data: { attachmentCreate: { success: true } } }), { status: 200 });
    };

    await linearMod.linkSessionToLinearIssue("token", "issue-1", "abcdefgh-ijkl-mnop", "https://app.trycycloid.com");

    const body = JSON.parse(capturedBody);
    expect(body.variables.input.subtitle).toBe("abcdefgh");
  });

  it("includes the selected repo in the attachment title when provided", async () => {
    let capturedBody = "";
    globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ data: { attachmentCreate: { success: true } } }), { status: 200 });
    };

    await linearMod.linkSessionToLinearIssue(
      "token",
      "issue-1",
      "abcdefgh-ijkl-mnop",
      "https://app.trycycloid.com",
      "acme/widgets",
    );

    const body = JSON.parse(capturedBody);
    expect(body.variables.input.title).toBe("Cycloid session for acme/widgets");
  });
});

describe("postLinearIssueComment", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    vi.resetModules();
    const path: string = "../../apps/control-plane-worker/src/webhooks/linear";
    linearMod = (await import(path)) as unknown as LinearModule;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends commentCreate mutation with safe body text", async () => {
    let capturedBody = "";
    globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ data: { commentCreate: { success: true } } }), { status: 200 });
    };

    const result = await linearMod.postLinearIssueComment("token", "issue-1", "Add `repo=owner/repo`.");

    expect(result).toEqual({ success: true, externalId: null });
    const body = JSON.parse(capturedBody);
    expect(body.query).toContain("commentCreate");
    expect(body.query).toContain("comment { id }");
    expect(body.variables.input).toEqual({
      issueId: "issue-1",
      body: "Add `repo=owner/repo`.",
    });
  });

  it("returns failure when Linear API returns non-200", async () => {
    globalThis.fetch = async () => new Response("Unauthorized", { status: 401 });

    const result = await linearMod.postLinearIssueComment("bad-token", "issue-1", "Please clarify repo.");

    expect(result).toEqual({ success: false, externalId: null });
  });

  it("returns failure when Linear commentCreate reports an unsuccessful mutation", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: { commentCreate: { success: false } } }), { status: 200 });

    const result = await linearMod.postLinearIssueComment("token", "issue-1", "Please clarify repo.");

    expect(result).toEqual({ success: false, externalId: null });
  });
});

describe("findLinearAttachmentExternalIdByUrl", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    vi.resetModules();
    const path: string = "../../apps/control-plane-worker/src/webhooks/linear";
    linearMod = (await import(path)) as unknown as LinearModule;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns the id of the attachment whose url matches", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: {
            issue: {
              attachments: {
                nodes: [
                  { id: "att_other", url: "https://app.trycycloid.com/sessions/other" },
                  { id: "att_match", url: "https://app.trycycloid.com/sessions/sess-1" },
                ],
              },
            },
          },
        }),
        { status: 200 },
      );

    const id = await linearMod.findLinearAttachmentExternalIdByUrl(
      "token",
      "issue-1",
      "https://app.trycycloid.com/sessions/sess-1",
    );
    expect(id).toBe("att_match");
  });

  it("returns null when no attachment url matches", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: { issue: { attachments: { nodes: [] } } } }), { status: 200 });

    const id = await linearMod.findLinearAttachmentExternalIdByUrl(
      "token",
      "issue-1",
      "https://app.trycycloid.com/sessions/sess-1",
    );
    expect(id).toBeNull();
  });

  it("throws on transport error so the caller can treat it as transient", async () => {
    globalThis.fetch = async () => new Response("nope", { status: 500 });

    await expect(
      linearMod.findLinearAttachmentExternalIdByUrl("token", "issue-1", "https://app.trycycloid.com/sessions/sess-1"),
    ).rejects.toThrow();
  });
});

describe("Linear pickup mutations", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    vi.resetModules();
    linearMod = (await import("../../apps/control-plane-worker/src/webhooks/linear")) as unknown as LinearModule;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("selects the earliest started state and only assigns unassigned issues", () => {
    expect(
      linearMod.selectLinearIssuePickupUpdate({
        viewerId: "viewer",
        issue: {
          assigneeId: null,
          state: { id: "triage", type: "triage" },
          startedStates: [
            { id: "later", type: "started", position: 2 },
            { id: "earlier", type: "started", position: 1 },
          ],
          commentBodies: [],
        },
      }),
    ).toEqual({ stateId: "earlier", assigneeId: "viewer" });
  });

  it("parses pickup context and suppresses a comment when its session URL is present", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: {
            viewer: { id: "viewer" },
            issue: {
              assignee: null,
              state: { id: "triage", type: "triage" },
              team: { states: { nodes: [{ id: "started", type: "started", position: 0 }] } },
              comments: { nodes: [{ body: "Session: https://app.test/sessions/s1" }] },
            },
          },
        }),
        { status: 200 },
      );
    const context = await linearMod.fetchLinearIssuePickupContext("token", "issue");
    expect(context).toMatchObject({
      viewerId: "viewer",
      issue: { assigneeId: null, commentBodies: [expect.stringContaining("/s1")] },
    });
  });

  it("sends the issueUpdate mutation only for selected fields", async () => {
    let requestBody = "";
    globalThis.fetch = async (_input, init) => {
      requestBody = String(init?.body);
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200 });
    };
    await expect(
      linearMod.updateLinearIssueForPickup("token", "issue", { stateId: "started", assigneeId: null }),
    ).resolves.toEqual({
      success: true,
      externalId: null,
    });
    expect(JSON.parse(requestBody).variables).toEqual({ id: "issue", input: { stateId: "started" } });
  });

  it("uses the shared pickup copy", () => {
    expect(linearMod.pickupCommentBody("https://app.test/sessions/s1")).toBe(
      "Cycloid picked up this ticket and is working on it. Session: https://app.test/sessions/s1. A pull request will follow.",
    );
  });
});

describe("extractLinearContextFromPrompt", () => {
  beforeEach(async () => {
    vi.resetModules();
    const path: string = "../../apps/control-plane-worker/src/webhooks/linear";
    linearMod = (await import(path)) as unknown as LinearModule;
  });

  it("extracts context from a plain Linear URL", () => {
    const result = linearMod.extractLinearContextFromPrompt(
      "https://linear.app/cycloid2/issue/ARC-290/add-integration-tests",
    );
    expect(result).toEqual({
      identifier: "ARC-290",
      url: "https://linear.app/cycloid2/issue/ARC-290/add-integration-tests",
    });
  });

  it("extracts context when URL is embedded in text", () => {
    const result = linearMod.extractLinearContextFromPrompt(
      "Please fix https://linear.app/myteam/issue/PROJ-42/some-bug and deploy",
    );
    expect(result).toEqual({
      identifier: "PROJ-42",
      url: "https://linear.app/myteam/issue/PROJ-42/some-bug",
    });
  });

  it("strips trailing punctuation from URL", () => {
    const result = linearMod.extractLinearContextFromPrompt("Fix this: https://linear.app/team/issue/BUG-1/title.");
    expect(result).toEqual({
      identifier: "BUG-1",
      url: "https://linear.app/team/issue/BUG-1/title",
    });
  });

  it("strips trailing closing paren", () => {
    const result = linearMod.extractLinearContextFromPrompt("(see https://linear.app/team/issue/BUG-1/title)");
    expect(result).toEqual({
      identifier: "BUG-1",
      url: "https://linear.app/team/issue/BUG-1/title",
    });
  });

  it("returns null when no Linear URL is present", () => {
    expect(linearMod.extractLinearContextFromPrompt("fix the login bug")).toBeNull();
    expect(linearMod.extractLinearContextFromPrompt("https://github.com/org/repo")).toBeNull();
    expect(linearMod.extractLinearContextFromPrompt("")).toBeNull();
  });

  it("handles URL-only prompts", () => {
    const result = linearMod.extractLinearContextFromPrompt("https://linear.app/cycloid2/issue/ARC-123/my-ticket-slug");
    expect(result).toEqual({
      identifier: "ARC-123",
      url: "https://linear.app/cycloid2/issue/ARC-123/my-ticket-slug",
    });
  });

  it("extracts alphanumeric project keys (mirrors TICKET_KEY_SHAPE)", () => {
    const result = linearMod.extractLinearContextFromPrompt("https://linear.app/team/issue/A1-123/some-slug");
    expect(result).toEqual({
      identifier: "A1-123",
      url: "https://linear.app/team/issue/A1-123/some-slug",
    });
  });
});
