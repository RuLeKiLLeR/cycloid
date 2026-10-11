import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEmptyTokenUsage } from "../../hooks/session-state/transcript-helpers";
import type { SessionTokenUsage } from "../../hooks/session-state/types";
import type { SessionDetail } from "../../types";
import { ConfirmProvider } from "../ConfirmDialog";
import { ToastProvider } from "../Toast";
import type { ContextUsage, RuntimeLogEntry } from "./runtime";
import { SessionRuntimePanel } from "./SessionRuntimePanel";

let container: HTMLDivElement;
let root: Root;
const onAction = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function makeSession(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    sessionId: "s-runtime-1",
    phase: "running",
    prUrl: null,
    createdAt: Date.now(),
    model: { providerID: "anthropic", modelID: "claude-fable-5" },
    title: "Test session",
    queueLength: 0,
    repoUrl: "https://github.com/trycycloid/cycloid",
    lastBranch: null,
    baseBranch: "main",
    ...overrides,
  } as SessionDetail;
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <ConfirmProvider>{children}</ConfirmProvider>
    </ToastProvider>
  );
}

/** Routes the panel through an Outlet carrying a read-only support user. */
function SupportShell({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <Routes>
        <Route element={<Outlet context={{ user: { impersonation: { readOnly: true } } }} />}>
          <Route path="*" element={<>{children}</>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

function render(
  session: SessionDetail,
  logTail: RuntimeLogEntry[] = [],
  contextUsage: ContextUsage | null = null,
  tokenUsage: SessionTokenUsage = createEmptyTokenUsage(),
  { supportView = false }: { supportView?: boolean } = {},
) {
  const panel = (
    <SessionRuntimePanel
      session={session}
      logTail={logTail}
      contextUsage={contextUsage}
      tokenUsage={tokenUsage}
      pendingAction={null}
      onAction={onAction}
    />
  );
  act(() => {
    root.render(<Providers>{supportView ? <SupportShell>{panel}</SupportShell> : panel}</Providers>);
  });
}

function click(button: HTMLButtonElement) {
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function findButton(label: string): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === label) ?? null;
}

describe("SessionRuntimePanel", () => {
  // Keep these assertions aligned with customer-facing runtime copy.
  it("renders sandbox state, agent config, repo, and branch from the session record", () => {
    render(makeSession());
    expect(container.textContent).toContain("Active");
    expect(container.textContent).toContain("claude-fable-5");
    expect(container.textContent).toContain("Anthropic");
    expect(container.textContent).toContain("trycycloid/cycloid");
    expect(container.textContent).toContain("main");
    // No context event streamed — the context readout is omitted, not faked.
    expect(container.textContent).not.toContain("Context");
    expect(container.textContent).toContain("No activity yet");
  });

  it("keeps sandbox identity behind the support gate", () => {
    const provenance = {
      runtimeProvenance: {
        bootMode: "repo_image",
        sandboxImageVersion: "v42",
        runtime: { provider: "e2b", backend: "e2b_cloud", sandboxId: "sbx_123", reportedAt: 1 },
        updatedAt: 1,
      },
    } as Partial<SessionDetail>;

    // Normal view: identity/provenance rows are operator debug data — hidden.
    render(makeSession(provenance));
    expect(container.textContent).not.toContain("Sandbox ID");
    expect(container.textContent).not.toContain("e2b_cloud");
    expect(container.textContent).not.toContain("repo_image");

    // Support view: rows render once provenance reached the record.
    render(makeSession(provenance), [], null, createEmptyTokenUsage(), { supportView: true });
    expect(container.textContent).toContain("Sandbox ID");
    expect(container.textContent).toContain("sbx_123");
    expect(container.textContent).toContain("e2b_cloud");
    expect(container.textContent).toContain("repo_image");
    expect(container.textContent).toContain("v42");
  });

  it("prefers the live sandbox id over the provenance report (support view)", () => {
    render(
      makeSession({
        sandboxId: "sbx_live",
        runtimeProvenance: {
          bootMode: "repo_image",
          runtime: { provider: "e2b", backend: "e2b_cloud", sandboxId: "sbx_provenance", reportedAt: 1 },
          updatedAt: 1,
        },
      }),
      [],
      null,
      createEmptyTokenUsage(),
      { supportView: true },
    );
    expect(container.textContent).toContain("Sandbox ID");
    expect(container.textContent).toContain("sbx_live");
    expect(container.textContent).not.toContain("sbx_provenance");
  });

  it("folds the connection state into the single sandbox badge", () => {
    // Field absent (older record) — the badge title carries no connection claim.
    render(makeSession({ phase: "running" }));
    expect(container.querySelector('[title="Active"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Connected");

    // Connected: still one badge; the connection rides the title + live dot.
    render(makeSession({ phase: "running", sandboxConnected: true }));
    expect(container.querySelector('[title="Active · Connected"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Connected");

    // Disconnected: the sandbox state label itself says so.
    render(makeSession({ phase: "running", sandboxConnected: false }));
    expect(container.textContent).toContain("Disconnected");

    // Terminal session: connectivity is a tautology, omit it.
    render(makeSession({ phase: "stopped", sandboxConnected: false }));
    expect(container.textContent).not.toContain("Disconnected");
  });

  it("renders the reasoning effort row only when the session carries one", () => {
    render(makeSession());
    expect(container.textContent).not.toContain("Reasoning");
    render(makeSession({ reasoningEffort: "high" }));
    expect(container.textContent).toContain("Reasoning");
    expect(container.textContent).toContain("high");
  });

  it("renders the exact context readout with its event history", () => {
    render(makeSession(), [], {
      contextTokens: 91_000,
      contextWindow: 400_000,
      fillPercent: 23,
      events: [
        { id: "p1:c2", kind: "compaction_complete", label: "compacted", detail: "364K → 45K" },
        { id: "p1:c1", kind: "context_fill_warning", label: "fill warning", detail: "91% · 364K / 400K" },
      ],
    });
    expect(container.textContent).toContain("91K / 400K (23%)");
    // History is collapsed behind a details toggle, default closed.
    const details = container.querySelector("details");
    expect(details?.open).toBe(false);
    expect(container.textContent).toContain("Compaction history (2)");
    expect(container.textContent).toContain("compacted");
    expect(container.textContent).toContain("364K → 45K");
    expect(container.textContent).toContain("fill warning");
  });

  it("renders categorized activity entries newest first", () => {
    render(makeSession(), [
      { id: "p1:atl2", kind: "publish", label: "pr.open", detail: "Opened PR #12", status: "completed" },
      { id: "p1:t2", kind: "test", label: "bash", detail: "npm test", status: "completed" },
      { id: "p1:t1", kind: "edit", label: "edit", detail: "src/a.ts", status: "completed" },
    ]);
    expect(container.textContent).toContain("publish");
    expect(container.textContent).toContain("Opened PR #12");
    expect(container.textContent).toContain("test");
    expect(container.textContent).not.toContain("No activity yet");
  });

  it("hides the activity tail on terminal sessions — it implies live work", () => {
    render(makeSession({ phase: "completed" }), [
      { id: "p1:t1", kind: "edit", label: "edit", detail: "src/a.ts", status: "completed" },
    ]);
    expect(container.textContent).not.toContain("Recent activity");
    expect(container.textContent).not.toContain("src/a.ts");
  });

  it("renders label-free step entries as tag + detail only", () => {
    render(makeSession(), [
      { id: "p1:ap1", kind: "step", label: null, detail: "Installing dependencies", status: "running" },
    ]);
    expect(container.textContent).toContain("step");
    expect(container.textContent).toContain("Installing dependencies");
    expect(container.textContent).not.toContain("progress");
  });

  it("offers stop while running and archives only quiescent sessions", () => {
    render(makeSession({ phase: "running" }));
    expect(findButton("Stop")).not.toBeNull();
    expect(findButton("Wake")).toBeNull();
    expect(findButton("Archive")).toBeNull();

    render(makeSession({ phase: "completed" }));
    expect(findButton("Stop")).toBeNull();
    expect(findButton("Wake")).not.toBeNull();
    expect(findButton("Archive")).not.toBeNull();

    render(makeSession({ phase: "archived" }));
    expect(findButton("Restore")).toBeNull();
    expect(findButton("Archive")).toBeNull();
  });

  it("hides stop while the sandbox is provisioning", () => {
    render(makeSession({ phase: "running", sandboxSubstate: "creating" }));
    expect(findButton("Stop")).toBeNull();
  });

  it("delegates stop to the parent owner", () => {
    render(makeSession({ phase: "running" }));
    click(findButton("Stop")!);
    expect(onAction).toHaveBeenCalledWith("stop");
  });

  it("delegates wake and archive to the parent owner", () => {
    render(makeSession({ phase: "completed" }));
    click(findButton("Wake")!);
    click(findButton("Archive")!);
    expect(onAction.mock.calls).toEqual([["wake"], ["archive"]]);
  });

  it("renders usage as two rows: total tokens and cost at <=3 decimals", () => {
    render(makeSession(), [], null, {
      ...createEmptyTokenUsage(),
      input: 1234,
      output: 567,
      totalTokens: 1801,
      totalBilledTokens: 2001,
      context: 1801,
      contextWindow: 200000,
      cost: 0.0123,
      model: "claude-fable-5",
    });
    expect(container.textContent).toContain("Total tokens");
    expect(container.textContent).toContain("1,801 / 200,000 (1%)");
    expect(container.textContent).toContain("$0.012");
    expect(container.textContent).not.toContain("$0.0123");
    // The input/output/cache split is gone from this surface.
    expect(container.textContent).not.toContain("1,234");
    expect(container.textContent).not.toContain("Cache read");
  });

  it("keeps spawn time behind the support gate", () => {
    render(makeSession({ spawnDurationMs: 8236 }), [], null);
    expect(container.textContent).not.toContain("Spawn time");
    render(makeSession({ spawnDurationMs: 8236 }), [], null, createEmptyTokenUsage(), { supportView: true });
    expect(container.textContent).toContain("Spawn time");
    expect(container.textContent).toContain("8.2s");
  });
});
