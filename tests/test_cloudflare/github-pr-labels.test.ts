import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ARCANIST_SCHEDULED_LABEL,
  CYCLOID_MEMORY_LABEL,
  CYCLOID_PR_LABEL,
  CYCLOID_PROVENANCE_LABELS,
  E2E_TESTED_LABEL,
} from "../../apps/control-plane-worker/src/constants/pr-labels";
import * as prLabels from "../../apps/control-plane-worker/src/constants/pr-labels";

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

// Mock tracedFetch for addLabels tests
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
});

type GithubPrModule = {
  addLabels: (token: string, owner: string, repo: string, issueNumber: number, labels: string[]) => Promise<void>;
  removeLabel: (token: string, owner: string, repo: string, issueNumber: number, label: string) => Promise<void>;
  setLabels: (token: string, owner: string, repo: string, issueNumber: number, labels: string[]) => Promise<void>;
  listLabels: (token: string, owner: string, repo: string, issueNumber: number) => Promise<string[]>;
};

describe("GitHub PR labels", () => {
  describe("addLabels", () => {
    it("calls GitHub API with correct parameters", async () => {
      fetchMock.mockResolvedValue({ ok: true });

      const modulePath: string = "../../apps/control-plane-worker/src/github/pr";
      const mod = (await import(modulePath)) as unknown as GithubPrModule;
      await mod.addLabels("token123", "owner", "repo", 42, ["needs-review"]);

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/repos/owner/repo/issues/42/labels",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ labels: ["needs-review"] }),
        }),
      );
    });

    it("throws on non-ok response", async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve("Not found") });

      const modulePath: string = "../../apps/control-plane-worker/src/github/pr";
      const mod = (await import(modulePath)) as unknown as GithubPrModule;

      await expect(mod.addLabels("token123", "owner", "repo", 42, ["needs-review"])).rejects.toThrow(
        "GitHub add labels failed (404)",
      );
    });
  });

  describe("removeLabel", () => {
    const modulePath: string = "../../apps/control-plane-worker/src/github/pr";

    it("DELETEs the URL-encoded label and resolves on 204", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 204 });

      const mod = (await import(modulePath)) as unknown as GithubPrModule;
      await expect(mod.removeLabel("token123", "owner", "repo", 42, "review-loop:done")).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [calledUrl, calledOptions] = fetchMock.mock.calls[0] as [string, { method?: string }];
      // Label segment must be percent-encoded (":" -> "%3A").
      expect(calledUrl).toContain("review-loop%3Adone");
      expect(calledUrl).toBe("https://api.github.com/repos/owner/repo/issues/42/labels/review-loop%3Adone");
      expect(calledOptions.method).toBe("DELETE");
    });

    it("resolves (no throw) when the label is already absent (404)", async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve("Label does not exist") });

      const mod = (await import(modulePath)) as unknown as GithubPrModule;
      await expect(mod.removeLabel("token123", "owner", "repo", 42, "review-loop:done")).resolves.toBeUndefined();
    });

    it("throws with the status embedded on a non-404 error", async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 403, text: () => Promise.resolve("Forbidden") });

      const mod = (await import(modulePath)) as unknown as GithubPrModule;
      await expect(mod.removeLabel("token123", "owner", "repo", 42, "review-loop:done")).rejects.toThrow("(403)");
    });
  });

  describe("setLabels", () => {
    const modulePath: string = "../../apps/control-plane-worker/src/github/pr";

    it("PUTs the full label set in one call", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const mod = (await import(modulePath)) as unknown as GithubPrModule;
      await mod.setLabels("token123", "owner", "repo", 42, ["bug", "verification-in-progress"]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/repos/owner/repo/issues/42/labels",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ labels: ["bug", "verification-in-progress"] }),
        }),
      );
    });

    it("throws on non-ok response", async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 422, text: () => Promise.resolve("Unprocessable") });

      const mod = (await import(modulePath)) as unknown as GithubPrModule;
      await expect(mod.setLabels("token123", "owner", "repo", 42, ["bug"])).rejects.toThrow(
        "GitHub set labels failed (422)",
      );
    });
  });

  describe("listLabels", () => {
    const modulePath: string = "../../apps/control-plane-worker/src/github/pr";

    it("returns label names from a single page", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{ name: "bug" }, { name: "verification-pending" }]),
      });

      const mod = (await import(modulePath)) as unknown as GithubPrModule;
      await expect(mod.listLabels("token123", "owner", "repo", 42)).resolves.toEqual(["bug", "verification-pending"]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [calledUrl] = fetchMock.mock.calls[0] as [string];
      expect(calledUrl).toBe("https://api.github.com/repos/owner/repo/issues/42/labels?per_page=100&page=1");
    });

    it("paginates until a short page is returned", async () => {
      const fullPage = Array.from({ length: 100 }, (_, i) => ({ name: `label-${i}` }));
      fetchMock
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(fullPage) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve([{ name: "last" }]) });

      const mod = (await import(modulePath)) as unknown as GithubPrModule;
      const result = await mod.listLabels("token123", "owner", "repo", 42);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(101);
      expect(result[result.length - 1]).toBe("last");
    });

    it("throws on non-ok response", async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve("Server error") });

      const mod = (await import(modulePath)) as unknown as GithubPrModule;
      await expect(mod.listLabels("token123", "owner", "repo", 42)).rejects.toThrow("GitHub list labels failed (500)");
    });
  });

  it("keeps Cycloid provenance labels in precedence order", () => {
    expect(CYCLOID_PROVENANCE_LABELS.at(-1)).toBe(CYCLOID_PR_LABEL);

    const provenanceConstants = Object.entries(prLabels)
      .filter(([, value]) => typeof value === "string" && value.startsWith("cycloid"))
      .map(([, value]) => value);

    expect(CYCLOID_PROVENANCE_LABELS).toEqual([ARCANIST_SCHEDULED_LABEL, CYCLOID_MEMORY_LABEL, CYCLOID_PR_LABEL]);
    expect(new Set(CYCLOID_PROVENANCE_LABELS)).toEqual(new Set(provenanceConstants));
    expect(CYCLOID_PROVENANCE_LABELS).not.toContain(E2E_TESTED_LABEL);
  });
});
