import { beforeEach, describe, expect, it, vi } from "vitest";

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

const sentryCaptureException = vi.fn();
vi.mock("@sentry/cloudflare", () => ({
  instrumentDurableObjectWithSentry: (_optionsCallback: unknown, DurableObjectClass: unknown) => DurableObjectClass,
  withSentry: (_optionsCallback: unknown, handler: unknown) => handler,
  setTag: () => {},
  setUser: () => {},
  captureException: (...args: unknown[]) => sentryCaptureException(...args),
}));

const awsFetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
vi.mock("aws4fetch", () => ({
  AwsClient: class {
    fetch(url: string, init?: RequestInit): Promise<Response> {
      return awsFetchMock(url, init);
    }
  },
}));

const mockPostStructuredEventToDd = vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true);
vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
}));

import {
  deleteS3Objects,
  getArtifact,
  listSessionArchiveKeys,
} from "../../apps/control-plane-worker/src/services/archive";

function createEnv() {
  return {
    S3_ACCESS_KEY_ID: "access-key",
    S3_SECRET_ACCESS_KEY: "secret-key",
    S3_SESSION_BUCKET: "artifact-bucket",
    S3_REGION: "us-east-1",
  };
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
}

describe("archive service getArtifact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null for a real S3 404 miss without logging an error", async () => {
    awsFetchMock.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    const log = createLogger();

    const result = await getArtifact(createEnv() as never, "sess-1", "artifact-1", "shot.png", log as never);

    expect(result).toBeNull();
    expect(log.error).not.toHaveBeenCalled();
    expect(sentryCaptureException).not.toHaveBeenCalled();
  });

  it("throws and logs when S3 returns an unexpected status", async () => {
    awsFetchMock.mockResolvedValueOnce(new Response("denied", { status: 403 }));
    const log = createLogger();

    await expect(getArtifact(createEnv() as never, "sess-1", "artifact-1", "shot.png", log as never)).rejects.toThrow(
      "S3 artifact fetch failed with status 403",
    );

    expect(log.error).toHaveBeenCalledWith(
      { sessionId: "sess-1", artifactId: "artifact-1", filename: "shot.png", status: 403 },
      "S3 artifact fetch failed",
    );
    expect(sentryCaptureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { operation: "s3GetArtifact", sessionId: "sess-1" },
    });
  });

  it("throws and logs when the fetch itself errors", async () => {
    const transportError = new TypeError("fetch failed");
    awsFetchMock.mockRejectedValueOnce(transportError);
    const log = createLogger();

    await expect(getArtifact(createEnv() as never, "sess-1", "artifact-1", "shot.png", log as never)).rejects.toThrow(
      "fetch failed",
    );

    expect(log.error).toHaveBeenCalledWith(
      { sessionId: "sess-1", artifactId: "artifact-1", filename: "shot.png", error: "TypeError: fetch failed" },
      "S3 artifact fetch threw",
    );
    expect(sentryCaptureException).toHaveBeenCalledWith(transportError, {
      tags: { operation: "s3GetArtifact", sessionId: "sess-1" },
    });
  });
});

describe("archive service offboarding S3 helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists session archive keys across S3 pages", async () => {
    awsFetchMock
      .mockResolvedValueOnce(
        new Response(
          `<ListBucketResult><Contents><Key>sessions/sess-1/a&amp;b.txt</Key></Contents><NextContinuationToken>next</NextContinuationToken></ListBucketResult>`,
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(`<ListBucketResult><Contents><Key>sessions/sess-1/c.txt</Key></Contents></ListBucketResult>`, {
          status: 200,
        }),
      );

    const keys = await listSessionArchiveKeys(createEnv() as never, "sess-1", createLogger() as never);

    expect(keys).toEqual(["sessions/sess-1/a&b.txt", "sessions/sess-1/c.txt"]);
    expect(String(awsFetchMock.mock.calls[0]![0])).toContain("prefix=sessions%2Fsess-1%2F");
    expect(String(awsFetchMock.mock.calls[1]![0])).toContain("continuation-token=next");
  });

  it("deletes S3 objects and reports per-key errors", async () => {
    awsFetchMock.mockResolvedValueOnce(
      new Response(
        `<DeleteResult><Deleted><Key>sessions/sess-1/ok.txt</Key></Deleted><Error><Key>sessions/sess-1/bad.txt</Key><Code>AccessDenied</Code></Error></DeleteResult>`,
        { status: 200 },
      ),
    );

    const result = await deleteS3Objects(
      createEnv() as never,
      ["sessions/sess-1/ok.txt", "sessions/sess-1/bad.txt"],
      createLogger() as never,
    );

    expect(result).toEqual({
      deletedKeys: ["sessions/sess-1/ok.txt"],
      failedKeys: ["sessions/sess-1/bad.txt"],
    });
    expect(String(awsFetchMock.mock.calls[0]![0])).toContain("?delete");
    expect((awsFetchMock.mock.calls[0]![1] as RequestInit).method).toBe("POST");
  });
});
