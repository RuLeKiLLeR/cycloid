// Unit tests for the artifact access-metadata logic.
//
// `createArtifactAccessMetadata` decides whether an uploaded artifact gets a
// public signed URL (anyone with the link can fetch for ~7 days) or a
// private same-origin path (auth required, gated on session access). The
// rule: only screenshots from sessions targeting a public repo get public
// URLs. Everything else is private. `repoPrivate === null` (not yet
// resolved) MUST default to private to fail safe.
import { describe, expect, it } from "vitest";

import {
  createArtifactAccessMetadata,
  isAuthedReadableArtifactType,
  isPrSafeArtifactType,
  normalizeArtifactContentType,
  normalizeRequestedArtifactFilename,
  PUBLIC_ARTIFACT_URL_TTL_MS,
} from "../../apps/control-plane-worker/src/session/artifacts";
import { WEBM_VIDEO_MIME_TYPE, WEBM_VIDEO_SIZE_LIMIT_BYTES } from "../../shared/constants/artifacts";

describe("createArtifactAccessMetadata", () => {
  const NOW = 1_700_000_000_000;

  it("returns a public, signed URL for a screenshot from a public repo", () => {
    const access = createArtifactAccessMetadata("screenshot", false, NOW);
    expect(access).toEqual({
      visibility: "public",
      expiresAt: NOW + PUBLIC_ARTIFACT_URL_TTL_MS,
      revokedAt: null,
    });
  });

  it("returns a public, signed URL for a video from a public repo", () => {
    const access = createArtifactAccessMetadata("video", false, NOW);
    expect(access).toEqual({
      visibility: "public",
      expiresAt: NOW + PUBLIC_ARTIFACT_URL_TTL_MS,
      revokedAt: null,
    });
  });

  it("keeps the WebM-only video contract in shared constants", () => {
    expect(WEBM_VIDEO_MIME_TYPE).toBe("video/webm");
    expect(WEBM_VIDEO_SIZE_LIMIT_BYTES).toBe(50 * 1024 * 1024);
  });

  it("returns private (no signed URL) for a screenshot from a private repo", () => {
    const access = createArtifactAccessMetadata("screenshot", true, NOW);
    expect(access).toEqual({
      visibility: "private",
      expiresAt: null,
      revokedAt: null,
    });
  });

  it("can force desktop action screenshots private even for public repos", () => {
    const access = createArtifactAccessMetadata("screenshot", false, NOW, { forcePrivate: true });
    expect(access).toEqual({
      visibility: "private",
      expiresAt: null,
      revokedAt: null,
    });
  });

  it("fail-safes to private when repo visibility hasn't been resolved yet", () => {
    const access = createArtifactAccessMetadata("screenshot", null, NOW);
    expect(access).toEqual({
      visibility: "private",
      expiresAt: null,
      revokedAt: null,
    });
  });

  it("treats undefined repo visibility as private (defensive)", () => {
    const access = createArtifactAccessMetadata("screenshot", undefined, NOW);
    expect(access.visibility).toBe("private");
    expect(access.expiresAt).toBeNull();
  });

  it.each([
    ["log", false],
    ["log", true],
    ["log", null],
    ["report", false],
    ["report", true],
    ["artifact", false],
    ["video", true],
    ["video", null],
  ])(
    "returns private for artifact type %s when repo visibility is not public-video/screenshot eligible",
    (artifactType, repoPrivate) => {
      const access = createArtifactAccessMetadata(artifactType, repoPrivate, NOW);
      expect(access).toEqual({
        visibility: "private",
        expiresAt: null,
        revokedAt: null,
      });
    },
  );
});

describe("normalizeArtifactContentType", () => {
  it("accepts WebP screenshot artifacts", () => {
    expect(normalizeArtifactContentType("image/webp", "screenshot")).toBe("image/webp");
  });

  it("accepts HTML report artifacts without weakening screenshot validation", () => {
    expect(normalizeArtifactContentType("text/html; charset=utf-8", "report")).toBe("text/html");
    expect(normalizeArtifactContentType("text/html", "screenshot")).toBeNull();
    expect(normalizeArtifactContentType("application/octet-stream", "report")).toBeNull();
  });

  it("keeps video artifacts WebM-only", () => {
    expect(normalizeArtifactContentType(WEBM_VIDEO_MIME_TYPE, "video")).toBe(WEBM_VIDEO_MIME_TYPE);
    expect(normalizeArtifactContentType("video/mp4", "video")).toBeNull();
    expect(normalizeArtifactContentType(WEBM_VIDEO_MIME_TYPE, "report")).toBeNull();
  });

  it("accepts text log artifacts without making arbitrary artifact uploads text-capable", () => {
    expect(normalizeArtifactContentType("text/plain; charset=utf-8", "log")).toBe("text/plain");
    expect(normalizeArtifactContentType("application/json", "log")).toBe("application/json");
    expect(normalizeArtifactContentType("text/plain", "screenshot")).toBeNull();
    expect(normalizeArtifactContentType("application/octet-stream", "log")).toBeNull();
  });
});

describe("normalizeRequestedArtifactFilename", () => {
  it("accepts single-segment artifact filenames", () => {
    expect(normalizeRequestedArtifactFilename("shot.png")).toBe("shot.png");
    expect(normalizeRequestedArtifactFilename("trace.v1.log")).toBe("trace.v1.log");
  });

  it("rejects path separators and dot segments", () => {
    expect(normalizeRequestedArtifactFilename("../shot.png")).toBeNull();
    expect(normalizeRequestedArtifactFilename("nested/shot.png")).toBeNull();
    expect(normalizeRequestedArtifactFilename("nested\\shot.png")).toBeNull();
    expect(normalizeRequestedArtifactFilename(".")).toBeNull();
    expect(normalizeRequestedArtifactFilename("..")).toBeNull();
  });
});

describe("artifact readability", () => {
  it("keeps public PR-safe artifacts narrower than authenticated readable artifacts", () => {
    expect(isPrSafeArtifactType("screenshot")).toBe(true);
    expect(isPrSafeArtifactType("video")).toBe(true);
    expect(isPrSafeArtifactType("report")).toBe(false);
    expect(isPrSafeArtifactType("log")).toBe(false);

    expect(isAuthedReadableArtifactType("screenshot")).toBe(true);
    expect(isAuthedReadableArtifactType("video")).toBe(true);
    expect(isAuthedReadableArtifactType("report")).toBe(true);
    expect(isAuthedReadableArtifactType("log")).toBe(true);
  });
});
