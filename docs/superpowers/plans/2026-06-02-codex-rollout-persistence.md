# Codex Rollout Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the Codex conversation rollout to S3 after every prompt and restore it into a cold-resumed sandbox, so resumed Cycloid sessions recover real prior context instead of starting with an empty thread.

**Architecture:** The Codex app-server persists each thread as rollout JSONL under `$CODEX_HOME/sessions/`. We tar+gzip that subtree after each prompt and PUT it to a new sandbox-callback-authenticated control-plane route (`/api/sessions/:id/rollout`), which stores it at S3 `sessions/{id}/codex-rollout.tar.gz`. On cold resume the bridge GETs and extracts it into `$CODEX_HOME` **before** the app-server boots, so the existing `session.get` → `thread/read`/`thread/resume` restore (bridge.ts:2305) succeeds unchanged. Reuses the existing bridge→control-plane→S3 artifact upload pattern; no S3 creds in the sandbox; no Codex SDK changes.

**Tech Stack:** TypeScript; Cloudflare Workers + Durable Objects (control plane); Node (sandbox-bridge); `aws4fetch` for S3; `tar`/`gzip` via `child_process` (already present in the e2b image); Vitest.

**Spec:** `docs/superpowers/specs/2026-06-02-codex-rollout-persistence-design.md`

---

## File Structure

**Control plane:**

- Modify `apps/control-plane-worker/src/services/archive.ts` — add `writeRollout`, `readRollout` (S3 key `sessions/{id}/codex-rollout.tar.gz`).
- Modify `apps/control-plane-worker/src/session/internal-routes.ts` — add `rolloutUpload`/`rolloutDownload` internal route entries (type + value).
- Modify `apps/control-plane-worker/src/session/state.ts` — add `uploadSandboxRollout`/`downloadSandboxRollout` DO forwarders.
- Modify `apps/control-plane-worker/src/session/durable-object.ts` — handle `PUT /session/rollout` and `GET /session/rollout`.
- Modify `apps/control-plane-worker/src/routes/sessions.ts` — public `PUT`/`GET /api/sessions/:sessionId/rollout`.

**Bridge:**

- Create `apps/sandbox-bridge/src/services/codex-rollout.ts` — `packRollout`, `extractRollout`, `uploadCodexRollout`, `restoreCodexRollout`.
- Modify `apps/sandbox-bridge/src/services/codex-server.ts` — export `resolveCodexHome`.
- Modify `apps/sandbox-bridge/src/bridge.ts` — `rolloutUploadUrl()`, restore-before-init, upload-after-prompt.

**Tests:**

- Create `tests/test_cloudflare/rollout-archive.test.ts`
- Create `tests/test_cloudflare/rollout-route.test.ts`
- Create `tests/test_sandbox-bridge/codex-rollout.test.ts`
- Modify `tests/test_sandbox-bridge/bridge.test.ts` — upload-after-prompt wiring assertion.

---

## Task 1: S3 rollout read/write helpers (`archive.ts`)

**Files:**

- Modify: `apps/control-plane-worker/src/services/archive.ts`
- Test: `tests/test_cloudflare/rollout-archive.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/test_cloudflare/rollout-archive.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";

import { readRollout, writeRollout } from "../../apps/control-plane-worker/src/services/archive";
import type { Env } from "../../apps/control-plane-worker/src/types";

const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as Parameters<
  typeof writeRollout
>[3];

function s3Env(overrides: Record<string, unknown> = {}): Env {
  return {
    S3_ACCESS_KEY_ID: "ak",
    S3_SECRET_ACCESS_KEY: "sk",
    S3_SESSION_BUCKET: "bucket",
    S3_REGION: "us-east-1",
    ...overrides,
  } as Env;
}

afterEach(() => vi.restoreAllMocks());

describe("writeRollout", () => {
  it("PUTs gzip bytes to the rollout key and returns true on success", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const ok = await writeRollout(s3Env(), "sess-1", new Uint8Array([1, 2, 3]), log);
    expect(ok).toBe(true);
    const url = fetchSpy.mock.calls[0]![0] as string | URL;
    expect(String(url)).toContain("/sessions/sess-1/codex-rollout.tar.gz");
    expect((fetchSpy.mock.calls[0]![1] as RequestInit).method).toBe("PUT");
  });

  it("returns false when S3 is not configured", async () => {
    const ok = await writeRollout(s3Env({ S3_SESSION_BUCKET: undefined }), "sess-1", new Uint8Array([1]), log);
    expect(ok).toBe(false);
  });

  it("returns false when S3 PUT fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));
    const ok = await writeRollout(s3Env(), "sess-1", new Uint8Array([1]), log);
    expect(ok).toBe(false);
  });
});

describe("readRollout", () => {
  it("returns the body stream on 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([9, 9]), { status: 200 }));
    const body = await readRollout(s3Env(), "sess-1", log);
    expect(body).not.toBeNull();
  });

  it("returns null on 404", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    const body = await readRollout(s3Env(), "sess-1", log);
    expect(body).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/test_cloudflare/rollout-archive.test.ts`
Expected: FAIL — `writeRollout`/`readRollout` are not exported from `archive.ts`.

- [ ] **Step 3: Implement the helpers**

In `apps/control-plane-worker/src/services/archive.ts`, near the other S3 rollout helpers, add:

```typescript
const ROLLOUT_CONTENT_TYPE = "application/gzip";

/**
 * Write the Codex rollout tar.gz to S3 (single object, overwritten each prompt).
 * Body is pre-gzipped tar. Returns true on success.
 */
export async function writeRollout(env: Env, sessionId: string, body: Uint8Array, log: Logger): Promise<boolean> {
  const config = getS3Config(env);
  if (!config) return false;

  const key = `${S3_EVENTS_PREFIX}/${sessionId}/codex-rollout.tar.gz`;
  const ok = await putObject(config, key, body, ROLLOUT_CONTENT_TYPE);

  if (!ok) {
    log.error({ sessionId }, "S3 rollout upload failed");
  }
  return ok;
}

/**
 * Read the Codex rollout tar.gz from S3. Best-effort: returns null when missing,
 * unconfigured, or on any error (restore is non-critical).
 */
export async function readRollout(env: Env, sessionId: string, log: Logger): Promise<ReadableStream | null> {
  const config = getS3Config(env);
  if (!config) return null;

  const key = `${S3_EVENTS_PREFIX}/${sessionId}/codex-rollout.tar.gz`;
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    service: "s3",
  });

  try {
    const response = await client.fetch(buildObjectUrl(config, key), { method: "GET" });
    if (response.status === 404) return null;
    if (!response.ok || !response.body) {
      log.error({ sessionId, status: response.status }, "S3 rollout fetch failed");
      return null;
    }
    return response.body;
  } catch (err) {
    log.error({ sessionId, error: String(err) }, "S3 rollout fetch threw");
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/test_cloudflare/rollout-archive.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane-worker/src/services/archive.ts tests/test_cloudflare/rollout-archive.test.ts
git commit -m "feat(control-plane): add S3 read/write helpers for Codex rollout"
```

---

## Task 2: Internal route entries + DO forwarders

**Files:**

- Modify: `apps/control-plane-worker/src/session/internal-routes.ts:599` (type) and `:726` (value)
- Modify: `apps/control-plane-worker/src/session/state.ts:972` (after `uploadSandboxArtifact`)

Wires the public→DO forward path; verified end-to-end by the Task 4 route test (thin forwarders, no standalone test).

- [ ] **Step 1: Add the internal route type entries**

In `apps/control-plane-worker/src/session/internal-routes.ts`, inside the type block (the one containing `artifactsUpload: { method: "POST"; path: "/session/artifacts"; }` near line 599), add:

```typescript
rolloutUpload: {
  method: "PUT";
  path: "/session/rollout";
}
rolloutDownload: {
  method: "GET";
  path: "/session/rollout";
}
```

- [ ] **Step 2: Add the internal route value entries**

In the same file, inside the `export const SESSION_INTERNAL_ROUTES = { ... }` value map (near line 726, beside `artifactsUpload: { method: "POST", path: "/session/artifacts" },`), add:

```typescript
  rolloutUpload: { method: "PUT", path: "/session/rollout" },
  rolloutDownload: { method: "GET", path: "/session/rollout" },
```

- [ ] **Step 3: Add the DO forwarders**

In `apps/control-plane-worker/src/session/state.ts`, immediately after `uploadSandboxArtifact` (ends ~line 985), add:

```typescript
export async function uploadSandboxRollout(env: Env, sessionId: string, request: Request): Promise<Response> {
  return fetchSessionRawByPath(env, sessionId, SESSION_INTERNAL_ROUTES.rolloutUpload.path, {
    method: SESSION_INTERNAL_ROUTES.rolloutUpload.method,
    headers: {
      ...sandboxAuthForwardHeaders(request),
      "content-type": request.headers.get("content-type") || "application/gzip",
    },
    includeInternalHeaders: false,
    ...(await bufferedBodyInit(request)),
  });
}

export async function downloadSandboxRollout(env: Env, sessionId: string, request: Request): Promise<Response> {
  return fetchSessionRawByPath(env, sessionId, SESSION_INTERNAL_ROUTES.rolloutDownload.path, {
    method: SESSION_INTERNAL_ROUTES.rolloutDownload.method,
    headers: { ...sandboxAuthForwardHeaders(request) },
    includeInternalHeaders: false,
  });
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc -p apps/control-plane-worker/tsconfig.json --noEmit`
Expected: PASS (no type errors; `SESSION_INTERNAL_ROUTES.rolloutUpload` resolves).

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane-worker/src/session/internal-routes.ts apps/control-plane-worker/src/session/state.ts
git commit -m "feat(control-plane): add internal rollout route + DO forwarders"
```

---

## Task 3: Durable Object rollout handlers

**Files:**

- Modify: `apps/control-plane-worker/src/session/durable-object.ts` (beside the artifact handlers, after the `POST /session/artifacts` block ~line 6140)
- Test: covered in Task 4

- [ ] **Step 1: Add the PUT and GET handlers**

In `apps/control-plane-worker/src/session/durable-object.ts`, in the `fetch()` method next to the artifact handlers (after the `POST /session/artifacts` block), add:

```typescript
if (request.method === "PUT" && url.pathname === "/session/rollout") {
  const auth = await this.validateSandboxAuthRequest(request);
  if (!auth.ok) return auth.response;

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length === 0) {
    return jsonErrorResponse("Rollout body is empty", 400);
  }

  const { writeRollout } = await import("../services/archive.js");
  const ok = await writeRollout(this.env, auth.sessionId, body, this.log);
  if (!ok) {
    return jsonErrorResponse("Failed to store rollout", 500);
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

if (request.method === "GET" && url.pathname === "/session/rollout") {
  const auth = await this.validateSandboxAuthRequest(request);
  if (!auth.ok) return auth.response;

  const { readRollout } = await import("../services/archive.js");
  const body = await readRollout(this.env, auth.sessionId, this.log);
  if (!body) return new Response("Not found", { status: 404 });
  return new Response(body, { headers: { "Content-Type": "application/gzip" } });
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p apps/control-plane-worker/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/control-plane-worker/src/session/durable-object.ts
git commit -m "feat(control-plane): handle PUT/GET /session/rollout in session DO"
```

---

## Task 4: Public rollout routes + end-to-end route test

**Files:**

- Modify: `apps/control-plane-worker/src/routes/sessions.ts` (after the artifact upload route ~line 1384; add import)
- Test: `tests/test_cloudflare/rollout-route.test.ts`

- [ ] **Step 1: Write the failing route test**

Create `tests/test_cloudflare/rollout-route.test.ts` (modeled on the artifact auth test in `tests/smoke/session-preview.test.ts`):

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";

import * as doDb from "../../apps/control-plane-worker/src/session/do-db";
import { computeSha256Hex } from "../../apps/control-plane-worker/src/utils";
import {
  createSession,
  createWorkerEnv,
  getSessionSql,
  seedAuthUser,
  sessionTokenHeaders,
  workerFetch,
  workerModule,
} from "./helpers/worker-harness"; // use the same harness imports the artifact smoke test uses

afterEach(() => vi.restoreAllMocks());

async function seededEnv() {
  const { env, db } = createWorkerEnv(workerModule);
  seedAuthUser(db, "rollout-user", 2001, "rolloutuser");
  const headers = sessionTokenHeaders("rollout-user");
  await createSession(workerModule, env, headers, "s-rollout");
  const sql = getSessionSql(env, "s-rollout");
  doDb.ensureSandboxState(sql, "s-rollout");
  doDb.updateSandboxState(sql, "s-rollout", {
    sandboxAuthTokenHash: await computeSha256Hex("sandbox-rollout-token"),
  });
  // S3 creds so writeRollout/readRollout hit the (mocked) S3 fetch path.
  env.S3_ACCESS_KEY_ID = "ak";
  env.S3_SECRET_ACCESS_KEY = "sk";
  env.S3_SESSION_BUCKET = "bucket";
  env.S3_REGION = "us-east-1";
  return { env };
}

describe("rollout routes", () => {
  it("rejects unauthenticated PUT", async () => {
    const { env } = await seededEnv();
    const res = await workerFetch(workerModule, env, "/api/sessions/s-rollout/rollout", {
      method: "PUT",
      body: new Uint8Array([1, 2, 3]),
    });
    expect(res.status).toBe(401);
  });

  it("rejects empty body", async () => {
    const { env } = await seededEnv();
    const res = await workerFetch(workerModule, env, "/api/sessions/s-rollout/rollout", {
      method: "PUT",
      headers: { authorization: "Bearer sandbox-rollout-token" },
      body: new Uint8Array([]),
    });
    expect(res.status).toBe(400);
  });

  it("stores a rollout on authenticated PUT", async () => {
    const { env } = await seededEnv();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const res = await workerFetch(workerModule, env, "/api/sessions/s-rollout/rollout", {
      method: "PUT",
      headers: { authorization: "Bearer sandbox-rollout-token", "content-type": "application/gzip" },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("returns 404 when no rollout exists", async () => {
    const { env } = await seededEnv();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    const res = await workerFetch(workerModule, env, "/api/sessions/s-rollout/rollout", {
      method: "GET",
      headers: { authorization: "Bearer sandbox-rollout-token" },
    });
    expect(res.status).toBe(404);
  });

  it("returns rollout bytes on GET", async () => {
    const { env } = await seededEnv();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([7, 7, 7]), { status: 200 }));
    const res = await workerFetch(workerModule, env, "/api/sessions/s-rollout/rollout", {
      method: "GET",
      headers: { authorization: "Bearer sandbox-rollout-token" },
    });
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([7, 7, 7]));
  });
});
```

> NOTE: copy the harness import path/names (`createWorkerEnv`, `workerFetch`, `seedAuthUser`, `sessionTokenHeaders`, `getSessionSql`, `createSession`) verbatim from `tests/smoke/session-preview.test.ts` / the existing `tests/test_cloudflare` suites; don't invent names.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/test_cloudflare/rollout-route.test.ts`
Expected: FAIL — route returns 404 (no `/api/sessions/:id/rollout` route registered yet).

- [ ] **Step 3: Add the public routes**

In `apps/control-plane-worker/src/routes/sessions.ts`, add the import near the other `../session/state` imports:

```typescript
import { downloadSandboxRollout, uploadSandboxRollout } from "../session/state";
```

> If `../session/state` is already imported, add `downloadSandboxRollout, uploadSandboxRollout` to the existing import list instead of a new line.

Then, immediately after the artifact upload route block (ends line ~1384), add:

```typescript
  // Sandbox Codex rollout persistence (bridge-authenticated)
  {
    method: "PUT",
    pattern: parsePattern("/api/sessions/:sessionId/rollout"),
    auth: "public",
    handler: async (request, env, match) => {
      const sessionId = match.groups!.sessionId;
      return uploadSandboxRollout(env, sessionId, request);
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/api/sessions/:sessionId/rollout"),
    auth: "public",
    handler: async (request, env, match) => {
      const sessionId = match.groups!.sessionId;
      return downloadSandboxRollout(env, sessionId, request);
    },
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/test_cloudflare/rollout-route.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane-worker/src/routes/sessions.ts tests/test_cloudflare/rollout-route.test.ts
git commit -m "feat(control-plane): expose PUT/GET /api/sessions/:id/rollout"
```

---

## Task 5: Bridge `codex-rollout` module (pack / extract / upload / restore)

**Files:**

- Create: `apps/sandbox-bridge/src/services/codex-rollout.ts`
- Test: `tests/test_sandbox-bridge/codex-rollout.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/test_sandbox-bridge/codex-rollout.test.ts`:

```typescript
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extractRollout,
  packRollout,
  restoreCodexRollout,
  uploadCodexRollout,
} from "../../apps/sandbox-bridge/src/services/codex-rollout";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Parameters<
  typeof uploadCodexRollout
>[0]["log"];

function makeCodexHome(): string {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  mkdirSync(join(home, "sessions", "2026", "06", "02"), { recursive: true });
  writeFileSync(join(home, "sessions", "2026", "06", "02", "rollout-x.jsonl"), '{"turn":1}\n');
  writeFileSync(join(home, "auth.json"), '{"secret":"do-not-ship"}');
  return home;
}

afterEach(() => vi.restoreAllMocks());

describe("packRollout / extractRollout", () => {
  it("packs only the sessions subtree and round-trips, excluding auth.json", () => {
    const home = makeCodexHome();
    const bytes = packRollout(home);
    expect(bytes).not.toBeNull();

    const dest = mkdtempSync(join(tmpdir(), "codex-restore-"));
    extractRollout(dest, new Uint8Array(bytes!));
    expect(existsSync(join(dest, "sessions", "2026", "06", "02", "rollout-x.jsonl"))).toBe(true);
    expect(existsSync(join(dest, "auth.json"))).toBe(false);
  });

  it("returns null when there is no sessions subtree", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-empty-"));
    expect(packRollout(home)).toBeNull();
  });
});

describe("uploadCodexRollout", () => {
  it("PUTs the packed rollout with a bearer token", async () => {
    const home = makeCodexHome();
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await uploadCodexRollout({
      codexHome: home,
      rolloutUrl: "https://cp.test/api/sessions/s1/rollout",
      getSandboxToken: () => "tok",
      fetch: fetchSpy as unknown as typeof fetch,
      log,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("does not POST when there is no rollout to pack", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-empty-"));
    const fetchSpy = vi.fn();
    await uploadCodexRollout({
      codexHome: home,
      rolloutUrl: "https://cp.test/api/sessions/s1/rollout",
      getSandboxToken: () => "tok",
      fetch: fetchSpy as unknown as typeof fetch,
      log,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never throws when the upload fails", async () => {
    const home = makeCodexHome();
    const fetchSpy = vi.fn().mockRejectedValue(new Error("network"));
    await expect(
      uploadCodexRollout({
        codexHome: home,
        rolloutUrl: "https://cp.test/api/sessions/s1/rollout",
        getSandboxToken: () => "tok",
        fetch: fetchSpy as unknown as typeof fetch,
        log,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("restoreCodexRollout", () => {
  it("extracts a fetched rollout into CODEX_HOME and returns true", async () => {
    const src = makeCodexHome();
    const packed = packRollout(src)!;
    const dest = mkdtempSync(join(tmpdir(), "codex-cold-"));
    const fetchSpy = vi.fn().mockResolvedValue(new Response(new Uint8Array(packed), { status: 200 }));
    const restored = await restoreCodexRollout({
      codexHome: dest,
      rolloutUrl: "https://cp.test/api/sessions/s1/rollout",
      getSandboxToken: () => "tok",
      fetch: fetchSpy as unknown as typeof fetch,
      log,
    });
    expect(restored).toBe(true);
    expect(existsSync(join(dest, "sessions", "2026", "06", "02", "rollout-x.jsonl"))).toBe(true);
  });

  it("returns false on 404 without extracting", async () => {
    const dest = mkdtempSync(join(tmpdir(), "codex-cold-"));
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const restored = await restoreCodexRollout({
      codexHome: dest,
      rolloutUrl: "https://cp.test/api/sessions/s1/rollout",
      getSandboxToken: () => "tok",
      fetch: fetchSpy as unknown as typeof fetch,
      log,
    });
    expect(restored).toBe(false);
    expect(existsSync(join(dest, "sessions"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/test_sandbox-bridge/codex-rollout.test.ts`
Expected: FAIL — module `codex-rollout` does not exist.

- [ ] **Step 3: Implement the module**

Create `apps/sandbox-bridge/src/services/codex-rollout.ts`:

```typescript
import { execFileSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

import type { BridgeLogger } from "../logger.js";

/** Codex writes rollout JSONL under `$CODEX_HOME/sessions/`. `auth.json` lives at
 *  the CODEX_HOME root, so packing only this subtree never ships credentials. */
const ROLLOUT_SUBDIR = "sessions";
const TAR_MAX_BUFFER = 256 * 1024 * 1024; // 256 MiB; rollouts are a few MB at most.
const ROLLOUT_TIMEOUT_MS = 15_000;

export interface RolloutPort {
  codexHome: string;
  rolloutUrl: string;
  getSandboxToken: () => string;
  fetch: typeof fetch;
  log: BridgeLogger;
}

/** Tar+gzip the rollout subtree of `$CODEX_HOME`. Returns null when absent. */
export function packRollout(codexHome: string): Buffer | null {
  if (!existsSync(join(codexHome, ROLLOUT_SUBDIR))) return null;
  return execFileSync("tar", ["czf", "-", "-C", codexHome, ROLLOUT_SUBDIR], {
    maxBuffer: TAR_MAX_BUFFER,
  });
}

/** Extract a rollout tar.gz into `$CODEX_HOME`, restoring the `sessions/` subtree. */
export function extractRollout(codexHome: string, tarGz: Uint8Array): void {
  mkdirSync(codexHome, { recursive: true });
  execFileSync("tar", ["xzf", "-", "-C", codexHome], {
    input: Buffer.from(tarGz),
    maxBuffer: TAR_MAX_BUFFER,
  });
}

/** Best-effort: pack the rollout and PUT it to the control plane. Never throws. */
export async function uploadCodexRollout(port: RolloutPort): Promise<void> {
  try {
    const body = packRollout(port.codexHome);
    if (!body) return;
    const res = await port.fetch(port.rolloutUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${port.getSandboxToken()}`,
        "Content-Type": "application/gzip",
      },
      body,
      signal: AbortSignal.timeout(ROLLOUT_TIMEOUT_MS),
    });
    if (!res.ok) {
      port.log.warn({ event: "codex_rollout.upload_failed", status: res.status }, "Codex rollout upload failed");
    }
  } catch (err) {
    port.log.warn({ event: "codex_rollout.upload_error", error: String(err) }, "Codex rollout upload error");
  }
}

/** Best-effort: GET the rollout and extract it into `$CODEX_HOME` before the
 *  app-server boots. Returns true when a rollout was restored. Never throws. */
export async function restoreCodexRollout(port: RolloutPort): Promise<boolean> {
  try {
    const res = await port.fetch(port.rolloutUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${port.getSandboxToken()}` },
      signal: AbortSignal.timeout(ROLLOUT_TIMEOUT_MS),
    });
    if (res.status === 404) return false;
    if (!res.ok) {
      port.log.warn({ event: "codex_rollout.restore_failed", status: res.status }, "Codex rollout restore failed");
      return false;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0) return false;
    extractRollout(port.codexHome, bytes);
    port.log.info({ event: "codex_rollout.restored", bytes: bytes.length }, "Restored Codex rollout");
    return true;
  } catch (err) {
    port.log.warn({ event: "codex_rollout.restore_error", error: String(err) }, "Codex rollout restore error");
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/test_sandbox-bridge/codex-rollout.test.ts`
Expected: PASS (7 tests). (Requires `tar` on PATH — present in CI and the e2b image.)

- [ ] **Step 5: Commit**

```bash
git add apps/sandbox-bridge/src/services/codex-rollout.ts tests/test_sandbox-bridge/codex-rollout.test.ts
git commit -m "feat(bridge): add codex-rollout pack/extract/upload/restore module"
```

---

## Task 6: Wire the bridge (restore before init, upload after prompt)

**Files:**

- Modify: `apps/sandbox-bridge/src/services/codex-server.ts:681` — export `resolveCodexHome`
- Modify: `apps/sandbox-bridge/src/bridge.ts` — import, `rolloutUploadUrl()`, restore call, upload call
- Test: `tests/test_sandbox-bridge/bridge.test.ts` — upload-after-prompt assertion

- [ ] **Step 1: Export `resolveCodexHome`**

In `apps/sandbox-bridge/src/services/codex-server.ts`, change line 681:

```typescript
export function resolveCodexHome(source: NodeJS.ProcessEnv | Record<string, string>): string {
```

(Add `export` to the existing `function resolveCodexHome`.)

- [ ] **Step 2: Add imports and the URL builder to the bridge**

In `apps/sandbox-bridge/src/bridge.ts`, add to the imports:

```typescript
import { restoreCodexRollout, uploadCodexRollout } from "./services/codex-rollout.js";
import { resolveCodexHome } from "./services/codex-server.js";
```

> If `./services/codex-server.js` is already imported, add `resolveCodexHome` to that import list.

Add a private method next to `artifactUploadUrl()` (~line 1490), mirroring it:

```typescript
  private rolloutUploadUrl(): string {
    let base = this.config.controlPlaneUrl;
    if (!base.startsWith("http://") && !base.startsWith("https://")) {
      base = `https://${base}`;
    }
    base = base.replace(/\/$/, "");
    return `${base}/api/sessions/${this.config.sessionId}/rollout`;
  }
```

Add a private helper that builds the rollout port (used by both restore and upload):

```typescript
  private codexRolloutPort(log: BridgeLogger) {
    return {
      codexHome: resolveCodexHome(process.env),
      rolloutUrl: this.rolloutUploadUrl(),
      getSandboxToken: () => this.sandboxWsAuthToken,
      fetch: globalThis.fetch,
      log,
    };
  }
```

> `BridgeLogger` is already imported in `bridge.ts` (used throughout). If not, import it from `./logger.js`.

- [ ] **Step 3: Restore before the app-server boots**

In `bridge.ts`, locate the block that initializes the client (the `if (!this.client) { ... ensureClientInitializedForPrompt(...) }` around line 2293). Immediately **before** that `if (!this.client)` block, add a cold-resume-gated restore:

```typescript
// Cold resume: restore the persisted Codex rollout into $CODEX_HOME before the
// app-server boots, so the session.get restore below finds the thread on disk.
if (!this.client && this.restorableSessionId && !this.codexSessionId) {
  await restoreCodexRollout(this.codexRolloutPort(ctx.promptLog));
}
```

Runs once (while `this.client` is null, before first init) and only on cold resume (`restorableSessionId` set, `codexSessionId` null). The existing `ensureClientInitializedForPrompt` then spawns the app-server and the `session.get(restorableSessionId)` restore (line ~2305) succeeds because the rollout files now exist.

- [ ] **Step 4: Upload after each prompt**

In `bridge.ts`, find where post-execution is kicked off after a prompt completes — the `this.pendingPostExecution = new PostExecutionRunner(...).run({...})` assignment (~line 1980-1995). Immediately after that assignment, add a fire-and-forget upload guarded on having a Codex session:

```typescript
// Persist the Codex rollout durably so a future cold resume restores context.
if (this.codexSessionId) {
  void uploadCodexRollout(this.codexRolloutPort(promptLog));
}
```

> Use whichever logger variable is in scope at that point (`promptLog`); match the surrounding code.

- [ ] **Step 5: Write the upload-wiring test**

In `tests/test_sandbox-bridge/bridge.test.ts`, add a test modeled on the artifact-upload test (`"uploads image files and returns artifacts"`, ~line 1330): drive a prompt to completion through the existing harness and assert a PUT to the rollout URL. Create a real `$CODEX_HOME` with a `sessions/` subtree first so `packRollout` produces bytes:

```typescript
it("uploads the codex rollout after a prompt completes", async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-home-"));
  mkdirSync(join(codexHome, "sessions"), { recursive: true });
  writeFileSync(join(codexHome, "sessions", "rollout-x.jsonl"), '{"turn":1}\n');
  process.env.CODEX_HOME = codexHome;
  onTestFinished(() => {
    delete process.env.CODEX_HOME;
    rmSync(codexHome, { recursive: true, force: true });
  });

  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

  // Drive a prompt to completion using the harness used by the artifact test,
  // then assert a PUT to the rollout URL was issued.
  // (Reuse the same bridge setup + prompt-completion helper the artifact test uses.)
  await new Promise((r) => setTimeout(r, 0));

  const rolloutCall = fetchSpy.mock.calls.find(
    ([u, init]) => String(u).endsWith("/rollout") && (init as RequestInit)?.method === "PUT",
  );
  expect(rolloutCall).toBeDefined();
  expect(((rolloutCall![1] as RequestInit).headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
});
```

> IMPORTANT: copy the exact bridge construction + prompt-drive + `shutdownBridgeRun` scaffolding from the neighboring `"uploads image files and returns artifacts"` test so the prompt completes and post-execution fires; only the assertion above is new. Add `mkdtempSync, mkdirSync, writeFileSync, rmSync` and `tmpdir`/`join` to the file's fs/os/path imports if missing.

- [ ] **Step 6: Run the bridge tests**

Run: `npx vitest run tests/test_sandbox-bridge/codex-rollout.test.ts tests/test_sandbox-bridge/bridge.test.ts`
Expected: PASS, including the new upload-wiring test.

- [ ] **Step 7: Commit**

```bash
git add apps/sandbox-bridge/src/services/codex-server.ts apps/sandbox-bridge/src/bridge.ts tests/test_sandbox-bridge/bridge.test.ts
git commit -m "feat(bridge): persist codex rollout per-prompt and restore on cold resume"
```

---

## Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck both packages**

Run: `npx tsc -p apps/control-plane-worker/tsconfig.json --noEmit && npx tsc -p apps/sandbox-bridge/tsconfig.json --noEmit`
Expected: PASS, no errors.

- [ ] **Step 2: Run the full affected test suites**

Run: `npx vitest run tests/test_cloudflare/rollout-archive.test.ts tests/test_cloudflare/rollout-route.test.ts tests/test_sandbox-bridge/codex-rollout.test.ts tests/test_sandbox-bridge/bridge.test.ts`
Expected: PASS.

- [ ] **Step 3: Lint the changed files**

Run: `npm run lint` (or the repo's configured lint command per `docs/conventions.md`)
Expected: PASS for all created/modified files.

- [ ] **Step 4: Confirm the rollout subtree assumption**

Before merging, confirm Codex actually writes rollouts under `$CODEX_HOME/sessions/` in the e2b image (a live sandbox `ls -R $CODEX_HOME` after one prompt, or a local `codex` run). If the layout differs, the only change required is `ROLLOUT_SUBDIR` (and possibly adding sibling rollout files) in `apps/sandbox-bridge/src/services/codex-rollout.ts` — every other layer is path-agnostic. Note the finding in the PR description.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin HEAD
gh pr create --title "Persist Codex rollout for durable cold-resume context" --body "<summary + spec/plan links + Task 7 Step 4 finding>"
```

---

## Self-Review Notes

- **Spec coverage:** pack/upload/restore module (Task 5) ✓; per-prompt upload + cold-resume restore-before-boot (Task 6) ✓; control-plane PUT/GET routes + archive helpers (Tasks 1–4) ✓; S3 key `sessions/{id}/codex-rollout.tar.gz` (Task 1) ✓; keep-forever / no TTL (no lifecycle code added) ✓; never ship `auth.json` (Task 5 whitelist + test) ✓; unit tests only ✓.
- **Type consistency:** `RolloutPort` shape is identical across Tasks 5–6; `writeRollout` returns `boolean`, `readRollout` returns `ReadableStream | null`, consumed accordingly in Task 3; `SESSION_INTERNAL_ROUTES.rolloutUpload/rolloutDownload` defined in Task 2, used in Task 2's forwarders.
- **Open risk:** exact `$CODEX_HOME` rollout layout — isolated to `ROLLOUT_SUBDIR`, verified in Task 7 Step 4.
