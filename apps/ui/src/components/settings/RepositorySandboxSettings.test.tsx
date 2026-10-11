import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  SandboxLayerBuildHistoryItem,
  SandboxLayerResolutionPreview,
  SandboxLayerSelectionDetails,
} from "../../api/sandbox-layers";
import { RepositorySandboxSettings } from "./RepositorySandboxSettings";

const mocks = vi.hoisted(() => ({
  createSandboxLayerBuildRequest: vi.fn(),
  fetchSandboxLayerAssignments: vi.fn(),
  fetchSandboxLayerResolutionPreview: vi.fn(),
  fetchSandboxLayerBuildHistory: vi.fn(),
  fetchSandboxLayerBuildLogs: vi.fn(),
}));

vi.mock("../../api/sandbox-layers", () => mocks);

// Let React know act() drives this environment (silences the act warning).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.now();

function selection(overrides: Partial<SandboxLayerSelectionDetails> = {}): SandboxLayerSelectionDetails {
  return {
    tier: "repo_local",
    sourceRepo: "acme/widgets",
    sourceId: "src-1",
    buildId: "build-1",
    templateId: "tmpl-abcdef123456",
    commitSha: "abc123def4567890",
    resourceProfileKey: "default",
    manifestPath: ".cycloid/sandbox.json",
    layerPath: ".cycloid/sandbox",
    baseTemplateRef: "arc-base-template",
    baseVersion: "base-v10",
    currentBaseVersion: "base-v10",
    baseSource: "registry",
    baseVersionQuality: "versioned",
    baseStatus: "active",
    createdBy: { userId: 7, login: "octocat", name: "Octo Cat" },
    builtAt: NOW - 60_000,
    activeUpdatedAt: NOW - 60_000,
    smokeStatus: "passed",
    ...overrides,
  };
}

function customResolution(overrides: Partial<SandboxLayerResolutionPreview> = {}): SandboxLayerResolutionPreview {
  const details = overrides.selection ?? selection();
  return {
    repo: "acme/widgets",
    resourceProfileKey: "default",
    selected: {
      tier: details.tier,
      sourceRepo: details.sourceRepo,
      sourceId: details.sourceId,
      buildId: details.buildId,
      providerArtifactRef: details.templateId,
    },
    selection: details,
    misses: [],
    latestRepoBuild: null,
    fallback: null,
    ...overrides,
  };
}

function fallbackResolution(overrides: Partial<SandboxLayerResolutionPreview> = {}): SandboxLayerResolutionPreview {
  return {
    repo: "acme/widgets",
    resourceProfileKey: "default",
    selected: null,
    selection: null,
    misses: [],
    latestRepoBuild: null,
    fallback: { reason: "no_sandbox_layer_selected", templateId: "tmpl-fallback9999" },
    ...overrides,
  };
}

function historyItem(overrides: Partial<SandboxLayerBuildHistoryItem> = {}): SandboxLayerBuildHistoryItem {
  return {
    id: "build-1",
    status: "completed",
    sourceRepo: "acme/widgets",
    commitSha: "abc123def4567890",
    resourceProfileKey: "default",
    templateId: "tmpl-abcdef123456",
    baseTemplateRef: "arc-base-template",
    baseVersion: "base-v10",
    baseSource: "registry",
    baseVersionQuality: "versioned",
    createdBy: { userId: 7, login: "octocat", name: "Octo Cat" },
    createdAt: NOW - 120_000,
    startedAt: NOW - 110_000,
    completedAt: NOW - 60_000,
    smokeStatus: "passed",
    failureSummary: null,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchSandboxLayerAssignments.mockResolvedValue({ businessDefault: null, repoAssignments: [] });
  mocks.createSandboxLayerBuildRequest.mockResolvedValue({ id: "build-new", status: "queued" });
  mocks.fetchSandboxLayerBuildHistory.mockResolvedValue([]);
  mocks.fetchSandboxLayerBuildLogs.mockResolvedValue([]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function flush() {
  // Flush the dynamic-import + fetch promise chains behind the effects. The
  // dynamic import of the (mocked) api module resolves on a macrotask, so a
  // microtask-only flush is not enough.
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(overrides: Partial<Parameters<typeof RepositorySandboxSettings>[0]> = {}) {
  await act(async () => {
    root.render(
      <RepositorySandboxSettings
        businessId="biz-1"
        selectedRepo="acme/widgets"
        reposLoaded
        hasRepos
        canAccessIntegrationDebug={false}
        {...overrides}
      />,
    );
  });
  await flush();
}

function findButton(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((el) => el.textContent === label);
  expect(button, `button "${label}"`).toBeDefined();
  return button!;
}

describe("RepositorySandboxSettings", () => {
  it("leads with a plain-language summary of an active custom environment", async () => {
    mocks.fetchSandboxLayerResolutionPreview.mockResolvedValue(customResolution());
    await render();

    expect(container.textContent).toContain("Custom environment");
    expect(container.textContent).toContain("Ready");
    expect(container.textContent).toContain("built from acme/widgets (configured in this repo)");
    expect(container.textContent).toContain("by @octocat");
    expect(container.textContent).toContain("setup check passed");
    expect(container.textContent).toContain("Standard machine");
    // The internal profile key never renders as-is for the default tier.
    expect(container.textContent).not.toContain("resource_profile");
    // History is available to admins; technical details need the debug capability.
    expect(container.textContent).toContain("Environment history");
    expect(container.textContent).not.toContain("Technical details");
  });

  it("badges an outdated base image loudly with a rebuild warning", async () => {
    mocks.fetchSandboxLayerResolutionPreview.mockResolvedValue(
      customResolution({ selection: selection({ baseStatus: "outdated", currentBaseVersion: "base-v11" }) }),
    );
    await render();

    expect(container.textContent).toContain("Rebuild needed");
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("outdated base image");
    expect(alert?.textContent).toContain("New sessions may fail to start");
    expect(alert?.textContent).toContain("base-v11");
    expect(container.querySelector('a[href*="acme/widgets/blob/HEAD/.cycloid/sandbox.json"]')?.textContent).toBe(
      "Manage source",
    );
    expect(findButton("Rebuild environment").disabled).toBe(false);
  });

  it("describes the Cycloid default environment when no custom layer matches", async () => {
    mocks.fetchSandboxLayerResolutionPreview.mockResolvedValue(fallbackResolution());
    await render();

    expect(container.textContent).toContain("Cycloid default environment");
    expect(container.textContent).toContain("Default");
    expect(container.textContent).toContain("sessions start from Cycloid's standard image");
    // The raw image ID moved out of the default view into the gated
    // Technical details panel (which only renders for a custom selection).
    expect(container.textContent).not.toContain("tmpl-fallbac");
  });

  it("shows a failed custom setup falling back to the default image", async () => {
    mocks.fetchSandboxLayerResolutionPreview.mockResolvedValue(
      fallbackResolution({
        latestRepoBuild: {
          id: "build-9",
          status: "failed",
          error: "npm install exited 1",
          commitSha: "abc123def4567890",
          templateId: null,
          baseTemplateRef: "arc-base-template",
          baseVersion: "base-v10",
          createdBy: { userId: 7, login: "octocat", name: "Octo Cat" },
          resourceProfileKey: "default",
          manifestPath: ".cycloid/sandbox.json",
          layerPath: ".cycloid/sandbox",
          createdAt: NOW - 120_000,
          updatedAt: NOW - 60_000,
          smoke: null,
        },
        fallback: { reason: "custom_sandbox_failed", templateId: "tmpl-fallback9999" },
      }),
    );
    await render();

    expect(container.textContent).toContain("Setup failed");
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Sessions fall back to the Cycloid default image");
    expect(alert?.textContent).toContain("npm install exited 1");
    expect(container.textContent).toContain("Last failure:");

    mocks.createSandboxLayerBuildRequest.mockRejectedValueOnce(new Error("Build queue unavailable"));
    await act(async () => {
      findButton("Rebuild environment").click();
    });
    await flush();
    expect(container.textContent).toContain("Build queue unavailable");

    const firstIdempotencyKey = mocks.createSandboxLayerBuildRequest.mock.calls[0]?.[3].idempotencyKey;
    expect(firstIdempotencyKey).toEqual(expect.any(String));
    await act(async () => {
      findButton("Rebuild environment").click();
    });
    await flush();

    expect(mocks.createSandboxLayerBuildRequest).toHaveBeenLastCalledWith("biz-1", "acme", "widgets", {
      manifestPath: ".cycloid/sandbox.json",
      targetRepo: { owner: "acme", name: "widgets" },
      idempotencyKey: firstIdempotencyKey,
    });
  });

  it("surfaces in-progress build state and explains why a needed rebuild is disabled", async () => {
    mocks.fetchSandboxLayerResolutionPreview.mockResolvedValue(
      customResolution({
        selection: selection({ baseStatus: "outdated", currentBaseVersion: "base-v11" }),
        latestRepoBuild: {
          id: "build-10",
          status: "building_provider",
          error: null,
          commitSha: "abc123def4567890",
          templateId: null,
          baseTemplateRef: "arc-base-template",
          baseVersion: "base-v10",
          createdBy: { userId: 7, login: "octocat", name: "Octo Cat" },
          resourceProfileKey: "default",
          manifestPath: ".cycloid/sandbox.json",
          layerPath: ".cycloid/sandbox",
          createdAt: NOW - 30_000,
          updatedAt: NOW - 10_000,
          smoke: null,
        },
      }),
    );
    await render();

    expect(container.textContent).toContain("Building");
    expect(container.textContent).toContain("Build updated");
    expect(container.textContent).toContain("A build is already in progress.");
    expect(findButton("Rebuild environment").disabled).toBe(true);
  });

  it("renders environment history with readable statuses and failure causes on expand", async () => {
    mocks.fetchSandboxLayerResolutionPreview.mockResolvedValue(customResolution());
    mocks.fetchSandboxLayerBuildHistory.mockResolvedValue([
      historyItem(),
      historyItem({
        id: "build-2",
        status: "failed",
        smokeStatus: "failed",
        failureSummary: {
          phase: "smoke",
          reason: "smoke command exited 1",
          command: "npm test",
          exitCode: 1,
          activeTemplateUnchanged: true,
        },
      }),
    ]);
    await render();

    await act(async () => {
      findButton("Show history").click();
    });
    await flush();

    expect(mocks.fetchSandboxLayerBuildHistory).toHaveBeenCalledWith("biz-1", {
      sourceRepo: "acme/widgets",
      targetRepo: "acme/widgets",
      limit: 20,
    });
    expect(container.textContent).toContain("Succeeded");
    expect(container.textContent).toContain("Failed");
    // Raw statuses never leak into the list.
    expect(container.textContent).not.toContain("building_provider");
    expect(container.textContent).toContain("Setup check failed: smoke command exited 1");
    expect(container.textContent).toContain("the previous environment stayed active.");
    expect(container.textContent).toContain("Show logs");

    mocks.fetchSandboxLayerBuildLogs.mockResolvedValue([
      { id: "log-1", build_id: "build-2", sequence: 1, message: "Provider image build failed", created_at: NOW },
    ]);
    await act(async () => {
      findButton("Show logs").click();
    });
    await flush();
    expect(container.textContent).toContain("Provider image build failed");
  });

  it("exposes diagnostics and technical details to internal debug users", async () => {
    mocks.fetchSandboxLayerResolutionPreview.mockResolvedValue(customResolution());
    mocks.fetchSandboxLayerBuildHistory.mockResolvedValue([
      historyItem({
        id: "build-2",
        status: "failed",
        failureSummary: {
          phase: "provider_build",
          reason: "image build failed",
          activeTemplateUnchanged: false,
        },
      }),
    ]);
    await render({ canAccessIntegrationDebug: true });

    expect(container.textContent).toContain("Technical details");
    await act(async () => {
      findButton("Show details").click();
    });
    expect(container.textContent).toContain("arc-base-template");

    await act(async () => {
      findButton("Show history").click();
    });
    await flush();
    expect(container.textContent).toContain("Image build failed: image build failed");
    await act(async () => {
      findButton("Show logs").click();
    });
    await flush();
    expect(mocks.fetchSandboxLayerBuildLogs).toHaveBeenCalledWith("biz-1", "build-2", { limit: 20 });
  });

  it("keeps history collapsed and summary empty-safe while repositories load", async () => {
    await render({ reposLoaded: false, hasRepos: false, selectedRepo: "" });
    expect(container.textContent).toContain("Loading repositories…");
    expect(mocks.fetchSandboxLayerResolutionPreview).not.toHaveBeenCalled();

    await render({ reposLoaded: true, hasRepos: false, selectedRepo: "" });
    expect(container.textContent).toContain("No repositories available.");
  });
});
