import { createHash } from "node:crypto";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as doDb from "../../../apps/control-plane-worker/src/session/do-db";
import type {
  DesktopActionPathRow,
  DesktopActionPathSnapshotResponse,
  DesktopActionScreenshotRef,
  RegisterDesktopActionPathRowRequest,
  RegisterDesktopActionPathRowResponse,
} from "../../../shared/types/desktop-action-path";
import { createFakeState, mockCloudflareWorkers, mockSentryCloudflare, seedSandboxState, seedSession } from "./helpers";

const { postStructuredEventToDdMock } = vi.hoisted(() => ({
  postStructuredEventToDdMock: vi.fn(async () => true),
}));

vi.mock("../../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: postStructuredEventToDdMock,
}));

mockCloudflareWorkers();
mockSentryCloudflare();

type WorkerModule = {
  SessionDO: new (
    state: unknown,
    env: unknown,
  ) => {
    fetch(request: Request): Promise<Response>;
  };
};

type BatchLimitedStorage = {
  get: (<T>(key: string) => Promise<T | undefined>) & ((keys: string[]) => Promise<Map<string, unknown>>);
  put: (<T>(key: string, value: T) => Promise<void>) & (<T>(entries: Record<string, T>) => Promise<void>);
  delete: ((key: string) => Promise<boolean>) & ((keys: string[]) => Promise<boolean>);
};

type StorageBatchCalls = {
  get: number[];
  put: number[];
  delete: number[];
};

type RawDesktopActionStorage = BatchLimitedStorage & {
  sql: SqlStorage;
  _get(key: string): unknown;
};

type DesktopActionScreenshotQuotaEntry = {
  actionId: string;
  artifactId: string;
  bytes: number;
  desktopActionSeq: number;
};

const SESSION_ID = "session-desktop-action-path";
const SANDBOX_TOKEN = "sandbox-token";
const DURABLE_OBJECT_STORAGE_BATCH_LIMIT = 128;
const DESKTOP_ACTION_SCREENSHOT_MAX_BYTES = 256 * 1024 * 1024;
const DESKTOP_ACTION_SCREENSHOT_QUOTA_BACKFILL_VERSION = "v2";
const DESKTOP_ACTION_ROW_LIMIT = 500;

function desktopActionPathIndexKey(): string {
  return `desktop_action_path:${SESSION_ID}:index`;
}

function desktopActionScreenshotQuotaIndexKey(): string {
  return `desktop_action_path:${SESSION_ID}:screenshot_quota_index`;
}

function desktopActionScreenshotQuotaBackfillKey(): string {
  return `desktop_action_path:${SESSION_ID}:screenshot_quota_backfilled`;
}

function desktopActionPathSeqKey(): string {
  return `desktop_action_path:${SESSION_ID}:seq`;
}

function desktopActionPathRowKey(actionId: string): string {
  return `desktop_action_path:${SESSION_ID}:row:${actionId}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function makeRow(
  actionId: string,
  overrides: Partial<RegisterDesktopActionPathRowRequest> = {},
): RegisterDesktopActionPathRowRequest {
  return {
    actionId,
    promptId: "prompt-1",
    phase: "agent",
    action: "click",
    label: `Click ${actionId}`,
    status: "completed",
    activeWindowTitle: "App",
    warningCode: null,
    errorCode: null,
    screenshot: null,
    createdAtMs: 1000,
    updatedAtMs: 1000,
    ...overrides,
  };
}

function screenshot(actionId: string, overrides: Partial<DesktopActionScreenshotRef> = {}): DesktopActionScreenshotRef {
  return {
    actionId,
    artifactId: `artifact-${actionId}`,
    kind: "desktop_action_screenshot" as const,
    artifactAccessVisibility: "private" as const,
    label: `Screenshot ${actionId}`,
    viewUrl: "caller-supplied-view-url-is-ignored",
    width: 1280,
    height: 720,
    bytes: 12345,
    captureMode: "full_display" as const,
    displayName: ":99",
    capturedAtMs: 1100,
    status: "available" as const,
    ...overrides,
  };
}

function seedDesktopActionScreenshotArtifact(
  state: { storage: { sql: SqlStorage } },
  actionId: string,
  overrides: Partial<doDb.SessionArtifactRow> = {},
) {
  doDb.insertSessionArtifact(state.storage.sql, {
    artifactId: `artifact-${actionId}`,
    sessionId: SESSION_ID,
    promptId: "prompt-1",
    type: "screenshot",
    url: `https://app.trycycloid.com/api/sessions/${SESSION_ID}/artifacts/artifact-${actionId}/desktop.png`,
    metadata: {
      label: `Screenshot ${actionId}`,
      filename: `${actionId}.png`,
      contentType: "image/png",
      access: { visibility: "private", expiresAt: null, revokedAt: null },
      kind: "desktop_action_screenshot",
      actionId,
      phase: "agent",
      scenarioId: "scenario-1",
    },
    createdAt: 1000,
    ...overrides,
  });
}

function storedDesktopActionRow(
  actionId: string,
  desktopActionSeq: number,
  overrides: Partial<DesktopActionPathRow> = {},
): DesktopActionPathRow {
  return {
    ...makeRow(actionId),
    sessionId: SESSION_ID,
    desktopActionSeq,
    ...overrides,
  };
}

async function seedLegacyDesktopActionRows(state: { storage: unknown }, rows: DesktopActionPathRow[]): Promise<void> {
  const storage = state.storage as RawDesktopActionStorage;
  const entries: Record<string, unknown> = {
    [desktopActionPathIndexKey()]: rows.map((row) => row.actionId),
    [desktopActionPathSeqKey()]: rows.length,
  };
  for (const row of rows) {
    seedDesktopActionScreenshotArtifact({ storage }, row.actionId);
    entries[desktopActionPathRowKey(row.actionId)] = row;
  }
  await storage.put(entries);
}

function rawStorageValue<T>(state: { storage: unknown }, key: string): T {
  return (state.storage as RawDesktopActionStorage)._get(key) as T;
}

function rawQuotaIndex(state: { storage: unknown }): DesktopActionScreenshotQuotaEntry[] {
  return rawStorageValue<DesktopActionScreenshotQuotaEntry[]>(state, desktopActionScreenshotQuotaIndexKey());
}

function enforceStorageBatchLimit(
  storage: BatchLimitedStorage,
  maxEntries = DURABLE_OBJECT_STORAGE_BATCH_LIMIT,
): StorageBatchCalls {
  const calls: StorageBatchCalls = { get: [], put: [], delete: [] };
  const originalGet = storage.get.bind(storage) as (keyOrKeys: string | string[]) => Promise<unknown>;
  const originalPut = storage.put.bind(storage) as (
    keyOrEntries: string | Record<string, unknown>,
    value?: unknown,
  ) => Promise<void>;
  const originalDelete = storage.delete.bind(storage) as (keyOrKeys: string | string[]) => Promise<boolean>;

  storage.get = (async (keyOrKeys: string | string[]) => {
    const entryCount = Array.isArray(keyOrKeys) ? keyOrKeys.length : 1;
    calls.get.push(entryCount);
    if (entryCount > maxEntries) throw new Error(`storage.get batch exceeded ${maxEntries}: ${entryCount}`);
    return originalGet(keyOrKeys);
  }) as BatchLimitedStorage["get"];

  storage.put = (async (keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
    const entryCount = typeof keyOrEntries === "string" ? 1 : Object.keys(keyOrEntries).length;
    calls.put.push(entryCount);
    if (entryCount > maxEntries) throw new Error(`storage.put batch exceeded ${maxEntries}: ${entryCount}`);
    return originalPut(keyOrEntries, value);
  }) as BatchLimitedStorage["put"];

  storage.delete = (async (keyOrKeys: string | string[]) => {
    const entryCount = Array.isArray(keyOrKeys) ? keyOrKeys.length : 1;
    calls.delete.push(entryCount);
    if (entryCount > maxEntries) throw new Error(`storage.delete batch exceeded ${maxEntries}: ${entryCount}`);
    return originalDelete(keyOrKeys);
  }) as BatchLimitedStorage["delete"];

  return calls;
}

describe("SessionDO desktop action path", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    workerModule = (await import("../../../apps/control-plane-worker/src/index.js")) as WorkerModule;
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    postStructuredEventToDdMock.mockClear().mockResolvedValue(true);
  });

  function createInstance() {
    const state = createFakeState();
    seedSession(state.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "owner-1",
      businessId: "biz-1",
      repoOwner: "trycycloid",
      repoName: "cycloid",
    });
    seedSandboxState(state.storage, {
      sessionId: SESSION_ID,
      status: "ready",
      sandboxAuthTokenHash: sha256(SANDBOX_TOKEN),
    });
    const instance = new workerModule.SessionDO(state, { WORKER_ENV: "test" }) as unknown as {
      fetch(request: Request): Promise<Response>;
      broadcast: (message: unknown) => void;
    };
    return { state, instance };
  }

  async function register(
    instance: { fetch(request: Request): Promise<Response> },
    row: RegisterDesktopActionPathRowRequest,
  ) {
    const response = await instance.fetch(
      new Request("https://internal/session/desktop/action-path/register", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SANDBOX_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(row),
      }),
    );
    return {
      response,
      body: response.ok ? ((await response.json()) as RegisterDesktopActionPathRowResponse) : null,
    };
  }

  async function snapshot(instance: { fetch(request: Request): Promise<Response> }) {
    const response = await instance.fetch(
      new Request("https://internal/session/desktop/action-path", {
        headers: {
          "x-auth-user-id": "owner-1",
          "x-auth-can-access-all": "false",
        },
      }),
    );
    return (await response.json()) as DesktopActionPathSnapshotResponse;
  }

  it("registers action rows idempotently and preserves monotonic desktopActionSeq", async () => {
    const { state, instance } = createInstance();
    const broadcast = vi.fn();
    instance.broadcast = broadcast;

    const first = await register(instance, makeRow("action-a", { updatedAtMs: 1000 }));
    expect(first.response.status).toBe(200);
    expect(first.body?.row.desktopActionSeq).toBe(1);
    expect(first.body?.idempotent).toBe(false);

    const staleDuplicate = await register(
      instance,
      makeRow("action-a", { label: "Stale duplicate", updatedAtMs: 900 }),
    );
    expect(staleDuplicate.response.status).toBe(200);
    expect(staleDuplicate.body?.row.label).toBe("Click action-a");
    expect(staleDuplicate.body?.updated).toBe(false);
    expect(staleDuplicate.body?.idempotent).toBe(true);

    seedDesktopActionScreenshotArtifact(state, "action-a");
    const screenshotFill = await register(
      instance,
      makeRow("action-a", { screenshot: screenshot("action-a"), updatedAtMs: 900 }),
    );
    expect(screenshotFill.response.status).toBe(200);
    expect(screenshotFill.body?.row.desktopActionSeq).toBe(1);
    expect(screenshotFill.body?.row.screenshot?.artifactId).toBe("artifact-action-a");
    expect(screenshotFill.body?.row.screenshot?.artifactAccessVisibility).toBe("private");
    expect(screenshotFill.body?.row.screenshot?.viewUrl).toBe(
      `/api/sessions/${SESSION_ID}/artifacts/artifact-action-a/view?filename=action-a.png`,
    );
    expect(screenshotFill.body?.row.screenshot?.viewUrl).not.toContain("artifactToken=");
    expect(screenshotFill.body?.updated).toBe(true);

    const second = await register(instance, makeRow("action-b", { action: "type", updatedAtMs: 1200 }));
    expect(second.body?.row.desktopActionSeq).toBe(2);

    const body = await snapshot(instance);
    expect(body.rows.map((row) => [row.actionId, row.desktopActionSeq])).toEqual([
      ["action-a", 1],
      ["action-b", 2],
    ]);
    expect(body.maxDesktopActionSeq).toBe(2);
    expect(broadcast).toHaveBeenCalledTimes(4);
    expect(postStructuredEventToDdMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: "desktop.action_path_persist",
        sessionIdHash: sha256(SESSION_ID),
        actionId: "action-a",
        success: true,
      }),
    );
    expect(JSON.stringify(postStructuredEventToDdMock.mock.calls)).not.toContain(SESSION_ID);
  });

  it("fills a stale screenshot without clobbering newer row metadata", async () => {
    const { instance } = createInstance();

    const first = await register(
      instance,
      makeRow("action-stale-fill", {
        label: "Current action metadata",
        status: "completed",
        activeWindowTitle: "Current app",
        warningCode: "warn-current",
        createdAtMs: 900,
        updatedAtMs: 2000,
      }),
    );
    expect(first.response.status).toBe(200);

    const fill = await register(
      instance,
      makeRow("action-stale-fill", {
        label: "Stale screenshot payload",
        status: "action_failed",
        activeWindowTitle: "Stale app",
        warningCode: null,
        errorCode: "stale-error",
        screenshot: screenshot("action-stale-fill", { artifactId: "artifact-stale-fill" }),
        createdAtMs: 1000,
        updatedAtMs: 1500,
      }),
    );

    expect(fill.response.status).toBe(200);
    expect(fill.body?.updated).toBe(true);
    expect(fill.body?.row).toMatchObject({
      desktopActionSeq: 1,
      label: "Current action metadata",
      status: "completed",
      activeWindowTitle: "Current app",
      warningCode: "warn-current",
      errorCode: null,
      createdAtMs: 900,
      updatedAtMs: 2000,
      screenshot: { artifactId: "artifact-stale-fill", status: "available" },
    });
  });

  it("preserves an existing screenshot when a newer row update omits one", async () => {
    const { instance } = createInstance();
    const existingScreenshot = screenshot("action-newer-no-screenshot", {
      artifactId: "artifact-existing",
      width: 1600,
      height: 900,
      bytes: 54321,
    });

    const first = await register(
      instance,
      makeRow("action-newer-no-screenshot", {
        label: "Original label",
        screenshot: existingScreenshot,
        updatedAtMs: 2000,
      }),
    );
    expect(first.response.status).toBe(200);

    const newer = await register(
      instance,
      makeRow("action-newer-no-screenshot", {
        label: "Newer label",
        status: "action_failed",
        errorCode: "newer-error",
        screenshot: null,
        updatedAtMs: 2500,
      }),
    );

    expect(newer.response.status).toBe(200);
    expect(newer.body?.updated).toBe(true);
    expect(newer.body?.row).toMatchObject({
      desktopActionSeq: 1,
      label: "Newer label",
      status: "action_failed",
      errorCode: "newer-error",
      updatedAtMs: 2500,
      screenshot: existingScreenshot,
    });
  });

  it("revokes the old artifact when replacing a same-action screenshot", async () => {
    const { state, instance } = createInstance();
    const actionId = "action-replace-screenshot";
    const oldArtifactId = "artifact-action-replace-screenshot-old";
    const newArtifactId = "artifact-action-replace-screenshot-new";

    seedDesktopActionScreenshotArtifact(state, actionId, { artifactId: oldArtifactId });
    const first = await register(
      instance,
      makeRow(actionId, {
        screenshot: screenshot(actionId, { artifactId: oldArtifactId }),
        updatedAtMs: 1000,
      }),
    );
    expect(first.response.status).toBe(200);

    seedDesktopActionScreenshotArtifact(state, actionId, { artifactId: newArtifactId, createdAt: 2000 });
    const replacement = await register(
      instance,
      makeRow(actionId, {
        label: "Replacement screenshot",
        screenshot: screenshot(actionId, { artifactId: newArtifactId, bytes: 67890 }),
        updatedAtMs: 2000,
      }),
    );

    expect(replacement.response.status).toBe(200);
    expect(replacement.body?.row.screenshot?.artifactId).toBe(newArtifactId);
    expect(doDb.getSessionArtifact(state.storage.sql, SESSION_ID, oldArtifactId)?.metadata?.access).toMatchObject({
      visibility: "private",
      revokedAt: expect.any(Number),
    });
    expect(doDb.getSessionArtifact(state.storage.sql, SESSION_ID, newArtifactId)?.metadata?.access).toMatchObject({
      visibility: "private",
      revokedAt: null,
    });
    expect(rawQuotaIndex(state)).toEqual([
      {
        actionId,
        artifactId: newArtifactId,
        bytes: 67890,
        desktopActionSeq: 1,
      },
    ]);
  });

  it("keeps snapshot recovery when broadcast fails after persistence", async () => {
    const { instance } = createInstance();
    instance.broadcast = vi.fn(() => {
      throw new Error("socket fanout failed");
    });

    const result = await register(instance, makeRow("action-recovered", { updatedAtMs: 2000 }));
    expect(result.response.status).toBe(200);

    const body = await snapshot(instance);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].actionId).toBe("action-recovered");
  });

  it("rejects malformed rows and missing sandbox auth", async () => {
    const { instance } = createInstance();
    const malformed = await register(instance, { ...makeRow("bad"), screenshot: { actionId: "other" } as never });
    expect(malformed.response.status).toBe(400);

    const missingAuth = await instance.fetch(
      new Request("https://internal/session/desktop/action-path/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(makeRow("action-no-auth")),
      }),
    );
    expect(missingAuth.status).toBe(401);
  });

  it("rejects available screenshot refs without a private desktop action artifact", async () => {
    const { instance } = createInstance();
    const missingArtifact = await register(
      instance,
      makeRow("missing-artifact", { screenshot: screenshot("missing-artifact") }),
    );
    expect(missingArtifact.response.status).toBe(400);

    const { state, instance: publicArtifactInstance } = createInstance();
    seedDesktopActionScreenshotArtifact(state, "public-artifact", {
      metadata: {
        label: "Public artifact",
        filename: "public.png",
        contentType: "image/png",
        access: { visibility: "public", expiresAt: Date.now() + 1000, revokedAt: null },
        kind: "desktop_action_screenshot",
        actionId: "public-artifact",
        phase: "agent",
        scenarioId: "scenario-1",
      },
    });
    const publicArtifact = await register(
      publicArtifactInstance,
      makeRow("public-artifact", { screenshot: screenshot("public-artifact") }),
    );
    expect(publicArtifact.response.status).toBe(400);
  });

  it("backfills legacy screenshot quota rows before eviction and pruning", async () => {
    const { state, instance } = createInstance();
    const legacyScreenshotBytes = 2 * 1024 * 1024;
    const retainedQuotaCount = DESKTOP_ACTION_SCREENSHOT_MAX_BYTES / legacyScreenshotBytes;
    const legacyRows = Array.from({ length: 650 }, (_, index) => {
      const actionId = `legacy-${index}`;
      return storedDesktopActionRow(actionId, index + 1, {
        screenshot: screenshot(actionId, { bytes: legacyScreenshotBytes }),
        createdAtMs: 1000 + index,
        updatedAtMs: 1000 + index,
      });
    });
    await seedLegacyDesktopActionRows(state, legacyRows);
    expect(rawStorageValue(state, desktopActionScreenshotQuotaIndexKey())).toBeUndefined();

    const batchCalls = enforceStorageBatchLimit(state.storage as unknown as BatchLimitedStorage);
    const currentActionId = "legacy-650";
    seedDesktopActionScreenshotArtifact(state, currentActionId);
    const result = await register(
      instance,
      makeRow(currentActionId, {
        screenshot: screenshot(currentActionId, { bytes: legacyScreenshotBytes }),
        createdAtMs: 2000,
        updatedAtMs: 2000,
      }),
    );
    expect(result.response.status).toBe(200);

    const body = await snapshot(instance);
    expect(body.rows).toHaveLength(DESKTOP_ACTION_ROW_LIMIT);
    expect(body.rows[0]).toMatchObject({
      actionId: "legacy-151",
      status: "pruned",
      screenshot: expect.objectContaining({ status: "pruned" }),
    });
    expect(body.rows.find((row) => row.actionId === "legacy-152")).toMatchObject({
      status: "pruned",
      screenshot: expect.objectContaining({ status: "pruned" }),
    });
    expect(body.rows.some((row) => row.actionId === "legacy-150")).toBe(false);
    expect(body.maxDesktopActionSeq).toBe(651);

    const retainedIndex = rawStorageValue<string[]>(state, desktopActionPathIndexKey());
    expect(retainedIndex).toHaveLength(DESKTOP_ACTION_ROW_LIMIT);
    expect(retainedIndex[0]).toBe("legacy-151");
    expect(retainedIndex[499]).toBe("legacy-650");

    const quotaIndex = rawQuotaIndex(state);
    expect(quotaIndex).toHaveLength(retainedQuotaCount);
    expect(quotaIndex[0]).toEqual({
      actionId: "legacy-523",
      artifactId: "artifact-legacy-523",
      bytes: legacyScreenshotBytes,
      desktopActionSeq: 524,
    });
    expect(quotaIndex[127]).toEqual({
      actionId: "legacy-650",
      artifactId: "artifact-legacy-650",
      bytes: legacyScreenshotBytes,
      desktopActionSeq: 651,
    });
    expect(rawStorageValue(state, desktopActionScreenshotQuotaBackfillKey())).toBe(
      DESKTOP_ACTION_SCREENSHOT_QUOTA_BACKFILL_VERSION,
    );
    expect(rawStorageValue(state, desktopActionPathRowKey("legacy-0"))).toBeUndefined();
    expect(rawStorageValue(state, desktopActionPathRowKey("legacy-150"))).toBeUndefined();

    expect(doDb.getSessionArtifact(state.storage.sql, SESSION_ID, "artifact-legacy-0")?.metadata?.access).toMatchObject(
      {
        visibility: "private",
        revokedAt: expect.any(Number),
      },
    );
    expect(
      doDb.getSessionArtifact(state.storage.sql, SESSION_ID, "artifact-legacy-152")?.metadata?.access,
    ).toMatchObject({
      visibility: "private",
      revokedAt: expect.any(Number),
    });
    expect(
      doDb.getSessionArtifact(state.storage.sql, SESSION_ID, "artifact-legacy-151")?.metadata?.access,
    ).toMatchObject({
      visibility: "private",
      revokedAt: expect.any(Number),
    });
    expect(
      doDb.getSessionArtifact(state.storage.sql, SESSION_ID, "artifact-legacy-650")?.metadata?.access,
    ).toMatchObject({
      visibility: "private",
      revokedAt: null,
    });

    const allBatchSizes = [...batchCalls.get, ...batchCalls.put, ...batchCalls.delete];
    expect(allBatchSizes.every((entryCount) => entryCount <= DURABLE_OBJECT_STORAGE_BATCH_LIMIT)).toBe(true);
    expect(batchCalls.get).toContain(DURABLE_OBJECT_STORAGE_BATCH_LIMIT);
    expect(batchCalls.put).toContain(DURABLE_OBJECT_STORAGE_BATCH_LIMIT);
    expect(batchCalls.delete).toContain(DURABLE_OBJECT_STORAGE_BATCH_LIMIT);
  });

  it("rebuilds an incomplete legacy quota index before byte pruning", async () => {
    const { state, instance } = createInstance();
    const screenshotBytes = 160 * 1024 * 1024;
    const legacyRows = ["partial-0", "partial-1"].map((actionId, index) =>
      storedDesktopActionRow(actionId, index + 1, {
        screenshot: screenshot(actionId, { bytes: screenshotBytes }),
        createdAtMs: 1000 + index,
        updatedAtMs: 1000 + index,
      }),
    );
    await seedLegacyDesktopActionRows(state, legacyRows);
    await (state.storage as RawDesktopActionStorage).put({
      [desktopActionScreenshotQuotaIndexKey()]: [
        {
          actionId: "partial-1",
          artifactId: "artifact-partial-1",
          bytes: screenshotBytes,
          desktopActionSeq: 2,
        },
      ],
      [desktopActionScreenshotQuotaBackfillKey()]: true,
    });

    seedDesktopActionScreenshotArtifact(state, "partial-2");
    const result = await register(
      instance,
      makeRow("partial-2", {
        screenshot: screenshot("partial-2", { bytes: screenshotBytes }),
        createdAtMs: 2000,
        updatedAtMs: 2000,
      }),
    );
    expect(result.response.status).toBe(200);

    const body = await snapshot(instance);
    expect(body.rows.map((row) => [row.actionId, row.status, row.screenshot?.status])).toEqual([
      ["partial-0", "pruned", "pruned"],
      ["partial-1", "pruned", "pruned"],
      ["partial-2", "completed", "available"],
    ]);
    expect(rawQuotaIndex(state)).toEqual([
      {
        actionId: "partial-2",
        artifactId: "artifact-partial-2",
        bytes: screenshotBytes,
        desktopActionSeq: 3,
      },
    ]);
    expect(rawStorageValue(state, desktopActionScreenshotQuotaBackfillKey())).toBe(
      DESKTOP_ACTION_SCREENSHOT_QUOTA_BACKFILL_VERSION,
    );
    expect(
      doDb.getSessionArtifact(state.storage.sql, SESSION_ID, "artifact-partial-0")?.metadata?.access,
    ).toMatchObject({
      visibility: "private",
      revokedAt: expect.any(Number),
    });
    expect(
      doDb.getSessionArtifact(state.storage.sql, SESSION_ID, "artifact-partial-1")?.metadata?.access,
    ).toMatchObject({
      visibility: "private",
      revokedAt: expect.any(Number),
    });
    expect(
      doDb.getSessionArtifact(state.storage.sql, SESSION_ID, "artifact-partial-2")?.metadata?.access,
    ).toMatchObject({
      visibility: "private",
      revokedAt: null,
    });
  });

  it("backfills an incomplete quota index on stale duplicate registration", async () => {
    const { state, instance } = createInstance();
    const screenshotBytes = 160 * 1024 * 1024;
    const legacyRows = ["stale-partial-0", "stale-partial-1"].map((actionId, index) =>
      storedDesktopActionRow(actionId, index + 1, {
        screenshot: screenshot(actionId, { bytes: screenshotBytes }),
        createdAtMs: 1000 + index,
        updatedAtMs: 1000 + index,
      }),
    );
    await seedLegacyDesktopActionRows(state, legacyRows);
    await (state.storage as RawDesktopActionStorage).put({
      [desktopActionScreenshotQuotaIndexKey()]: [
        {
          actionId: "stale-partial-1",
          artifactId: "artifact-stale-partial-1",
          bytes: screenshotBytes,
          desktopActionSeq: 2,
        },
      ],
      [desktopActionScreenshotQuotaBackfillKey()]: true,
    });

    const result = await register(
      instance,
      makeRow("stale-partial-1", {
        screenshot: screenshot("stale-partial-1", { bytes: screenshotBytes }),
        createdAtMs: 900,
        updatedAtMs: 900,
      }),
    );
    expect(result.response.status).toBe(200);
    expect(result.body?.updated).toBe(false);

    const body = await snapshot(instance);
    expect(body.rows.map((row) => [row.actionId, row.status, row.screenshot?.status])).toEqual([
      ["stale-partial-0", "pruned", "pruned"],
      ["stale-partial-1", "completed", "available"],
    ]);
    expect(rawQuotaIndex(state)).toEqual([
      {
        actionId: "stale-partial-1",
        artifactId: "artifact-stale-partial-1",
        bytes: screenshotBytes,
        desktopActionSeq: 2,
      },
    ]);
    expect(rawStorageValue(state, desktopActionScreenshotQuotaBackfillKey())).toBe(
      DESKTOP_ACTION_SCREENSHOT_QUOTA_BACKFILL_VERSION,
    );
    expect(
      doDb.getSessionArtifact(state.storage.sql, SESSION_ID, "artifact-stale-partial-0")?.metadata?.access,
    ).toMatchObject({
      visibility: "private",
      revokedAt: expect.any(Number),
    });
    expect(
      doDb.getSessionArtifact(state.storage.sql, SESSION_ID, "artifact-stale-partial-1")?.metadata?.access,
    ).toMatchObject({
      visibility: "private",
      revokedAt: null,
    });
  });

  it("evicts old action rows and chunks storage batches past 128 retained rows", async () => {
    const { state, instance } = createInstance();
    const batchCalls = enforceStorageBatchLimit(state.storage as unknown as BatchLimitedStorage);

    for (let index = 0; index <= 500; index += 1) {
      const actionId = `action-${index}`;
      seedDesktopActionScreenshotArtifact(state, actionId);
      const result = await register(
        instance,
        makeRow(actionId, {
          screenshot: screenshot(actionId),
          createdAtMs: 1000 + index,
          updatedAtMs: 1000 + index,
        }),
      );
      expect(result.response.status).toBe(200);
    }

    const body = await snapshot(instance);
    expect(body.rows).toHaveLength(500);
    expect(body.rows[0]).toMatchObject({
      actionId: "action-1",
      status: "completed",
      screenshot: expect.objectContaining({ status: "available" }),
    });
    expect(body.rows[499]).toMatchObject({
      actionId: "action-500",
      status: "completed",
      screenshot: expect.objectContaining({ status: "available" }),
    });
    expect(body.maxDesktopActionSeq).toBe(501);

    const retainedIndex = (state.storage as unknown as { _get(key: string): unknown })._get(
      `desktop_action_path:${SESSION_ID}:index`,
    );
    expect(retainedIndex).toHaveLength(500);
    expect((retainedIndex as string[])[0]).toBe("action-1");
    expect((retainedIndex as string[])[499]).toBe("action-500");

    const quotaIndex = rawQuotaIndex(state);
    expect(quotaIndex).toHaveLength(500);
    expect(quotaIndex[0]).toMatchObject({ actionId: "action-1", artifactId: "artifact-action-1" });
    expect(quotaIndex[499]).toMatchObject({ actionId: "action-500", artifactId: "artifact-action-500" });

    const evictedArtifact = doDb.getSessionArtifact(state.storage.sql, SESSION_ID, "artifact-action-0");
    expect(evictedArtifact?.metadata?.access).toMatchObject({ visibility: "private", revokedAt: expect.any(Number) });
    const retainedArtifact = doDb.getSessionArtifact(state.storage.sql, SESSION_ID, "artifact-action-500");
    expect(retainedArtifact?.metadata?.access).toMatchObject({ visibility: "private", revokedAt: null });

    const allBatchSizes = [...batchCalls.get, ...batchCalls.put, ...batchCalls.delete];
    expect(allBatchSizes.every((entryCount) => entryCount <= DURABLE_OBJECT_STORAGE_BATCH_LIMIT)).toBe(true);
    expect(batchCalls.get).toContain(DURABLE_OBJECT_STORAGE_BATCH_LIMIT);
  });

  it("prunes retained screenshots by byte quota without deleting action rows", async () => {
    const { state, instance } = createInstance();
    const largeScreenshotBytes = 200 * 1024 * 1024;

    for (const actionId of ["byte-action-0", "byte-action-1"]) {
      seedDesktopActionScreenshotArtifact(state, actionId);
      const result = await register(
        instance,
        makeRow(actionId, {
          screenshot: screenshot(actionId, { bytes: largeScreenshotBytes }),
          createdAtMs: 1000,
          updatedAtMs: 1000,
        }),
      );
      expect(result.response.status).toBe(200);
    }

    const body = await snapshot(instance);
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toMatchObject({
      actionId: "byte-action-0",
      status: "pruned",
      screenshot: expect.objectContaining({ status: "pruned" }),
    });
    expect(body.rows[1]).toMatchObject({
      actionId: "byte-action-1",
      status: "completed",
      screenshot: expect.objectContaining({ status: "available" }),
    });

    const prunedArtifact = doDb.getSessionArtifact(state.storage.sql, SESSION_ID, "artifact-byte-action-0");
    expect(prunedArtifact?.metadata?.access).toMatchObject({ visibility: "private", revokedAt: expect.any(Number) });
    const retainedArtifact = doDb.getSessionArtifact(state.storage.sql, SESSION_ID, "artifact-byte-action-1");
    expect(retainedArtifact?.metadata?.access).toMatchObject({ visibility: "private", revokedAt: null });

    expect(rawQuotaIndex(state)).toEqual([
      {
        actionId: "byte-action-1",
        artifactId: "artifact-byte-action-1",
        bytes: largeScreenshotBytes,
        desktopActionSeq: 2,
      },
    ]);
  }, 20_000);
});
