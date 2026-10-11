import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RepoContext } from "../api/repo-context";
import { ContextPage, defaultContextTab } from "./ContextPage";

const mocks = vi.hoisted(() => ({
  fetchRepoContext: vi.fn(),
  layout: {
    repos: [{ fullName: "acme/widgets" }],
    reposLoaded: true,
    selectedRepo: { fullName: "acme/widgets" },
  },
}));

vi.mock("../api/repo-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/repo-context")>()),
  fetchRepoContext: mocks.fetchRepoContext,
}));
vi.mock("../components/Layout", () => ({ useLayoutContext: () => mocks.layout }));

const context: RepoContext = {
  repo: { owner: "acme", name: "widgets" },
  instructionFiles: { available: false, precedenceNote: "Resolved in the sandbox.", files: [] },
  mcpServers: [
    {
      id: "mcp-1",
      name: "Docs server",
      description: null,
      transport: "http",
      enabled: true,
      validationStatus: "untested",
      scopeType: "business",
      discoveredToolCount: 4,
      secretRefs: [],
      headerSecretRefs: {},
    },
  ],
  skills: { available: false, note: "Resolved in the sandbox.", items: [] },
  secrets: { testCredentials: [], repoRuntimeEnvVarNames: ["API_URL"] },
  setup: { repoLayerSource: null, businessDefaultLayerSource: null, note: "Cycloid default." },
  reviewSettings: { expectedBots: [], mergeConflictResolutionEnabled: false },
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mocks.fetchRepoContext.mockResolvedValue(context);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function renderPage() {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <ContextPage />
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function clickSection(label: string) {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>("nav button")).find((item) =>
    item.textContent?.includes(label),
  );
  expect(button).toBeDefined();
  act(() => button!.click());
}

describe("ContextPage", () => {
  it("provides a compact mobile selector and direct management links", async () => {
    await renderPage();

    const selector = container.querySelector('select[aria-label="Select a context source"]') as HTMLSelectElement;
    expect(selector).not.toBeNull();
    expect(Array.from(selector.options).map((option) => option.text)).toEqual([
      "Instruction files",
      "MCP servers",
      "Skills",
      "Secrets & env",
      "Setup",
      "Review settings",
    ]);

    clickSection("MCP servers");
    expect(container.querySelector('a[href="/settings/mcp-servers"]')?.textContent).toContain("Manage");

    clickSection("Secrets & env");
    expect(container.querySelector('a[href="/settings/repositories"]')?.textContent).toContain("Manage");

    act(() => {
      selector.value = "setup";
      selector.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).toContain("Repository layer");
    expect(container.querySelector('a[href="/settings/repositories"]')?.textContent).toContain("Manage");

    clickSection("Review settings");
    expect(container.textContent).toContain("Merge conflict resolution");
    // The removed wait-window setting must not resurface as "undefined min".
    expect(container.textContent).not.toContain("Review timeout");
    expect(container.textContent).not.toContain("undefined");
    expect(container.querySelector('a[href="/settings/repositories"]')?.textContent).toContain("Manage");
  });

  it("keeps counts in the nav badge only and renders enums as sentence-case labels", async () => {
    await renderPage();

    // Nav descriptions are qualitative; the badge carries the number.
    const mcpNavButton = Array.from(container.querySelectorAll<HTMLButtonElement>("nav button")).find((button) =>
      button.textContent?.includes("MCP servers"),
    );
    expect(mcpNavButton?.textContent).toContain("Tool servers available to sessions");
    expect(mcpNavButton?.textContent).not.toContain("1 tool servers");
    expect(mcpNavButton?.textContent).toContain("1");

    // Raw enum values map to sentence-case labels.
    clickSection("MCP servers");
    expect(container.textContent).toContain("Untested");
    expect(container.textContent).not.toContain("untested");
  });

  it("opens on a bucket with content instead of a runtime-resolved empty panel", async () => {
    await renderPage();

    // Instructions are runtime-resolved (unavailable) in this fixture, so the
    // page opens on MCP servers — the first bucket with real rows.
    const selector = container.querySelector('select[aria-label="Select a context source"]') as HTMLSelectElement;
    expect(selector.value).toBe("mcp");
    expect(container.textContent).toContain("Docs server");
  });

  it("renders plain-language copy for runtime-resolved buckets, never storage internals", async () => {
    await renderPage();

    clickSection("Instruction files");
    expect(container.textContent).toContain("Read from your repo at session start");
    expect(container.textContent).toContain("Cycloid doesn't store them");

    clickSection("Setup");
    expect(container.textContent).toContain("run inside the sandbox");

    // The server notes (which name D1 and JSON columns) are not rendered.
    expect(container.textContent).not.toContain("Not shown here");
    expect(container.textContent).not.toContain("persisted");
    expect(container.textContent).not.toContain("D1");
    expect(container.textContent).not.toContain("_json");
  });
});

describe("defaultContextTab", () => {
  it("picks the first bucket with content, falling back to review settings", () => {
    expect(defaultContextTab(context)).toBe("mcp");
    expect(defaultContextTab({ ...context, mcpServers: [] })).toBe("secrets");
    expect(
      defaultContextTab({
        ...context,
        mcpServers: [],
        secrets: { testCredentials: [], repoRuntimeEnvVarNames: [] },
      }),
    ).toBe("review");
    expect(
      defaultContextTab({
        ...context,
        mcpServers: [],
        secrets: { testCredentials: [], repoRuntimeEnvVarNames: [] },
        setup: { ...context.setup, repoLayerSource: { sourceId: "src-1", updatedAt: 1 } },
      }),
    ).toBe("setup");
  });
});
