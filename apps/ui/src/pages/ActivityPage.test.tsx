import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActivityData } from "../api/activity";
import { ActivityPage } from "./ActivityPage";

const mocks = vi.hoisted(() => ({
  fetchActivity: vi.fn(),
  layout: { user: { businessRole: "admin" as "admin" | "member" } },
}));

vi.mock("../api/activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/activity")>()),
  fetchActivity: mocks.fetchActivity,
}));
vi.mock("../components/Layout", () => ({ useLayoutContext: () => mocks.layout }));

const activity: ActivityData = {
  windowDays: 7,
  since: { iso: "2026-07-03T00:00:00.000Z", ms: 1_783_036_800_000 },
  scope: "user",
  canViewOrganization: true,
  sessionsBySource: { total: 2, slack: 1, automation: 0, child: 0, user: 1 },
  totals: {
    sessions: 2,
    sessionsWithPr: 2,
    sessionsMerged: 1,
    sessionsClosed: 1,
    sessionsWithFeedback: 1,
    feedbackTurns: 2,
    inputTokens: 1_000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsdMicros: 2_000_000,
    mergedAdditions: 30,
    mergedDeletions: 10,
    mergedLocSessions: 1,
  },
  sessions: [
    {
      sessionId: "session-1",
      title: "Fix checkout",
      repoOwner: "acme",
      repoName: "store",
      ownerLogin: "octocat",
      createdAt: "2026-07-09T12:00:00.000Z",
      source: "user",
      promptCount: 3,
      feedbackTurns: 2,
      inputTokens: 1_000,
      outputTokens: 500,
      costUsdMicros: 2_000_000,
      prUrl: "https://github.com/acme/store/pull/1",
      prStatus: "merged",
      mergedAdditions: 30,
      mergedDeletions: 10,
    },
  ],
  recentEvents: [],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mocks.layout.user.businessRole = "admin";
  mocks.fetchActivity.mockResolvedValue(activity);
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
        <ActivityPage />
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("ActivityPage", () => {
  it("renders usage, conversion, merged LOC, feedback, and session detail", async () => {
    await renderPage();

    expect(container.textContent).toContain("Tokens / session");
    expect(container.textContent).toContain("Merged LOC");
    expect(container.textContent).toContain("Feedback");
    expect(container.textContent).toContain("Session outcomes");
    expect(container.textContent).toContain("Fix checkout");
    expect(container.textContent).toContain("40");
    expect(container.querySelector('a[href="/sessions/session-1"]')).not.toBeNull();
    expect(container.textContent).toContain("Organization");
    // Pluralization and second-free timestamps in the ledger.
    expect(container.textContent).toContain("2 follow-up turns");
    expect(container.textContent).not.toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });

  it("singularizes a lone follow-up turn and explains dense metrics via titles", async () => {
    mocks.fetchActivity.mockResolvedValue({
      ...activity,
      totals: { ...activity.totals, feedbackTurns: 1 },
    });
    await renderPage();

    expect(container.textContent).toContain("1 follow-up turn");
    expect(container.textContent).not.toContain("1 follow-up turns");
    const titled = Array.from(container.querySelectorAll("[title]")).map((el) => el.getAttribute("title") ?? "");
    expect(titled.some((title) => title.includes("merged PRs"))).toBe(true);
    expect(titled.some((title) => title.includes("follow-up prompts"))).toBe(true);
  });

  it("does not offer organization scope to a non-admin", async () => {
    mocks.layout.user.businessRole = "member";
    await renderPage();

    expect(container.textContent).not.toContain("Organization");
    expect(mocks.fetchActivity).toHaveBeenCalledWith(7, "user");
  });
});
