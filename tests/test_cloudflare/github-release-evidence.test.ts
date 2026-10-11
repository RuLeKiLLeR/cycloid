import { beforeEach, describe, expect, it, vi } from "vitest";

const mockTracedFetch = vi.fn();
const mockCreateInstallationToken = vi.fn();
const mockPostStructuredEventToDd = vi.fn();

vi.mock("../../apps/control-plane-worker/src/observability/wrappers", () => ({
  tracedFetch: (...args: unknown[]) => mockTracedFetch(...args),
  tracedEnv: (env: unknown) => env,
}));

vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
}));

vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: (...args: unknown[]) => mockCreateInstallationToken(...args),
  createScopedInstallationToken: (...args: unknown[]) => mockCreateInstallationToken(...args),
  sandboxInstallationTokenScope: (repoName: string) => ({
    repositories: [repoName],
    permissions: { contents: "write", pull_requests: "read" },
  }),
}));

import {
  formatEvidenceReleaseTag,
  GITHUB_EVIDENCE_RELEASE_MARKER,
} from "../../apps/control-plane-worker/src/github/releases";
import * as doDb from "../../apps/control-plane-worker/src/session/do-db";
import {
  GithubReleaseEvidenceService,
  hasObviousReleaseOrTagWorkflowTrigger,
} from "../../apps/control-plane-worker/src/session/github-release-evidence";
import { LATEST_PR_BODY_STORAGE_KEY } from "../../apps/control-plane-worker/src/session/pr-body-assembler";
import type { ResolvedPrRepoAuth } from "../../apps/control-plane-worker/src/session/pr-github-ops";
import type { Env } from "../../apps/control-plane-worker/src/types";
import { FakeStorage, seedSession } from "./session/helpers";

const SESSION_ID = "session123456";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mediaResponse(body: Uint8Array, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": contentType },
  });
}

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function seedSessionWithArtifacts(
  storage: FakeStorage,
  artifacts: Array<{
    id: string;
    type: "screenshot" | "video";
    filename: string;
    label: string;
    metadata?: Record<string, unknown>;
  }>,
): void {
  seedSession(storage, {
    sessionId: SESSION_ID,
    ownerUserId: "user-1",
    businessId: "biz-1",
    repoOwner: "acme",
    repoName: "repo",
    baseBranch: "main",
    installationId: 123,
    repoPrivate: 0,
  });
  let createdAt = Date.now();
  for (const artifact of artifacts) {
    doDb.insertSessionArtifact(storage.sql as unknown as SqlStorage, {
      artifactId: artifact.id,
      sessionId: SESSION_ID,
      type: artifact.type,
      url: `https://app.trycycloid.com/api/sessions/${SESSION_ID}/artifacts/${artifact.id}/${artifact.filename}`,
      metadata: {
        label: artifact.label,
        filename: artifact.filename,
        contentType: artifact.type === "video" ? "video/webm" : "image/png",
        ...artifact.metadata,
      },
      createdAt: createdAt++,
    });
  }
}

function makeHost(storage: FakeStorage, fetchInternal: (request: Request) => Promise<Response>) {
  return {
    env: {
      DB: {} as D1Database,
      FRONTEND_URL: "https://app.trycycloid.com",
    } as Env,
    log: makeLogger(),
    state: { storage } as unknown as DurableObjectState,
    waitUntil: vi.fn(),
    fetchInternal: vi.fn(fetchInternal),
  };
}

function makeAuth(storage: FakeStorage): ResolvedPrRepoAuth {
  return {
    sessionId: SESSION_ID,
    token: "ghs_install",
    tokenSource: "installation",
    installationId: 123,
    installationToken: "ghs_install",
    repoOwner: "acme",
    repoName: "repo",
    ext: doDb.getSessionExtended(storage.sql as unknown as SqlStorage, SESSION_ID),
  };
}

describe("GitHub release evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateInstallationToken.mockResolvedValue("ghs_install");
    mockPostStructuredEventToDd.mockResolvedValue(true);
  });

  it("detects obvious release and tag-triggered workflows", () => {
    expect(hasObviousReleaseOrTagWorkflowTrigger("on:\n  release:\n    types: [published]\n")).toBe(true);
    expect(hasObviousReleaseOrTagWorkflowTrigger("on:\n  - release\n")).toBe(true);
    expect(hasObviousReleaseOrTagWorkflowTrigger("on:\n  - release:\n      types: [published]\n")).toBe(true);
    expect(hasObviousReleaseOrTagWorkflowTrigger("on:\n  push:\n    tags:\n      - 'v*'\n")).toBe(true);
    expect(hasObviousReleaseOrTagWorkflowTrigger("on:\n  - push:\n      tags:\n        - 'v*'\n")).toBe(true);
    expect(hasObviousReleaseOrTagWorkflowTrigger("on:\n  - release:\n")).toBe(true);
    expect(
      hasObviousReleaseOrTagWorkflowTrigger(`on:
  - push:
      branches:
        - main
  - workflow_dispatch:
      inputs:
        tags:
          description: Manual tag input
`),
    ).toBe(false);
    expect(hasObviousReleaseOrTagWorkflowTrigger("on:\n  pull_request:\n")).toBe(false);
    expect(
      hasObviousReleaseOrTagWorkflowTrigger("on:\n  pull_request:\n\njobs:\n  release:\n    runs-on: ubuntu-latest\n"),
    ).toBe(false);
    expect(
      hasObviousReleaseOrTagWorkflowTrigger(`on:
  workflow_dispatch:
    inputs:
      increment-level:
        type: choice
        options:
          - patch
          - prerelease
          - release
`),
    ).toBe(false);
  });

  it("uploads all visual artifacts to release assets and renders them in the PR body", async () => {
    const storage = new FakeStorage();
    seedSessionWithArtifacts(storage, [
      { id: "artifact-after", type: "screenshot", filename: "after.png", label: "After" },
      { id: "artifact-before", type: "screenshot", filename: "before.png", label: "Before" },
      { id: "artifact-wide", type: "screenshot", filename: "wide.png", label: "Wide" },
      { id: "artifact-video", type: "video", filename: "walkthrough.webm", label: "Walkthrough" },
    ]);

    const mediaBodies = new Map<string, { body: Uint8Array; contentType: string }>([
      ["after.png", { body: new Uint8Array([1, 2, 3]), contentType: "image/png" }],
      ["before.png", { body: new Uint8Array([4, 5, 6]), contentType: "image/png" }],
      ["wide.png", { body: new Uint8Array([7, 8, 9]), contentType: "image/png" }],
      ["walkthrough.webm", { body: new Uint8Array([10, 11, 12]), contentType: "video/webm" }],
    ]);
    const host = makeHost(storage, async (request) => {
      const filename = decodeURIComponent(request.url.split("/").pop() ?? "");
      const media = mediaBodies.get(filename);
      if (!media) return new Response("Not found", { status: 404 });
      return mediaResponse(media.body, media.contentType);
    });
    const uploadBodies: BodyInit[] = [];
    const uploadContentTypes: string[] = [];
    const releaseBodies: unknown[] = [];
    const patchedBodies: string[] = [];
    const issueCommentUrls: string[] = [];

    mockTracedFetch.mockImplementation(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = typeof rawUrl === "string" ? rawUrl : rawUrl instanceof URL ? rawUrl.toString() : rawUrl.url;
      const method = init?.method ?? "GET";
      const parsed = new URL(url);
      if (parsed.pathname === "/repos/acme/repo/releases" && method === "GET") return jsonResponse([]);
      if (parsed.pathname === "/repos/acme/repo/releases/tags/cycloid-evidence-0001") {
        return jsonResponse({ message: "not found" }, 404);
      }
      if (parsed.pathname === "/repos/acme/repo/git/ref/tags/cycloid-evidence-0001") {
        return jsonResponse({ message: "not found" }, 404);
      }
      if (parsed.pathname === "/repos/acme/repo") return jsonResponse({ default_branch: "main", private: false });
      if (parsed.pathname === "/repos/acme/repo/contents/.github/workflows") {
        return jsonResponse({ message: "not found" }, 404);
      }
      if (parsed.pathname === "/repos/acme/repo/branches/main") return jsonResponse({ commit: { sha: "abc123" } });
      if (parsed.pathname === "/repos/acme/repo/releases" && method === "POST") {
        releaseBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({
          id: 10,
          tag_name: "cycloid-evidence-0001",
          name: "Cycloid visual evidence 0001",
          body: GITHUB_EVIDENCE_RELEASE_MARKER,
        });
      }
      if (parsed.pathname === "/repos/acme/repo/releases/10/assets" && method === "GET") return jsonResponse([]);
      if (url.startsWith("https://uploads.github.com/") && method === "POST") {
        uploadBodies.push(init?.body as BodyInit);
        uploadContentTypes.push(new Headers(init?.headers).get("content-type") ?? "");
        const name = parsed.searchParams.get("name") ?? "missing.png";
        return jsonResponse({
          id: 20 + uploadBodies.length,
          name,
          size: 3,
          state: "uploaded",
          digest: null,
          browser_download_url: `https://github.com/acme/repo/releases/download/cycloid-evidence-0001/${name}`,
        });
      }
      if (parsed.pathname === "/repos/acme/repo/pulls/42" && method === "GET") {
        return jsonResponse({ body: "## Changes\nCurrent PR body." });
      }
      if (parsed.pathname === "/repos/acme/repo/pulls/42" && method === "PATCH") {
        patchedBodies.push(JSON.parse(String(init?.body)).body);
        return jsonResponse({ ok: true });
      }
      if (parsed.pathname.includes("/issues/")) issueCommentUrls.push(url);
      throw new Error(`Unexpected GitHub fetch: ${method} ${url}`);
    });

    await new GithubReleaseEvidenceService(storage.sql as unknown as SqlStorage, host).publishForPr({
      sessionId: SESSION_ID,
      auth: makeAuth(storage),
      prNumber: 42,
      body: "## Changes\nUpdated visual state.",
    });

    expect(releaseBodies[0]).toMatchObject({
      tag_name: "cycloid-evidence-0001",
      target_commitish: "abc123",
      prerelease: true,
      draft: false,
      make_latest: "false",
    });
    expect(uploadBodies).toHaveLength(4);
    expect(uploadContentTypes).toEqual(["image/png", "image/png", "image/png", "video/webm"]);
    expect(patchedBodies).toHaveLength(1);
    expect(patchedBodies[0]).toContain("Current PR body.");
    expect(patchedBodies[0]).not.toContain("Updated visual state.");
    expect(patchedBodies[0]).toContain("## Screenshots or Recordings");
    expect(patchedBodies[0].match(/<img /g) ?? []).toHaveLength(3);
    expect(patchedBodies[0]).toContain("### Recordings");
    expect(patchedBodies[0]).toContain("[Walkthrough]");
    expect(patchedBodies[0]).toContain("9909ec831e2c.webm");
    expect(patchedBodies[0]).not.toContain("https://app.trycycloid.com/api/sessions/");
    expect(issueCommentUrls).toHaveLength(0);
    expect(host.log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "github_evidence.release.ensure.listed",
        totalReleaseCount: 0,
        managedReleaseCount: 0,
      }),
      "github_evidence.release.ensure.listed",
    );
    expect(host.log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "github_evidence.release.bucket.create.started",
        bucketNumber: 1,
        releaseTag: "cycloid-evidence-0001",
      }),
      "github_evidence.release.bucket.create.started",
    );
    expect(host.log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "github_evidence.release.bucket.create.succeeded",
        bucketNumber: 1,
        releaseId: 10,
        releaseTag: "cycloid-evidence-0001",
      }),
      "github_evidence.release.bucket.create.succeeded",
    );
  });

  it("falls back to PR body links instead of creating a release when risky workflows are present", async () => {
    const storage = new FakeStorage();
    seedSessionWithArtifacts(storage, [
      { id: "artifact-after", type: "screenshot", filename: "after.png", label: "After" },
    ]);
    const host = makeHost(storage, async () => mediaResponse(new Uint8Array([1, 2, 3]), "image/png"));
    const patchedBodies: string[] = [];

    mockTracedFetch.mockImplementation(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = typeof rawUrl === "string" ? rawUrl : rawUrl instanceof URL ? rawUrl.toString() : rawUrl.url;
      const method = init?.method ?? "GET";
      const parsed = new URL(url);
      if (parsed.pathname === "/repos/acme/repo/releases" && method === "GET") return jsonResponse([]);
      if (parsed.pathname === "/repos/acme/repo/releases/tags/cycloid-evidence-0001") {
        return jsonResponse({ message: "not found" }, 404);
      }
      if (parsed.pathname === "/repos/acme/repo/git/ref/tags/cycloid-evidence-0001") {
        return jsonResponse({ message: "not found" }, 404);
      }
      if (parsed.pathname === "/repos/acme/repo") return jsonResponse({ default_branch: "main", private: true });
      if (parsed.pathname === "/repos/acme/repo/contents/.github/workflows") {
        return jsonResponse([{ name: "release.yml", path: ".github/workflows/release.yml", type: "file" }]);
      }
      if (parsed.pathname === "/repos/acme/repo/contents/.github/workflows/release.yml") {
        return new Response("on:\n  release:\n    types: [published]\n");
      }
      if (parsed.pathname === "/repos/acme/repo/releases" && method === "POST") {
        throw new Error("release should not be created");
      }
      if (parsed.pathname === "/repos/acme/repo/pulls/42" && method === "GET") {
        return jsonResponse({ body: "## Changes\nCurrent PR body." });
      }
      if (parsed.pathname === "/repos/acme/repo/pulls/42" && method === "PATCH") {
        patchedBodies.push(JSON.parse(String(init?.body)).body);
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected GitHub fetch: ${method} ${url}`);
    });

    await new GithubReleaseEvidenceService(storage.sql as unknown as SqlStorage, host).publishForPr({
      sessionId: SESSION_ID,
      auth: makeAuth(storage),
      prNumber: 42,
      body: "## Changes\nUpdated visual state.",
    });

    expect(host.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "github_evidence.workflow_risk_detected" }),
      "github_evidence.workflow_risk_detected",
    );
    expect(host.log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "github_evidence.fallback_to_links",
        operation: "workflow_risk_detected",
      }),
      "github_evidence.fallback_to_links",
    );
    expect(patchedBodies[0]).toContain("https://app.trycycloid.com/api/sessions/session123456/artifacts/");
    expect(patchedBodies[0]).not.toContain("releases/download/cycloid-evidence");
  });

  it("publishes release evidence when sibling sequence events contain unrelated tags fields", async () => {
    const storage = new FakeStorage();
    seedSessionWithArtifacts(storage, [
      { id: "artifact-after", type: "screenshot", filename: "after.png", label: "After" },
    ]);
    const host = makeHost(storage, async () => mediaResponse(new Uint8Array([1, 2, 3]), "image/png"));
    const releaseBodies: unknown[] = [];
    const patchedBodies: string[] = [];

    mockTracedFetch.mockImplementation(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = typeof rawUrl === "string" ? rawUrl : rawUrl instanceof URL ? rawUrl.toString() : rawUrl.url;
      const method = init?.method ?? "GET";
      const parsed = new URL(url);
      if (parsed.pathname === "/repos/acme/repo/releases" && method === "GET") return jsonResponse([]);
      if (parsed.pathname === "/repos/acme/repo/releases/tags/cycloid-evidence-0001") {
        return jsonResponse({ message: "not found" }, 404);
      }
      if (parsed.pathname === "/repos/acme/repo/git/ref/tags/cycloid-evidence-0001") {
        return jsonResponse({ message: "not found" }, 404);
      }
      if (parsed.pathname === "/repos/acme/repo") return jsonResponse({ default_branch: "main", private: true });
      if (parsed.pathname === "/repos/acme/repo/contents/.github/workflows") {
        return jsonResponse([{ name: "release.yml", path: ".github/workflows/release.yml", type: "file" }]);
      }
      if (parsed.pathname === "/repos/acme/repo/contents/.github/workflows/release.yml") {
        return new Response(`on:
  - push:
      branches:
        - main
  - workflow_dispatch:
      inputs:
        tags:
          description: Manual tag input
`);
      }
      if (parsed.pathname === "/repos/acme/repo/branches/main") return jsonResponse({ commit: { sha: "abc123" } });
      if (parsed.pathname === "/repos/acme/repo/releases" && method === "POST") {
        releaseBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({
          id: 10,
          tag_name: "cycloid-evidence-0001",
          name: "Cycloid visual evidence 0001",
          body: GITHUB_EVIDENCE_RELEASE_MARKER,
        });
      }
      if (parsed.pathname === "/repos/acme/repo/releases/10/assets" && method === "GET") return jsonResponse([]);
      if (url.startsWith("https://uploads.github.com/") && method === "POST") {
        const name = parsed.searchParams.get("name") ?? "missing.png";
        return jsonResponse({
          id: 21,
          name,
          size: 3,
          state: "uploaded",
          digest: null,
          browser_download_url: `https://github.com/acme/repo/releases/download/cycloid-evidence-0001/${name}`,
        });
      }
      if (parsed.pathname === "/repos/acme/repo/pulls/42" && method === "GET") {
        return jsonResponse({ body: "## Changes\nCurrent PR body." });
      }
      if (parsed.pathname === "/repos/acme/repo/pulls/42" && method === "PATCH") {
        patchedBodies.push(JSON.parse(String(init?.body)).body);
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected GitHub fetch: ${method} ${url}`);
    });

    await new GithubReleaseEvidenceService(storage.sql as unknown as SqlStorage, host).publishForPr({
      sessionId: SESSION_ID,
      auth: makeAuth(storage),
      prNumber: 42,
      body: "## Changes\nUpdated visual state.",
    });

    expect(releaseBodies).toHaveLength(1);
    expect(patchedBodies[0]).toContain("releases/download/cycloid-evidence-0001");
    expect(patchedBodies[0]).not.toContain("https://app.trycycloid.com/api/sessions/session123456/artifacts/");
    expect(host.log.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "github_evidence.workflow_risk_detected" }),
      "github_evidence.workflow_risk_detected",
    );
    expect(host.log.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "github_evidence.fallback_to_links" }),
      "github_evidence.fallback_to_links",
    );
  });

  it("creates the next managed release bucket when the first bucket is full", async () => {
    const storage = new FakeStorage();
    seedSessionWithArtifacts(storage, [
      { id: "artifact-after", type: "screenshot", filename: "after.png", label: "After" },
    ]);
    const host = makeHost(storage, async () => mediaResponse(new Uint8Array([1, 2, 3]), "image/png"));
    const createdReleaseTags: string[] = [];
    const uploadReleaseIds: string[] = [];
    const patchedBodies: string[] = [];

    mockTracedFetch.mockImplementation(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = typeof rawUrl === "string" ? rawUrl : rawUrl instanceof URL ? rawUrl.toString() : rawUrl.url;
      const method = init?.method ?? "GET";
      const parsed = new URL(url);
      if (parsed.pathname === "/repos/acme/repo/releases" && method === "GET") {
        return jsonResponse([
          {
            id: 10,
            tag_name: "cycloid-evidence-0001",
            name: "Cycloid visual evidence 0001",
            body: GITHUB_EVIDENCE_RELEASE_MARKER,
          },
        ]);
      }
      if (parsed.pathname === "/repos/acme/repo/releases/10/assets" && method === "GET") {
        const page = Number(parsed.searchParams.get("page") ?? "1");
        if (page <= 10) {
          return jsonResponse(
            Array.from({ length: 100 }, (_, index) => ({
              id: page * 1000 + index,
              name: `existing-${page}-${index}.png`,
              size: 1,
              state: "uploaded",
              digest: null,
              browser_download_url: "https://github.com/acme/repo/releases/download/cycloid-evidence-0001/existing.png",
            })),
          );
        }
        return jsonResponse([]);
      }
      if (parsed.pathname === "/repos/acme/repo/releases/tags/cycloid-evidence-0002") {
        return jsonResponse({ message: "not found" }, 404);
      }
      if (parsed.pathname === "/repos/acme/repo/git/ref/tags/cycloid-evidence-0002") {
        return jsonResponse({ message: "not found" }, 404);
      }
      if (parsed.pathname === "/repos/acme/repo") return jsonResponse({ default_branch: "main", private: false });
      if (parsed.pathname === "/repos/acme/repo/contents/.github/workflows") {
        return jsonResponse({ message: "not found" }, 404);
      }
      if (parsed.pathname === "/repos/acme/repo/branches/main") return jsonResponse({ commit: { sha: "abc123" } });
      if (parsed.pathname === "/repos/acme/repo/releases" && method === "POST") {
        const body = JSON.parse(String(init?.body));
        createdReleaseTags.push(body.tag_name);
        return jsonResponse({
          id: 11,
          tag_name: body.tag_name,
          name: "Cycloid visual evidence 0002",
          body: GITHUB_EVIDENCE_RELEASE_MARKER,
        });
      }
      if (url.startsWith("https://uploads.github.com/") && method === "POST") {
        uploadReleaseIds.push(parsed.pathname);
        const name = parsed.searchParams.get("name") ?? "missing.png";
        return jsonResponse({
          id: 30,
          name,
          size: 3,
          state: "uploaded",
          digest: null,
          browser_download_url: `https://github.com/acme/repo/releases/download/cycloid-evidence-0002/${name}`,
        });
      }
      if (parsed.pathname === "/repos/acme/repo/pulls/42" && method === "GET") {
        return jsonResponse({ body: "## Changes\nCurrent PR body." });
      }
      if (parsed.pathname === "/repos/acme/repo/pulls/42" && method === "PATCH") {
        patchedBodies.push(JSON.parse(String(init?.body)).body);
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected GitHub fetch: ${method} ${url}`);
    });

    await new GithubReleaseEvidenceService(storage.sql as unknown as SqlStorage, host).publishForPr({
      sessionId: SESSION_ID,
      auth: makeAuth(storage),
      prNumber: 42,
      body: "## Changes\nUpdated visual state.",
    });

    expect(createdReleaseTags).toEqual(["cycloid-evidence-0002"]);
    expect(uploadReleaseIds[0]).toContain("/releases/11/assets");
    expect(patchedBodies[0]).toContain("releases/download/cycloid-evidence-0002/");
  });

  it("logs verification-comment fallback counts when some visual artifacts cannot be prepared", async () => {
    const storage = new FakeStorage();
    seedSessionWithArtifacts(storage, [
      { id: "artifact-after", type: "screenshot", filename: "after.png", label: "After" },
      { id: "artifact-before", type: "screenshot", filename: "before.png", label: "Before" },
    ]);
    const host = makeHost(storage, async (request) => {
      const filename = decodeURIComponent(request.url.split("/").pop() ?? "");
      if (filename === "after.png") return mediaResponse(new Uint8Array([1, 2, 3]), "image/png");
      return new Response("Not found", { status: 404 });
    });

    mockTracedFetch.mockImplementation(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = typeof rawUrl === "string" ? rawUrl : rawUrl instanceof URL ? rawUrl.toString() : rawUrl.url;
      const method = init?.method ?? "GET";
      const parsed = new URL(url);
      if (parsed.pathname === "/repos/acme/repo/releases" && method === "GET") return jsonResponse([]);
      if (parsed.pathname === "/repos/acme/repo/releases/tags/cycloid-evidence-0001") {
        return jsonResponse({ message: "not found" }, 404);
      }
      if (parsed.pathname === "/repos/acme/repo/git/ref/tags/cycloid-evidence-0001") {
        return jsonResponse({ message: "not found" }, 404);
      }
      if (parsed.pathname === "/repos/acme/repo") return jsonResponse({ default_branch: "main", private: false });
      if (parsed.pathname === "/repos/acme/repo/contents/.github/workflows") {
        return jsonResponse({ message: "not found" }, 404);
      }
      if (parsed.pathname === "/repos/acme/repo/branches/main") return jsonResponse({ commit: { sha: "abc123" } });
      if (parsed.pathname === "/repos/acme/repo/releases" && method === "POST") {
        return jsonResponse({
          id: 10,
          tag_name: "cycloid-evidence-0001",
          name: "Cycloid visual evidence 0001",
          body: GITHUB_EVIDENCE_RELEASE_MARKER,
        });
      }
      if (parsed.pathname === "/repos/acme/repo/releases/10/assets" && method === "GET") return jsonResponse([]);
      if (url.startsWith("https://uploads.github.com/") && method === "POST") {
        const name = parsed.searchParams.get("name") ?? "missing.png";
        return jsonResponse({
          id: 21,
          name,
          size: 3,
          state: "uploaded",
          digest: null,
          browser_download_url: `https://github.com/acme/repo/releases/download/cycloid-evidence-0001/${name}`,
        });
      }
      throw new Error(`Unexpected GitHub fetch: ${method} ${url}`);
    });

    const artifacts = await new GithubReleaseEvidenceService(
      storage.sql as unknown as SqlStorage,
      host,
    ).publishArtifactsForVerificationComment({
      sessionId: SESSION_ID,
      auth: makeAuth(storage),
      prNumber: 42,
    });

    expect(artifacts).toEqual([
      expect.objectContaining({
        type: "screenshot",
        label: "After",
        url: expect.stringContaining("releases/download/cycloid-evidence-0001/"),
      }),
      {
        type: "screenshot",
        label: "Before",
        url: "https://app.trycycloid.com/api/sessions/session123456/artifacts/artifact-before/before.png",
        renderMode: "link",
      },
    ]);
    expect(host.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "github_evidence.verification_comment_assets.fallback",
        operation: "artifact_fetch_failed",
        visualArtifactCount: 2,
        preparedArtifactCount: 1,
        fallbackArtifactCount: 1,
      }),
      "github_evidence.verification_comment_assets.fallback",
    );
  });

  it("returns link-only fallback artifacts for verification comments when risky workflows block releases", async () => {
    const storage = new FakeStorage();
    seedSessionWithArtifacts(storage, [
      { id: "artifact-after", type: "screenshot", filename: "after.png", label: "After" },
    ]);
    const host = makeHost(storage, async () => mediaResponse(new Uint8Array([1, 2, 3]), "image/png"));

    mockTracedFetch.mockImplementation(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = typeof rawUrl === "string" ? rawUrl : rawUrl instanceof URL ? rawUrl.toString() : rawUrl.url;
      const method = init?.method ?? "GET";
      const parsed = new URL(url);
      if (parsed.pathname === "/repos/acme/repo/releases" && method === "GET") return jsonResponse([]);
      if (parsed.pathname === "/repos/acme/repo/releases/tags/cycloid-evidence-0001") {
        return jsonResponse({ message: "not found" }, 404);
      }
      if (parsed.pathname === "/repos/acme/repo/git/ref/tags/cycloid-evidence-0001") {
        return jsonResponse({ message: "not found" }, 404);
      }
      if (parsed.pathname === "/repos/acme/repo") return jsonResponse({ default_branch: "main", private: true });
      if (parsed.pathname === "/repos/acme/repo/contents/.github/workflows") {
        return jsonResponse([{ name: "release.yml", path: ".github/workflows/release.yml", type: "file" }]);
      }
      if (parsed.pathname === "/repos/acme/repo/contents/.github/workflows/release.yml") {
        return new Response("on:\n  release:\n    types: [published]\n");
      }
      if (parsed.pathname === "/repos/acme/repo/releases" && method === "POST") {
        throw new Error("release should not be created");
      }
      throw new Error(`Unexpected GitHub fetch: ${method} ${url}`);
    });

    const artifacts = await new GithubReleaseEvidenceService(
      storage.sql as unknown as SqlStorage,
      host,
    ).publishArtifactsForVerificationComment({
      sessionId: SESSION_ID,
      auth: makeAuth(storage),
      prNumber: 42,
    });

    expect(artifacts).toEqual([
      {
        type: "screenshot",
        label: "After",
        url: "https://app.trycycloid.com/api/sessions/session123456/artifacts/artifact-after/after.png",
        renderMode: "link",
      },
    ]);
    expect(host.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "github_evidence.workflow_risk_detected" }),
      "github_evidence.workflow_risk_detected",
    );
    expect(host.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "github_evidence.verification_comment_assets.fallback",
        operation: "workflow_risk_detected",
      }),
      "github_evidence.verification_comment_assets.fallback",
    );
  });

  it("returns link-only fallback artifacts when no verification comment artifacts can be prepared", async () => {
    const storage = new FakeStorage();
    seedSessionWithArtifacts(storage, [
      { id: "artifact-after", type: "screenshot", filename: "after.png", label: "After" },
    ]);
    doDb.insertSessionArtifact(storage.sql as unknown as SqlStorage, {
      artifactId: "artifact-action-feedback",
      sessionId: SESSION_ID,
      type: "screenshot",
      url: `https://app.trycycloid.com/api/sessions/${SESSION_ID}/artifacts/artifact-action-feedback/action-feedback.png`,
      metadata: {
        label: "Action feedback",
        filename: "action-feedback.png",
        contentType: "image/png",
        access: { visibility: "private", expiresAt: null, revokedAt: null },
        kind: "desktop_action_screenshot",
        actionId: "click-1",
        phase: "agent",
        scenarioId: "scenario-1",
      },
      createdAt: Date.now(),
    });
    const host = makeHost(storage, async () => new Response("Not found", { status: 404 }));

    const artifacts = await new GithubReleaseEvidenceService(
      storage.sql as unknown as SqlStorage,
      host,
    ).publishArtifactsForVerificationComment({
      sessionId: SESSION_ID,
      auth: makeAuth(storage),
      prNumber: 42,
    });

    expect(artifacts).toEqual([
      {
        type: "screenshot",
        label: "After",
        url: "https://app.trycycloid.com/api/sessions/session123456/artifacts/artifact-after/after.png",
        renderMode: "link",
      },
    ]);
    expect(mockTracedFetch).not.toHaveBeenCalled();
    expect(host.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "github_evidence.verification_comment_assets.fallback",
        operation: "artifact_fetch_failed",
        visualArtifactCount: 1,
        preparedArtifactCount: 0,
        fallbackArtifactCount: 1,
      }),
      "github_evidence.verification_comment_assets.fallback",
    );
  });

  it("returns all staged desktop evidence fallback links when desktop media preparation fails", async () => {
    const storage = new FakeStorage();
    seedSessionWithArtifacts(storage, [
      {
        id: "desktop-video",
        type: "video",
        filename: "desktop-checkout-flow-walkthrough.webm",
        label: "desktop-checkout-flow-walkthrough.webm",
      },
      {
        id: "desktop-proof-1",
        type: "screenshot",
        filename: "desktop-checkout-flow-proof-1.png",
        label: "desktop-checkout-flow-proof-1.png",
      },
      {
        id: "desktop-proof-2",
        type: "screenshot",
        filename: "desktop-checkout-flow-proof-2.png",
        label: "desktop-checkout-flow-proof-2.png",
      },
      {
        id: "desktop-proof-3",
        type: "screenshot",
        filename: "desktop-checkout-flow-proof-3.png",
        label: "desktop-checkout-flow-proof-3.png",
      },
      {
        id: "desktop-proof-4",
        type: "screenshot",
        filename: "desktop-checkout-flow-proof-4.png",
        label: "desktop-checkout-flow-proof-4.png",
      },
      {
        id: "desktop-action",
        type: "screenshot",
        filename: "action-feedback.png",
        label: "Action feedback",
        metadata: {
          kind: "desktop_action_screenshot",
        },
      },
      {
        id: "desktop-partial",
        type: "video",
        filename: "desktop-checkout-flow-partial.webm",
        label: "desktop-checkout-flow-partial.webm",
      },
    ]);
    const host = makeHost(storage, async () => new Response("Not found", { status: 404 }));

    const artifacts = await new GithubReleaseEvidenceService(
      storage.sql as unknown as SqlStorage,
      host,
    ).publishArtifactsForVerificationComment({
      sessionId: SESSION_ID,
      auth: makeAuth(storage),
      prNumber: 42,
    });

    expect(artifacts.map((artifact) => artifact.label)).toEqual([
      "desktop-checkout-flow-walkthrough.webm",
      "desktop-checkout-flow-proof-1.png",
      "desktop-checkout-flow-proof-2.png",
      "desktop-checkout-flow-proof-3.png",
      "desktop-checkout-flow-proof-4.png",
    ]);
    expect(artifacts.every((artifact) => artifact.renderMode === "link")).toBe(true);
    expect(mockTracedFetch).not.toHaveBeenCalled();
  });

  it("renders prepared screenshots even when a later visual artifact falls back", async () => {
    const storage = new FakeStorage();
    seedSessionWithArtifacts(storage, [
      { id: "artifact-after", type: "screenshot", filename: "after.png", label: "After" },
      { id: "artifact-video", type: "video", filename: "walkthrough.webm", label: "Walkthrough" },
    ]);
    const host = makeHost(storage, async (request) => {
      const filename = decodeURIComponent(request.url.split("/").pop() ?? "");
      if (filename === "after.png") return mediaResponse(new Uint8Array([1, 2, 3]), "image/png");
      return new Response("Not found", { status: 404 });
    });
    const uploadBodies: BodyInit[] = [];
    const patchedBodies: string[] = [];

    mockTracedFetch.mockImplementation(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = typeof rawUrl === "string" ? rawUrl : rawUrl instanceof URL ? rawUrl.toString() : rawUrl.url;
      const method = init?.method ?? "GET";
      const parsed = new URL(url);
      if (parsed.pathname === "/repos/acme/repo/releases" && method === "GET") return jsonResponse([]);
      if (parsed.pathname === "/repos/acme/repo/releases/tags/cycloid-evidence-0001") {
        return jsonResponse({ message: "not found" }, 404);
      }
      if (parsed.pathname === "/repos/acme/repo/git/ref/tags/cycloid-evidence-0001") {
        return jsonResponse({ message: "not found" }, 404);
      }
      if (parsed.pathname === "/repos/acme/repo") return jsonResponse({ default_branch: "main", private: false });
      if (parsed.pathname === "/repos/acme/repo/contents/.github/workflows") {
        return jsonResponse({ message: "not found" }, 404);
      }
      if (parsed.pathname === "/repos/acme/repo/branches/main") return jsonResponse({ commit: { sha: "abc123" } });
      if (parsed.pathname === "/repos/acme/repo/releases" && method === "POST") {
        return jsonResponse({
          id: 10,
          tag_name: "cycloid-evidence-0001",
          name: "Cycloid visual evidence 0001",
          body: GITHUB_EVIDENCE_RELEASE_MARKER,
        });
      }
      if (parsed.pathname === "/repos/acme/repo/releases/10/assets" && method === "GET") return jsonResponse([]);
      if (url.startsWith("https://uploads.github.com/") && method === "POST") {
        uploadBodies.push(init?.body as BodyInit);
        const name = parsed.searchParams.get("name") ?? "missing.png";
        return jsonResponse({
          id: 21,
          name,
          size: 3,
          state: "uploaded",
          digest: null,
          browser_download_url: `https://github.com/acme/repo/releases/download/cycloid-evidence-0001/${name}`,
        });
      }
      if (parsed.pathname === "/repos/acme/repo/pulls/42" && method === "GET") {
        return jsonResponse({ body: "## Changes\nCurrent PR body." });
      }
      if (parsed.pathname === "/repos/acme/repo/pulls/42" && method === "PATCH") {
        patchedBodies.push(JSON.parse(String(init?.body)).body);
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected GitHub fetch: ${method} ${url}`);
    });

    await new GithubReleaseEvidenceService(storage.sql as unknown as SqlStorage, host).publishForPr({
      sessionId: SESSION_ID,
      auth: makeAuth(storage),
      prNumber: 42,
      body: "## Changes\nStale body.",
    });

    expect(uploadBodies).toHaveLength(1);
    expect(patchedBodies[0]).toContain("<img");
    expect(patchedBodies[0]).toContain("releases/download/cycloid-evidence-0001/");
    expect(patchedBodies[0]).toContain(
      "[Walkthrough](https://app.trycycloid.com/api/sessions/session123456/artifacts/",
    );
  });

  it("patches fallback visual evidence with a user token when no installation id is available", async () => {
    const storage = new FakeStorage();
    seedSessionWithArtifacts(storage, [
      { id: "artifact-after", type: "screenshot", filename: "after.png", label: "After" },
    ]);
    const host = makeHost(storage, async () => new Response("Not found", { status: 404 }));
    const patchedBodies: string[] = [];

    mockTracedFetch.mockImplementation(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = typeof rawUrl === "string" ? rawUrl : rawUrl instanceof URL ? rawUrl.toString() : rawUrl.url;
      const method = init?.method ?? "GET";
      const parsed = new URL(url);
      if (parsed.pathname === "/repos/acme/repo/pulls/42" && method === "PATCH") {
        patchedBodies.push(JSON.parse(String(init?.body)).body);
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected GitHub fetch: ${method} ${url}`);
    });

    const auth = {
      ...makeAuth(storage),
      token: "ghu_user",
      tokenSource: "user" as const,
      installationId: undefined,
      installationToken: null,
    };

    await new GithubReleaseEvidenceService(storage.sql as unknown as SqlStorage, host).publishForPr({
      sessionId: SESSION_ID,
      auth,
      prNumber: 42,
      body: "## Changes\nCurrent PR body.",
    });

    expect(patchedBodies).toHaveLength(1);
    expect(patchedBodies[0]).toContain("## Changes\nCurrent PR body.");
    expect(patchedBodies[0]).toContain("[After](https://app.trycycloid.com/api/sessions/session123456/artifacts/");
    await expect(storage.get(LATEST_PR_BODY_STORAGE_KEY)).resolves.toBe(patchedBodies[0]);
  });

  it("deletes starter assets before re-uploading the same visual artifact", async () => {
    const storage = new FakeStorage();
    seedSessionWithArtifacts(storage, [
      { id: "artifact-after", type: "screenshot", filename: "after.png", label: "After" },
    ]);
    const host = makeHost(storage, async () => mediaResponse(new Uint8Array([1, 2, 3]), "image/png"));
    const starterName = "pr-42-sess-session1-art-artifact-039058c6f2c0.png";
    const deletedAssetIds: string[] = [];
    const uploadNames: string[] = [];
    const patchedBodies: string[] = [];

    mockTracedFetch.mockImplementation(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = typeof rawUrl === "string" ? rawUrl : rawUrl instanceof URL ? rawUrl.toString() : rawUrl.url;
      const method = init?.method ?? "GET";
      const parsed = new URL(url);
      if (parsed.pathname === "/repos/acme/repo/releases" && method === "GET") {
        return jsonResponse([
          {
            id: 10,
            tag_name: "cycloid-evidence-0001",
            name: "Cycloid visual evidence 0001",
            body: GITHUB_EVIDENCE_RELEASE_MARKER,
          },
        ]);
      }
      if (parsed.pathname === "/repos/acme/repo/releases/10/assets" && method === "GET") {
        return jsonResponse([
          {
            id: 777,
            name: starterName,
            size: 3,
            state: "starter",
            digest: null,
            browser_download_url: `https://github.com/acme/repo/releases/download/cycloid-evidence-0001/${starterName}`,
          },
        ]);
      }
      if (parsed.pathname === "/repos/acme/repo/releases/assets/777" && method === "DELETE") {
        deletedAssetIds.push("777");
        return new Response(null, { status: 204 });
      }
      if (url.startsWith("https://uploads.github.com/") && method === "POST") {
        const name = parsed.searchParams.get("name") ?? "missing.png";
        uploadNames.push(name);
        return jsonResponse({
          id: 30,
          name,
          size: 3,
          state: "uploaded",
          digest: null,
          browser_download_url: `https://github.com/acme/repo/releases/download/cycloid-evidence-0001/${name}`,
        });
      }
      if (parsed.pathname === "/repos/acme/repo/pulls/42" && method === "GET") {
        return jsonResponse({ body: "## Changes\nCurrent PR body." });
      }
      if (parsed.pathname === "/repos/acme/repo/pulls/42" && method === "PATCH") {
        patchedBodies.push(JSON.parse(String(init?.body)).body);
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected GitHub fetch: ${method} ${url}`);
    });

    await new GithubReleaseEvidenceService(storage.sql as unknown as SqlStorage, host).publishForPr({
      sessionId: SESSION_ID,
      auth: makeAuth(storage),
      prNumber: 42,
      body: "## Changes\nStale body.",
    });

    expect(deletedAssetIds).toEqual(["777"]);
    expect(uploadNames).toEqual([starterName]);
    expect(patchedBodies[0]).toContain(`releases/download/cycloid-evidence-0001/${starterName}`);
  });

  it("falls back when an unmanaged release bucket conflicts with the managed prefix", async () => {
    const storage = new FakeStorage();
    seedSessionWithArtifacts(storage, [
      { id: "artifact-after", type: "screenshot", filename: "after.png", label: "After" },
    ]);
    const host = makeHost(storage, async () => mediaResponse(new Uint8Array([1, 2, 3]), "image/png"));
    const patchedBodies: string[] = [];

    mockTracedFetch.mockImplementation(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = typeof rawUrl === "string" ? rawUrl : rawUrl instanceof URL ? rawUrl.toString() : rawUrl.url;
      const method = init?.method ?? "GET";
      const parsed = new URL(url);
      if (parsed.pathname === "/repos/acme/repo/releases" && method === "GET") {
        return jsonResponse([
          {
            id: 10,
            tag_name: formatEvidenceReleaseTag(1),
            name: "Customer release",
            body: "not cycloid-managed",
          },
        ]);
      }
      if (parsed.pathname === "/repos/acme/repo/pulls/42" && method === "GET") {
        return jsonResponse({ body: "## Changes\nCurrent PR body." });
      }
      if (parsed.pathname === "/repos/acme/repo/pulls/42" && method === "PATCH") {
        patchedBodies.push(JSON.parse(String(init?.body)).body);
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected GitHub fetch: ${method} ${url}`);
    });

    await new GithubReleaseEvidenceService(storage.sql as unknown as SqlStorage, host).publishForPr({
      sessionId: SESSION_ID,
      auth: makeAuth(storage),
      prNumber: 42,
      body: "## Changes\nUpdated visual state.",
    });

    expect(host.log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "github_evidence.fallback_to_links",
        operation: "unmanaged_release_conflict",
      }),
      "github_evidence.fallback_to_links",
    );
    expect(patchedBodies[0]).toContain("https://app.trycycloid.com/api/sessions/session123456/artifacts/");
  });

  it("logs first-bucket creation failure when a repo has no managed evidence releases yet", async () => {
    const storage = new FakeStorage();
    seedSessionWithArtifacts(storage, [
      { id: "artifact-after", type: "screenshot", filename: "after.png", label: "After" },
    ]);
    const host = makeHost(storage, async () => mediaResponse(new Uint8Array([1, 2, 3]), "image/png"));

    mockTracedFetch.mockImplementation(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = typeof rawUrl === "string" ? rawUrl : rawUrl instanceof URL ? rawUrl.toString() : rawUrl.url;
      const method = init?.method ?? "GET";
      const parsed = new URL(url);
      if (parsed.pathname === "/repos/acme/repo/releases" && method === "GET") return jsonResponse([]);
      if (parsed.pathname === "/repos/acme/repo/releases/tags/cycloid-evidence-0001") {
        return jsonResponse({ message: "not found" }, 404);
      }
      if (parsed.pathname === "/repos/acme/repo/git/ref/tags/cycloid-evidence-0001") {
        return jsonResponse({ message: "not found" }, 404);
      }
      if (parsed.pathname === "/repos/acme/repo") return jsonResponse({ default_branch: "main", private: false });
      if (parsed.pathname === "/repos/acme/repo/contents/.github/workflows") {
        return jsonResponse({ message: "not found" }, 404);
      }
      if (parsed.pathname === "/repos/acme/repo/branches/main") return jsonResponse({ commit: { sha: "abc123" } });
      if (parsed.pathname === "/repos/acme/repo/releases" && method === "POST") {
        return jsonResponse({ message: "boom" }, 500);
      }
      throw new Error(`Unexpected GitHub fetch: ${method} ${url}`);
    });

    const artifacts = await new GithubReleaseEvidenceService(
      storage.sql as unknown as SqlStorage,
      host,
    ).publishArtifactsForVerificationComment({
      sessionId: SESSION_ID,
      auth: makeAuth(storage),
      prNumber: 42,
    });

    expect(artifacts).toEqual([
      {
        type: "screenshot",
        label: "After",
        url: "https://app.trycycloid.com/api/sessions/session123456/artifacts/artifact-after/after.png",
        renderMode: "link",
      },
    ]);
    expect(host.log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "github_evidence.release.ensure.listed",
        totalReleaseCount: 0,
        managedReleaseCount: 0,
      }),
      "github_evidence.release.ensure.listed",
    );
    expect(host.log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "github_evidence.release.bucket.create.started",
        bucketNumber: 1,
        releaseTag: "cycloid-evidence-0001",
      }),
      "github_evidence.release.bucket.create.started",
    );
    expect(host.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "github_evidence.release.bucket.create.failed",
        bucketNumber: 1,
        releaseTag: "cycloid-evidence-0001",
        operation: "release_create_failed",
      }),
      "github_evidence.release.bucket.create.failed",
    );
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: "github_evidence.release.bucket.create.failed",
        businessId: "biz-1",
        sessionId: SESSION_ID,
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        bucketNumber: 1,
        releaseTag: "cycloid-evidence-0001",
        operation: "release_create_failed",
        githubStatus: 500,
        errorKind: "github_release_error",
      }),
    );
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: "github_evidence.release.ensure.failed",
        businessId: "biz-1",
        sessionId: SESSION_ID,
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        operation: "release_create_failed",
        githubStatus: 500,
        errorKind: "github_release_error",
      }),
    );
  });
});
