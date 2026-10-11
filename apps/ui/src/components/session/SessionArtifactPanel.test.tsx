import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEmptyTokenUsage } from "../../hooks/session-state/transcript-helpers";
import type { SessionDetail } from "../../types";
import { ToastProvider } from "../Toast";
import { SessionArtifactPanel } from "./SessionArtifactPanel";
import type { FileChange } from "./workbench";

// The default Summary tab mounts the Retry next-action (useToast + API call);
// stub the action functions so no fetch escapes the panel tests. Spread the
// real module: sibling panels import other api/sessions exports.
vi.mock("../../api/sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/sessions")>()),
  retrySession: vi.fn(async () => undefined),
}));

let container: HTMLDivElement;
let root: Root;

function installLocalStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
}

beforeEach(() => {
  installLocalStorage();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
});

function makeSession(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    sessionId: "s-artifacts-1",
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

function LocationProbe() {
  const location = useLocation();
  return <output data-location-search>{location.search}</output>;
}

function render(
  session: SessionDetail,
  extra: { changes?: FileChange[]; isComplete?: boolean; initialEntry?: string } = {},
) {
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[extra.initialEntry ?? "/sessions/s-artifacts-1"]}>
        <ToastProvider>
          <SessionArtifactPanel
            session={session}
            hydrated={true}
            promptCount={1}
            changes={extra.changes ?? []}
            screenshots={[]}
            logTail={[]}
            contextUsage={null}
            tokenUsage={createEmptyTokenUsage()}
            runtimeActionInFlight={null}
            onRuntimeAction={() => {}}
            isComplete={extra.isComplete ?? false}
            requestText={null}
            finalMessage={null}
            prError={null}
            onViewPr={() => {}}
          />
          <LocationProbe />
        </ToastProvider>
      </MemoryRouter>,
    );
  });
}

function tabLabels(): string[] {
  return Array.from(container.querySelectorAll('[role="tab"]')).map((el) => el.textContent?.trim() ?? "");
}

function selectedTab(): string | null {
  return container.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? null;
}

describe("SessionArtifactPanel tab registry", () => {
  it("renders the fixed tabs from session start, without a PR tab", () => {
    render(makeSession());
    expect(tabLabels()).toEqual(["Summary", "Run", "Files", "Report"]);
    expect(selectedTab()).toBe("Summary");
  });

  it("appends a numbered PR tab when the session has a published PR", () => {
    render(makeSession({ prUrl: "https://github.com/trycycloid/cycloid/pull/123" }));
    expect(tabLabels()).toEqual(["Summary", "Run", "Files", "Report", "PR #123"]);
  });

  it("drops the PR tab and falls back to Summary when the PR signal disappears", () => {
    const withPr = makeSession({ prUrl: "https://github.com/trycycloid/cycloid/pull/7" });
    render(withPr);
    const prTab = Array.from(container.querySelectorAll('[role="tab"]')).find((el) =>
      el.textContent?.includes("PR #7"),
    ) as HTMLButtonElement;
    act(() => prTab.click());
    expect(selectedTab()).toBe("PR #7");

    render(makeSession({ prUrl: null }));
    expect(tabLabels()).toEqual(["Summary", "Run", "Files", "Report"]);
    expect(selectedTab()).toBe("Summary");
  });

  it("writes the selected tab to the artifact query parameter", () => {
    const session = makeSession();
    render(session);
    const changesTab = Array.from(container.querySelectorAll('[role="tab"]')).find(
      (el) => el.textContent?.trim() === "Files",
    ) as HTMLButtonElement;
    act(() => changesTab.click());
    expect(selectedTab()).toBe("Files");
    expect(container.querySelector("[data-location-search]")?.textContent).toBe("?artifact=changes");
  });

  it("opens the tab named in the URL and falls back when it no longer exists", () => {
    const session = makeSession({ prUrl: null });
    render(session, { initialEntry: "/sessions/s-artifacts-1?artifact=report" });
    expect(selectedTab()).toBe("Report");
    act(() => root.unmount());
    root = createRoot(container);
    // Stale links to the retired Checks tab and to a missing PR tab both fall
    // back to Summary.
    render(session, { initialEntry: "/sessions/s-artifacts-1?artifact=checks" });
    expect(selectedTab()).toBe("Summary");
    act(() => root.unmount());
    root = createRoot(container);
    render(session, { initialEntry: "/sessions/s-artifacts-1?artifact=pr" });
    expect(selectedTab()).toBe("Summary");
  });

  it("shows verification evidence in the Report tab before the session completes", () => {
    render(
      makeSession({
        verificationSummary: {
          outcome: "verified",
          commands: [{ command: "npm test", status: "passed", exitCode: 0, source: "post_execution", checks: [] }],
          checksPassed: [],
          skippedChecks: [],
          visualArtifacts: [],
          runtimeEvidence: null,
          caveats: [],
        },
      }),
      { initialEntry: "/sessions/s-artifacts-1?artifact=report" },
    );
    expect(container.textContent).toContain("Verification");
    expect(container.textContent).toContain("npm test");
    // Still gated: the full report waits for session completion.
    expect(container.textContent).toContain("Report will be available when the session finishes.");
    expect(tabLabels()).not.toContain("PR");
  });
});
