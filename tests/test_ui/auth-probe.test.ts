import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchHasAuthenticatedSession, fetchIsAuthenticated, fetchUser } from "../../apps/ui/src/api/auth-probe";
import type { User } from "../../apps/ui/src/types";

type VoidAuthProbe = () => ReturnType<typeof fetchIsAuthenticated>;

const MOCK_USER: User = {
  id: 1,
  login: "auth-user",
  name: "Auth User",
  email: "auth@example.com",
  avatarUrl: "https://example.com/avatar.png",
  businessId: "biz-1",
  businessRole: "admin",
  sharedSessions: false,
  linearConnected: false,
  jiraConnected: false,
  jiraSiteName: null,
  notionConnected: false,
  slackConnected: false,
  slackNeedsReconnect: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("auth probes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchUser returns authenticated with the user payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ authenticated: true, user: MOCK_USER })),
    );

    await expect(fetchUser()).resolves.toEqual({ status: "authenticated", value: MOCK_USER });
  });

  it("fetchUser returns unauthenticated on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ authenticated: false }, 401)),
    );

    await expect(fetchUser()).resolves.toEqual({ status: "unauthenticated" });
  });

  it("fetchUser returns unauthenticated on an explicit authenticated false body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ authenticated: false })),
    );

    await expect(fetchUser()).resolves.toEqual({ status: "unauthenticated" });
  });

  it.each([500, 429])("fetchUser returns transient on HTTP %s", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "temporary" }, status)),
    );

    await expect(fetchUser()).resolves.toEqual({ status: "transient" });
  });

  it("fetchUser returns transient when the request rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("network down"))),
    );

    await expect(fetchUser()).resolves.toEqual({ status: "transient" });
  });

  it.each<[string, VoidAuthProbe, string]>([
    ["fetchIsAuthenticated", fetchIsAuthenticated, "/auth/status"],
    ["fetchHasAuthenticatedSession", fetchHasAuthenticatedSession, "/auth/me"],
  ])("%s returns authenticated only on authenticated true", async (_name, probe, expectedUrl) => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ authenticated: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(probe()).resolves.toEqual({ status: "authenticated", value: undefined });
    expect(fetchMock.mock.calls[0][0]).toBe(expectedUrl);
  });

  it("fetchIsAuthenticated bypasses caches and asks for JSON", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ authenticated: true }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchIsAuthenticated();

    expect(fetchMock).toHaveBeenCalledWith("/auth/status", {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
  });

  it.each<[string, VoidAuthProbe]>([
    ["fetchIsAuthenticated", fetchIsAuthenticated],
    ["fetchHasAuthenticatedSession", fetchHasAuthenticatedSession],
  ])("%s returns unauthenticated on 401", async (_name, probe) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ authenticated: false }, 401)),
    );

    await expect(probe()).resolves.toEqual({ status: "unauthenticated" });
  });

  it.each<[string, VoidAuthProbe]>([
    ["fetchIsAuthenticated", fetchIsAuthenticated],
    ["fetchHasAuthenticatedSession", fetchHasAuthenticatedSession],
  ])("%s returns unauthenticated on authenticated false", async (_name, probe) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ authenticated: false })),
    );

    await expect(probe()).resolves.toEqual({ status: "unauthenticated" });
  });

  it.each<[string, VoidAuthProbe, number]>([
    ["fetchIsAuthenticated", fetchIsAuthenticated, 500],
    ["fetchIsAuthenticated", fetchIsAuthenticated, 429],
    ["fetchHasAuthenticatedSession", fetchHasAuthenticatedSession, 500],
    ["fetchHasAuthenticatedSession", fetchHasAuthenticatedSession, 429],
  ])("%s returns transient on HTTP %s", async (_name, probe, status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "temporary" }, status)),
    );

    await expect(probe()).resolves.toEqual({ status: "transient" });
  });

  it.each<[string, VoidAuthProbe]>([
    ["fetchIsAuthenticated", fetchIsAuthenticated],
    ["fetchHasAuthenticatedSession", fetchHasAuthenticatedSession],
  ])("%s returns transient when the request rejects", async (_name, probe) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("network down"))),
    );

    await expect(probe()).resolves.toEqual({ status: "transient" });
  });
});
