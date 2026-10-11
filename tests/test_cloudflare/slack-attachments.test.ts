import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extractSlackAttachmentRefsFromEvent,
  extractSlackAttachmentRefsFromMessages,
  extractSlackFileIdsFromEvent,
  processSlackAttachments,
  processSlackAttachmentsFromMessages,
} from "../../apps/control-plane-worker/src/slack/attachments";

const originalFetch = globalThis.fetch;

type SlackFileFixture = {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  body?: BodyInit;
  url?: string;
  status?: number;
  extra?: Record<string, unknown>;
};

function mockSlackFileFetch(fixtures: SlackFileFixture[]) {
  const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const byUrl = new Map(
    fixtures.map((fixture) => [fixture.url ?? `https://files.slack.com/files-pri/T/${fixture.id}`, fixture]),
  );

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
    if (url.startsWith("https://slack.com/api/files.info")) {
      const fileId = new URL(url).searchParams.get("file");
      const fixture = fileId ? byId.get(fileId) : undefined;
      if (!fixture) {
        return Response.json({ ok: false, error: "file_not_found" });
      }
      return Response.json({
        ok: true,
        file: {
          id: fixture.id,
          name: fixture.name,
          mimetype: fixture.mimetype,
          size: fixture.size,
          url_private_download: fixture.url ?? `https://files.slack.com/files-pri/T/${fixture.id}`,
          ...fixture.extra,
        },
      });
    }

    const fixture = byUrl.get(url);
    if (!fixture) return new Response("not found", { status: 404 });
    return new Response(fixture.body ?? "", {
      status: fixture.status ?? 200,
      headers: { "content-length": String(fixture.size) },
    });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("Slack attachment intake", () => {
  it("extracts unique file ids from Slack files and attachments with a hard cap", () => {
    const event = {
      files: [{ id: "F001" }, { id: "F002" }, { id: "F001" }],
      attachments: Array.from({ length: 12 }, (_, index) => ({ file_id: `FA${index}` })),
    };
    const ids = extractSlackFileIdsFromEvent(event);
    const refs = extractSlackAttachmentRefsFromEvent(event);

    expect(ids).toHaveLength(10);
    expect(ids.slice(0, 3)).toEqual(["F001", "F002", "FA0"]);
    expect(refs).toEqual({ fileIds: ids, omittedCount: 4 });
  });

  it("converts Slack images into UploadedImage payloads", async () => {
    mockSlackFileFetch([
      {
        id: "FIMG",
        name: "screen.png",
        mimetype: "image/png",
        size: 4,
        body: new Uint8Array([137, 80, 78, 71]),
      },
    ]);

    const result = await processSlackAttachments("xoxb-test", { files: [{ id: "FIMG" }] });

    expect(result.skipped).toEqual([]);
    expect(result.uploadedFiles).toEqual([]);
    expect(result.uploadedImages).toEqual([
      {
        name: "screen.png",
        mediaType: "image/png",
        data: btoa(String.fromCharCode(137, 80, 78, 71)),
      },
    ]);
  });

  it("deduplicates file ids across thread messages", () => {
    expect(
      extractSlackAttachmentRefsFromMessages([
        { ts: "1", files: [{ id: "F001" }, { id: "F002" }] },
        { ts: "2", files: [{ id: "F002" }, { id: "F003" }] },
      ]),
    ).toEqual({ fileIds: ["F001", "F002", "F003"], omittedCount: 0 });
  });

  it("caps thread attachment processing after unique file ids", async () => {
    const fixtures = Array.from({ length: 11 }, (_, index) => ({
      id: `F${index}`,
      name: `image-${index}.png`,
      mimetype: "image/png",
      size: 4,
      body: new Uint8Array([137, 80, 78, 71]),
    }));
    mockSlackFileFetch(fixtures);

    const result = await processSlackAttachmentsFromMessages("xoxb-test", [
      { files: fixtures.slice(0, 6).map(({ id }) => ({ id })) },
      { files: fixtures.slice(5).map(({ id }) => ({ id })) },
    ]);

    expect(result.uploadedImages).toHaveLength(5);
    expect(result.skipped[0]).toMatchObject({ code: "too_many" });
    expect(globalThis.fetch).toHaveBeenCalledTimes(20);
  });

  it("processes a text attachment from a sibling message once", async () => {
    mockSlackFileFetch([
      {
        id: "FLOG",
        name: "trace.log",
        mimetype: "text/plain",
        size: 20,
        body: "stack trace line one",
      },
    ]);

    const result = await processSlackAttachmentsFromMessages("xoxb-test", [
      { files: [{ id: "FLOG" }] },
      { files: [{ id: "FLOG" }] },
    ]);

    expect(result.uploadedFiles).toEqual([{ name: "trace.log", content: "stack trace line one" }]);
    expect(result.uploadedImages).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("converts Slack text files into UploadedFile payloads", async () => {
    mockSlackFileFetch([
      {
        id: "FTXT",
        name: "trace.log",
        mimetype: "application/octet-stream",
        size: 20,
        body: "stack trace line one",
      },
    ]);

    const result = await processSlackAttachments("xoxb-test", { files: [{ id: "FTXT" }] });

    expect(result.skipped).toEqual([]);
    expect(result.uploadedFiles).toEqual([{ name: "trace.log", content: "stack trace line one" }]);
    expect(result.uploadedImages).toEqual([]);
  });

  it("classifies skips without downloading supported files when downloads are disabled", async () => {
    mockSlackFileFetch([
      {
        id: "FTXT",
        name: "trace.log",
        mimetype: "text/plain",
        size: 20,
        body: "stack trace line one",
      },
      {
        id: "FPDF",
        name: "deck.pdf",
        mimetype: "application/pdf",
        size: 2000,
      },
    ]);

    const result = await processSlackAttachments(
      "xoxb-test",
      { files: [{ id: "FTXT" }, { id: "FPDF" }] },
      { downloadSupported: false },
    );

    expect(result.uploadedFiles).toEqual([]);
    expect(result.uploadedImages).toEqual([]);
    expect(result.skipped).toMatchObject([{ filename: "deck.pdf", code: "unsupported_type" }]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("skips unsupported file types before downloading content", async () => {
    mockSlackFileFetch([
      {
        id: "FPDF",
        name: "deck.pdf",
        mimetype: "application/pdf",
        size: 2000,
      },
    ]);

    const result = await processSlackAttachments("xoxb-test", { files: [{ id: "FPDF" }] });

    expect(result.uploadedFiles).toEqual([]);
    expect(result.uploadedImages).toEqual([]);
    expect(result.skipped).toMatchObject([{ filename: "deck.pdf", code: "unsupported_type" }]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("skips oversized attachments from metadata before downloading content", async () => {
    mockSlackFileFetch([
      {
        id: "FBIG",
        name: "big.log",
        mimetype: "text/plain",
        size: 102401,
      },
    ]);

    const result = await processSlackAttachments("xoxb-test", { files: [{ id: "FBIG" }] });

    expect(result.skipped).toMatchObject([{ filename: "big.log", code: "too_large" }]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("skips invalid size metadata before downloading content", async () => {
    mockSlackFileFetch([
      {
        id: "FSIZE",
        name: "unknown.log",
        mimetype: "text/plain",
        size: 10,
        extra: { size: "10" },
      },
    ]);

    const result = await processSlackAttachments("xoxb-test", { files: [{ id: "FSIZE" }] });

    expect(result.uploadedFiles).toEqual([]);
    expect(result.skipped).toMatchObject([{ filename: "Slack attachment", code: "metadata_failed" }]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("skips Slack API and download failures without exposing private URLs", async () => {
    mockSlackFileFetch([
      {
        id: "FBAD",
        name: "bad.txt",
        mimetype: "text/plain",
        size: 12,
        status: 403,
      },
    ]);

    const result = await processSlackAttachments("xoxb-test", {
      files: [{ id: "FMISSING" }, { id: "FBAD" }],
    });

    expect(result.skipped).toMatchObject([
      { filename: "Slack attachment", code: "metadata_failed" },
      { filename: "bad.txt", code: "download_failed" },
    ]);
    expect(result.skipped.map((skip) => skip.reason).join(" ")).not.toContain("files.slack.com");
  });

  it("skips invalid UTF-8 text files", async () => {
    mockSlackFileFetch([
      {
        id: "FUTF8",
        name: "bad.txt",
        mimetype: "text/plain",
        size: 1,
        body: new Uint8Array([0xff]),
      },
    ]);

    const result = await processSlackAttachments("xoxb-test", { files: [{ id: "FUTF8" }] });

    expect(result.uploadedFiles).toEqual([]);
    expect(result.skipped).toMatchObject([{ filename: "bad.txt", code: "utf8_decode_failed" }]);
  });

  it("skips external Slack files instead of fetching arbitrary external URLs", async () => {
    mockSlackFileFetch([
      {
        id: "FREMOTE",
        name: "remote.txt",
        mimetype: "text/plain",
        size: 10,
        url: "https://example.com/remote.txt",
        extra: { is_external: true, mode: "external" },
      },
    ]);

    const result = await processSlackAttachments("xoxb-test", { files: [{ id: "FREMOTE" }] });

    expect(result.skipped).toMatchObject([{ filename: "remote.txt", code: "external_file" }]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
