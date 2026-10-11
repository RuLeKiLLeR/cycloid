import { beforeEach, describe, expect, it, vi } from "vitest";

describe("notion dynamic tools", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("searches Notion pages by title", async () => {
    const { executeNotionSearchDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/notion-dynamic-tool.js");

    const fetchImpl = vi.fn(
      async (_input, init) =>
        new Response(
          JSON.stringify({
            results: [
              {
                object: "page",
                id: "page-1",
                url: "https://www.notion.so/page-1",
                in_trash: false,
                last_edited_time: "2026-05-12T12:00:00.000Z",
                properties: {
                  Name: {
                    type: "title",
                    title: [{ plain_text: "Meeting Notes" }],
                  },
                },
              },
            ],
            has_more: false,
            next_cursor: null,
          }),
          { status: 200 },
        ),
    );

    const result = await executeNotionSearchDynamicToolCall(
      { query: "meeting notes", pageSize: 2 },
      {
        env: { NOTION_ACCESS_TOKEN: "notion-token" },
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(result.success).toBe(true);
    const payload = JSON.parse(result.contentItems[0].text) as { results: Array<{ title: string }> };
    expect(payload.results[0]?.title).toBe("Meeting Notes");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const requestInit = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(requestInit?.body).toContain('"filter":{"property":"object","value":"page"}');
  });

  it("rejects invalid search input", async () => {
    const { executeNotionSearchDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/notion-dynamic-tool.js");

    await expect(
      executeNotionSearchDynamicToolCall(
        { query: "x", pageSize: 50, extra: true },
        { env: { NOTION_ACCESS_TOKEN: "notion-token" } },
      ),
    ).resolves.toEqual({
      success: false,
      errorCode: "invalid_input",
      contentItems: [{ type: "inputText", text: "Notion search received unsupported fields: extra." }],
    });
  });

  it("maps auth and not-found failures for get_block_children", async () => {
    const { executeNotionGetBlockChildrenDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/notion-dynamic-tool.js");

    await expect(
      executeNotionGetBlockChildrenDynamicToolCall(
        { blockId: "block-1" },
        {
          env: { NOTION_ACCESS_TOKEN: "notion-token" },
          fetchImpl: vi.fn(
            async () => new Response(JSON.stringify({ message: "nope" }), { status: 401 }),
          ) as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "token_expired" });

    await expect(
      executeNotionGetBlockChildrenDynamicToolCall(
        { blockId: "block-1" },
        {
          env: { NOTION_ACCESS_TOKEN: "notion-token" },
          fetchImpl: vi.fn(
            async () => new Response(JSON.stringify({ message: "missing" }), { status: 404 }),
          ) as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "not_found" });
  });

  it("maps request TimeoutError to cancelled", async () => {
    const { executeNotionSearchDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/notion-dynamic-tool.js");

    await expect(
      executeNotionSearchDynamicToolCall(
        { query: "meeting notes" },
        {
          env: { NOTION_ACCESS_TOKEN: "notion-token" },
          fetchImpl: vi.fn(async () => {
            throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
          }) as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "cancelled" });
  });

  it("maps a body-read TimeoutError to cancelled", async () => {
    const { executeNotionSearchDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/notion-dynamic-tool.js");

    await expect(
      executeNotionSearchDynamicToolCall(
        { query: "meeting notes" },
        {
          env: { NOTION_ACCESS_TOKEN: "notion-token" },
          fetchImpl: vi.fn(async () => {
            const response = new Response(null, { status: 200, statusText: "OK" });
            response.json = async () => {
              throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
            };
            return response;
          }) as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "cancelled" });
  });

  it("keeps a non-cancellation body-read error as upstream_error", async () => {
    const { executeNotionSearchDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/notion-dynamic-tool.js");

    const result = await executeNotionSearchDynamicToolCall(
      { query: "meeting notes" },
      {
        env: { NOTION_ACCESS_TOKEN: "notion-token" },
        fetchImpl: vi.fn(async () => {
          const response = new Response(null, { status: 500, statusText: "Server Error" });
          response.json = async () => {
            throw new SyntaxError("Unexpected end of JSON input");
          };
          return response;
        }) as typeof fetch,
      },
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("upstream_error");
  });

  it("reads nested block children with a depth cap", async () => {
    const { executeNotionGetBlockChildrenDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/notion-dynamic-tool.js");

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                object: "block",
                id: "block-1",
                type: "paragraph",
                has_children: true,
                in_trash: false,
                paragraph: { rich_text: [{ plain_text: "Parent" }] },
              },
            ],
            has_more: false,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                object: "block",
                id: "block-2",
                type: "to_do",
                has_children: false,
                in_trash: false,
                to_do: { rich_text: [{ plain_text: "Child" }] },
              },
            ],
            has_more: false,
          }),
          { status: 200 },
        ),
      );

    const result = await executeNotionGetBlockChildrenDynamicToolCall(
      { blockId: "page-1" },
      {
        env: { NOTION_ACCESS_TOKEN: "notion-token" },
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(result.success).toBe(true);
    const payload = JSON.parse(result.contentItems[0].text) as {
      children: Array<{ children?: Array<{ text: string }> }>;
    };
    expect(payload.children[0]?.children?.[0]?.text).toBe("Child");
  });

  it("paginates block children before recursing into nested blocks", async () => {
    const { executeNotionGetBlockChildrenDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/notion-dynamic-tool.js");

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                object: "block",
                id: "block-1",
                type: "paragraph",
                has_children: false,
                in_trash: false,
                paragraph: { rich_text: [{ plain_text: "First page" }] },
              },
            ],
            has_more: true,
            next_cursor: "cursor-2",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                object: "block",
                id: "block-2",
                type: "paragraph",
                has_children: false,
                in_trash: false,
                paragraph: { rich_text: [{ plain_text: "Second page" }] },
              },
            ],
            has_more: false,
            next_cursor: null,
          }),
          { status: 200 },
        ),
      );

    const result = await executeNotionGetBlockChildrenDynamicToolCall(
      { blockId: "page-1", pageSize: 1 },
      {
        env: { NOTION_ACCESS_TOKEN: "notion-token" },
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(result.success).toBe(true);
    const payload = JSON.parse(result.contentItems[0].text) as { children: Array<{ text: string }> };
    expect(payload.children.map((child) => child.text)).toEqual(["First page", "Second page"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain("start_cursor=cursor-2");
  });

  it("skips recursive child fetches when Notion omits a child block id", async () => {
    const { executeNotionGetBlockChildrenDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/notion-dynamic-tool.js");

    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                object: "block",
                type: "paragraph",
                has_children: true,
                in_trash: false,
                paragraph: { rich_text: [{ plain_text: "Parent without id" }] },
              },
            ],
            has_more: false,
            next_cursor: null,
          }),
          { status: 200 },
        ),
    );

    const result = await executeNotionGetBlockChildrenDynamicToolCall(
      { blockId: "page-1" },
      {
        env: { NOTION_ACCESS_TOKEN: "notion-token" },
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(result.success).toBe(true);
    const payload = JSON.parse(result.contentItems[0].text) as {
      children: Array<{ text: string; children?: unknown[] }>;
    };
    expect(payload.children[0]?.text).toBe("Parent without id");
    expect(payload.children[0]?.children).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
