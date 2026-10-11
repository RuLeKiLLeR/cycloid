import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import type { PrInboxItem } from "../../api/pr-inbox";
import { PrRow } from "./PrRow";

function item(overrides: Partial<PrInboxItem> = {}): PrInboxItem {
  return {
    sessionId: "abcd1234-5678-90ef-abcd-1234567890ef",
    prUrl: "https://github.com/acme/webapp/pull/421",
    prNumber: 421,
    title: "Fix login redirect",
    repoOwner: "acme",
    repoName: "webapp",
    headBranch: "arc/login-redirect",
    draft: false,
    state: "x",
    bucket: "needs_review",
    phase: "x",
    feChip: "x",
    labels: [],
    stageSection: "x",
    cycloidDone: { state: "done", outcome: "success", reasons: [] },
    model: null,
    agentRuntimeBackend: null,
    initiationMode: "user",
    linkedTicket: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderRow(row: PrInboxItem): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <PrRow item={row} />
    </MemoryRouter>,
  );
}

describe("PrRow", () => {
  it("does not repeat the bucket label in every row", () => {
    const html = renderRow(item());
    expect(html).not.toContain("Needs review");
  });

  it("navigates whole-row to the PR artifact via a router link", () => {
    const html = renderRow(item());
    expect(html).toContain('href="/sessions/abcd1234-5678-90ef-abcd-1234567890ef?artifact=pr"');
    expect(html).toContain("Open PR session: Fix login redirect");
  });

  it("renders a head-branch copy button labeled with the branch name", () => {
    const html = renderRow(item());
    expect(html).toContain("Copy branch arc/login-redirect");
    expect(html).toContain("arc/login-redirect");
  });

  it("omits the branch copy button when there is no head branch", () => {
    const html = renderRow(item({ headBranch: null }));
    expect(html).not.toContain("Copy branch");
  });

  it("does not render a session short-id chip", () => {
    const html = renderRow(item());
    expect(html).not.toContain("Cycloid session abcd1234");
  });

  it("renders a Slack thread chip only when the row has a linked ticket", () => {
    const withThread = renderRow(item({ linkedTicket: { source: "slack", channel: "C0123", threadTs: "1.2" } }));
    expect(withThread).toContain("Slack thread in C0123");

    const without = renderRow(item());
    expect(without).not.toContain("Slack thread in");
  });

  it("keeps an explicit GitHub action and omits it without a PR URL", () => {
    const html = renderRow(item());
    expect(html).toContain("Open PR on GitHub");

    const withoutUrl = renderRow(item({ prUrl: null }));
    expect(withoutUrl).not.toContain("Open PR on GitHub");
  });

  it("does not repeat the bucket status the group header already states", () => {
    const html = renderRow(item({ bucket: "closed" }));
    expect(html).not.toContain("Closed");
  });

  it("leads with the cycloid sub-state only when it varies from settled", () => {
    const settled = renderRow(item());
    expect(settled).not.toContain("Working");
    expect(settled).not.toContain("Needs attention");

    const working = renderRow(item({ cycloidDone: { state: "working", outcome: null, reasons: [] } }));
    expect(working).toContain("Working");

    const needsAttention = renderRow(item({ cycloidDone: { state: "done", outcome: "needs_attention", reasons: [] } }));
    expect(needsAttention).toContain("Needs attention");
  });

  it("suppresses stale working sub-state on closed PRs but keeps needs-attention", () => {
    const working = renderRow(
      item({ bucket: "closed", cycloidDone: { state: "working", outcome: null, reasons: [] } }),
    );
    expect(working).not.toContain("Working");

    const needsAttention = renderRow(
      item({ bucket: "closed", cycloidDone: { state: "done", outcome: "needs_attention", reasons: [] } }),
    );
    expect(needsAttention).toContain("Needs attention");
  });
});
