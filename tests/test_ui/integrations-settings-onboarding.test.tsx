import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearApiCache } from "../../apps/ui/src/api/cache";
import { ConfirmProvider } from "../../apps/ui/src/components/ConfirmDialog";
import { IntegrationsSettings } from "../../apps/ui/src/components/settings/IntegrationsSettings";
import type { Repo, UserIntegrations } from "../../apps/ui/src/types";
import {
  ONBOARDING_ACTION_TYPES,
  ONBOARDING_REASON_CODES,
  ONBOARDING_STEP_STATUS,
  type OnboardingStep,
} from "../../shared/constants/onboarding";
import { INTEGRATION_LIFECYCLE_STAGE } from "../../shared/enums/integration-lifecycle";

const TEST_REPO: Repo = {
  fullName: "acme/widgets",
  url: "https://github.com/acme/widgets",
  private: true,
  defaultBranch: "main",
};

const layoutMocks = vi.hoisted(() => ({
  defaultUser: {
    id: 1,
    login: "testuser",
    name: "Test User",
    email: "test@example.com",
    avatarUrl: "https://example.com/avatar.png",
    businessId: "biz-1",
    businessRole: "member" as const,
    sharedSessions: false,
    linearConnected: false,
    slackConnected: false,
    slackNeedsReconnect: false,
  },
  user: null as unknown,
  capabilities: { canManageBusinessIntegrations: false },
  selectedRepo: {
    fullName: "acme/widgets",
    url: "https://github.com/acme/widgets",
    private: true,
    defaultBranch: "main",
  } as Repo | null,
  onLinearChange: vi.fn(),
  onSlackChange: vi.fn(),
}));

vi.mock("../../apps/ui/src/components/Layout.tsx", () => ({
  useLayoutContext: () => layoutMocks,
}));

vi.mock("../../apps/ui/src/hooks/useEffects.ts", async () => {
  const React = await import("react");
  return {
    useMountEffect: (effect: () => void | (() => void)) => {
      React.useEffect(effect, []);
    },
    useSyncEffect: React.useEffect,
    useLayoutSyncEffect: React.useLayoutEffect,
  };
});

let happyWindow: Window;
let onboardingResponse: OnboardingStep[];
let githubSummaryResponse: {
  integrationId: string;
  stage: string;
  status: "passed" | "failed" | "skipped";
  reasonCode: string | null;
  message: string | null;
  createdAt: number;
  userMessage?: string | null;
} | null;
let userIntegrationsResponse: UserIntegrations;

function installDomGlobals(windowInstance: Window) {
  const globals = {
    window: windowInstance,
    document: windowInstance.document,
    navigator: windowInstance.navigator,
    localStorage: windowInstance.localStorage,
    location: windowInstance.location,
    history: windowInstance.history,
    HTMLElement: windowInstance.HTMLElement,
    SVGElement: windowInstance.SVGElement,
    Node: windowInstance.Node,
    Event: windowInstance.Event,
    MouseEvent: windowInstance.MouseEvent,
    getComputedStyle: windowInstance.getComputedStyle.bind(windowInstance),
    requestAnimationFrame: windowInstance.requestAnimationFrame.bind(windowInstance),
    cancelAnimationFrame: windowInstance.cancelAnimationFrame.bind(windowInstance),
  };

  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    writable: true,
    value: true,
  });
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

async function renderWithSearch(search: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(
      createElement(
        ConfirmProvider,
        null,
        createElement(
          MemoryRouter,
          { initialEntries: [`/settings/integrations${search}`] },
          createElement(IntegrationsSettings),
        ),
      ),
    );
    await flushAsyncWork();
  });

  if (container.textContent === "") {
    await act(async () => {
      await flushAsyncWork();
    });
  }

  return {
    container,
    async rerender() {
      await act(async () => {
        root.render(
          createElement(
            ConfirmProvider,
            null,
            createElement(
              MemoryRouter,
              { initialEntries: [`/settings/integrations${search}`] },
              createElement(IntegrationsSettings),
            ),
          ),
        );
        await flushAsyncWork();
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
        await flushAsyncWork();
      });
      container.remove();
    },
  };
}

async function waitForText(container: HTMLElement, text: string) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if ((container.textContent ?? "").includes(text)) return;
    await act(async () => {
      await flushAsyncWork();
    });
  }
  expect(container.textContent ?? "").toContain(text);
}

function makeGithubSteps(overrides?: Partial<Record<OnboardingStep["id"], Partial<OnboardingStep>>>): OnboardingStep[] {
  const base: Record<OnboardingStep["id"], OnboardingStep> = {
    github_login: {
      id: "github_login",
      title: "GitHub",
      owner: "user",
      required: true,
      status: ONBOARDING_STEP_STATUS.CONNECTED,
      reasonCode: ONBOARDING_REASON_CODES.GITHUB_LOGGED_IN,
      actionType: ONBOARDING_ACTION_TYPES.NONE,
    },
    github_business_authorized: {
      id: "github_business_authorized",
      title: "GitHub Business Access",
      owner: "admin",
      required: true,
      status: ONBOARDING_STEP_STATUS.CONNECTED,
      reasonCode: ONBOARDING_REASON_CODES.GITHUB_BUSINESS_AUTHORIZED,
      actionType: ONBOARDING_ACTION_TYPES.NONE,
    },
    github_app_installed: {
      id: "github_app_installed",
      title: "GitHub App",
      owner: "user",
      required: true,
      status: ONBOARDING_STEP_STATUS.CONNECTED,
      reasonCode: ONBOARDING_REASON_CODES.GITHUB_APP_INSTALLED,
      actionType: ONBOARDING_ACTION_TYPES.NONE,
    },
    github_repo_access: {
      id: "github_repo_access",
      title: "Repository Access",
      owner: "user",
      required: true,
      status: ONBOARDING_STEP_STATUS.CONNECTED,
      reasonCode: ONBOARDING_REASON_CODES.GITHUB_REPO_ACCESS_VERIFIED,
      actionType: ONBOARDING_ACTION_TYPES.NONE,
    },
    openai_key: {
      id: "openai_key",
      title: "OpenAI",
      owner: "user",
      required: false,
      status: ONBOARDING_STEP_STATUS.NOT_CONNECTED,
      reasonCode: ONBOARDING_REASON_CODES.CREDENTIALS_MISSING,
      actionType: ONBOARDING_ACTION_TYPES.CONNECT,
    },
    linear_oauth: {
      id: "linear_oauth",
      title: "Linear",
      owner: "user",
      required: false,
      status: ONBOARDING_STEP_STATUS.NOT_CONNECTED,
      reasonCode: ONBOARDING_REASON_CODES.OAUTH_NOT_CONNECTED,
      actionType: ONBOARDING_ACTION_TYPES.CONNECT,
    },
  };

  if (overrides) {
    for (const [stepId, partial] of Object.entries(overrides)) {
      if (!partial) continue;
      base[stepId as OnboardingStep["id"]] = {
        ...base[stepId as OnboardingStep["id"]],
        ...partial,
      };
    }
  }

  return Object.values(base);
}

describe("IntegrationsSettings onboarding-driven GitHub checklist", () => {
  beforeEach(() => {
    clearApiCache();
    happyWindow = new Window();
    happyWindow.location.href = "https://app.trycycloid.com/settings/integrations";
    installDomGlobals(happyWindow);
    vi.clearAllMocks();

    layoutMocks.user = layoutMocks.defaultUser;
    layoutMocks.selectedRepo = TEST_REPO;
    onboardingResponse = makeGithubSteps();
    githubSummaryResponse = null;
    userIntegrationsResponse = {
      availableIntegrations: ["github", "linear", "openai"],
      integrationTools: [],
      integrationScopes: { linear: "user" },
      currentHealth: {},
    };

    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);

      if (url === "/api/github/install-url") {
        return new Response(JSON.stringify({ url: "https://github.com/apps/cycloid/installations/new" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url === "/api/user/integrations") {
        return new Response(JSON.stringify(userIntegrationsResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.startsWith("/api/onboarding/status")) {
        return new Response(JSON.stringify({ ok: true, steps: onboardingResponse }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url === "/api/integrations/me") {
        return new Response(
          JSON.stringify({
            ok: true,
            integrations: {
              github: githubSummaryResponse,
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders distinct remediation when the GitHub App is not installed", async () => {
    onboardingResponse = makeGithubSteps({
      github_app_installed: {
        status: ONBOARDING_STEP_STATUS.NOT_CONNECTED,
        reasonCode: ONBOARDING_REASON_CODES.GITHUB_APP_NOT_INSTALLED,
        actionType: ONBOARDING_ACTION_TYPES.MANAGE_ACCESS,
      },
    });

    const { container, unmount } = await renderWithSearch("");

    await waitForText(container, "Install the GitHub App");
    expect(container.textContent).toContain("Install the Cycloid GitHub App for acme");

    await unmount();
  });

  it("renders distinct remediation when business authorization is missing", async () => {
    onboardingResponse = makeGithubSteps({
      github_business_authorized: {
        status: ONBOARDING_STEP_STATUS.NOT_CONNECTED,
        reasonCode: ONBOARDING_REASON_CODES.GITHUB_BUSINESS_NOT_AUTHORIZED,
        actionType: ONBOARDING_ACTION_TYPES.ASK_ADMIN,
      },
    });

    const { container, unmount } = await renderWithSearch("");

    await waitForText(container, "Business access required");
    expect(container.textContent).toContain(
      "Ask an organization admin to authorize your GitHub account for this Cycloid business.",
    );

    await unmount();
  });

  it("renders persistent GitHub remediation from the lifecycle summary", async () => {
    githubSummaryResponse = {
      integrationId: "github",
      stage: INTEGRATION_LIFECYCLE_STAGE.PROVIDER_PROBE_PASSED,
      status: "failed",
      reasonCode: "token_refresh_failed",
      message: "GitHub credentials could not be refreshed.",
      userMessage: "GitHub credentials could not be refreshed. Reconnect GitHub and try again.",
      createdAt: 1_700_000_000_000,
    };

    const { container, unmount } = await renderWithSearch("");

    await waitForText(container, "Reconnect GitHub");
    expect(container.textContent).toContain(
      "GitHub credentials could not be refreshed. Reconnect GitHub and try again.",
    );

    await unmount();
  });

  it("does not show stale healthy current health beside a failed GitHub connection check", async () => {
    githubSummaryResponse = {
      integrationId: "github",
      stage: INTEGRATION_LIFECYCLE_STAGE.PROVIDER_PROBE_PASSED,
      status: "failed",
      reasonCode: "token_refresh_failed",
      message: "GitHub credentials could not be refreshed.",
      userMessage: "GitHub credentials could not be refreshed. Reconnect GitHub and try again.",
      createdAt: 1_700_000_000_000,
    };
    userIntegrationsResponse = {
      availableIntegrations: ["github", "linear", "openai"],
      integrationTools: [],
      integrationScopes: { linear: "user" },
      currentHealth: {
        github: {
          state: "healthy",
          source: "lifecycle",
          status: "passed",
          checkedAt: 1_699_999_999_000,
          reasonCode: null,
          diagnostic: "provider_probe_passed",
          message: null,
        },
      },
    };

    const { container, unmount } = await renderWithSearch("");

    await waitForText(container, "Reconnect GitHub");
    expect(container.textContent).not.toContain("Last checked");

    await unmount();
  });

  it("does not append the current selected repo to lifecycle repo access failures", async () => {
    githubSummaryResponse = {
      integrationId: "github",
      stage: INTEGRATION_LIFECYCLE_STAGE.PROVIDER_PROBE_PASSED,
      status: "failed",
      reasonCode: "repo_access_denied",
      message: "GitHub couldn't confirm repository access. Reconnect GitHub or grant the app access.",
      userMessage: "GitHub couldn't confirm repository access. Reconnect GitHub or grant the app access.",
      createdAt: 1_700_000_000_000,
    };

    const { container, unmount } = await renderWithSearch("");

    await waitForText(container, "Repository access is still blocked");
    expect(container.textContent).toContain(
      "GitHub couldn't confirm repository access. Reconnect GitHub or grant the app access.",
    );
    expect(container.textContent).not.toContain("Check access for acme/widgets");

    await unmount();
  });

  it("keeps healthy GitHub connection status silent when the latest probe passed", async () => {
    githubSummaryResponse = {
      integrationId: "github",
      stage: INTEGRATION_LIFECYCLE_STAGE.PROVIDER_PROBE_PASSED,
      status: "passed",
      reasonCode: null,
      message: "GitHub verification passed.",
      createdAt: 1_700_000_000_000,
    };

    const { container, unmount } = await renderWithSearch("");

    await act(async () => {
      await flushAsyncWork();
    });
    expect(container.textContent).not.toContain("Latest connection check passed");
    expect(container.textContent).not.toContain("Reconnect GitHub");

    await unmount();
  });

  it("clears stale lifecycle remediation while a new user's summary is loading", async () => {
    let resolveSummary: ((value: typeof githubSummaryResponse) => void) | null = null;
    let summaryCallCount = 0;
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);

      if (url === "/api/github/install-url") {
        return new Response(JSON.stringify({ url: "https://github.com/apps/cycloid/installations/new" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url === "/api/user/integrations") {
        return new Response(JSON.stringify(userIntegrationsResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.startsWith("/api/onboarding/status")) {
        return new Response(JSON.stringify({ ok: true, steps: onboardingResponse }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url === "/api/integrations/me") {
        summaryCallCount += 1;
        if (summaryCallCount === 1) {
          return new Response(
            JSON.stringify({
              ok: true,
              integrations: {
                github: {
                  integrationId: "github",
                  stage: INTEGRATION_LIFECYCLE_STAGE.PROVIDER_PROBE_PASSED,
                  status: "failed",
                  reasonCode: "token_refresh_failed",
                  message: "GitHub credentials could not be refreshed.",
                  userMessage: "GitHub credentials could not be refreshed. Reconnect GitHub and try again.",
                  createdAt: 1_700_000_000_000,
                },
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }

        return new Promise((resolve) => {
          resolveSummary = (value) =>
            resolve(
              new Response(
                JSON.stringify({
                  ok: true,
                  integrations: {
                    github: value,
                  },
                }),
                {
                  status: 200,
                  headers: { "content-type": "application/json" },
                },
              ),
            );
        });
      }

      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const { container, rerender, unmount } = await renderWithSearch("");

    await waitForText(container, "Reconnect GitHub");
    layoutMocks.user = { ...layoutMocks.defaultUser, id: 2, login: "seconduser" };
    await rerender();

    expect(container.textContent).not.toContain("Checking connection health");
    expect(container.textContent).not.toContain("Reconnect GitHub");
    expect(container.textContent).not.toContain(
      "GitHub credentials could not be refreshed. Reconnect GitHub and try again.",
    );

    await act(async () => {
      resolveSummary?.({
        integrationId: "github",
        stage: INTEGRATION_LIFECYCLE_STAGE.PROVIDER_PROBE_PASSED,
        status: "passed",
        reasonCode: null,
        message: "GitHub verification passed.",
        createdAt: 1_700_000_100_000,
      });
      await flushAsyncWork();
    });

    expect(container.textContent).not.toContain("Latest connection check passed");
    expect(container.textContent).not.toContain("Reconnect GitHub");
    await unmount();
  });

  it("does not fetch or render GitHub setup details before business membership is established", async () => {
    layoutMocks.user = { ...layoutMocks.defaultUser, businessRole: null };
    onboardingResponse = makeGithubSteps({
      github_app_installed: {
        status: ONBOARDING_STEP_STATUS.NOT_CONNECTED,
        reasonCode: ONBOARDING_REASON_CODES.GITHUB_APP_NOT_INSTALLED,
        actionType: ONBOARDING_ACTION_TYPES.MANAGE_ACCESS,
      },
    });

    const { container, unmount } = await renderWithSearch("");

    await waitForText(container, "Access unavailable");
    expect(container.textContent).toContain("Contact your administrator.");
    expect(container.textContent).not.toContain("Install the GitHub App");
    expect(container.textContent).not.toContain("Checking readiness for acme/widgets.");
    const fetchCalls = (globalThis.fetch as unknown as { mock: { calls: Array<[unknown]> } }).mock.calls;
    expect(fetchCalls.some(([input]) => String(input).startsWith("/api/onboarding/status"))).toBe(false);

    await unmount();
  });

  it("renders distinct remediation when setup is waiting on webhook sync", async () => {
    onboardingResponse = makeGithubSteps({
      github_app_installed: {
        status: ONBOARDING_STEP_STATUS.NOT_CONNECTED,
        reasonCode: ONBOARDING_REASON_CODES.GITHUB_APP_INSTALL_PENDING_WEBHOOK_SYNC,
        actionType: ONBOARDING_ACTION_TYPES.NONE,
      },
    });

    const { container, unmount } = await renderWithSearch("");

    await waitForText(container, "Waiting for GitHub setup to finish");
    expect(container.textContent).toContain("still waiting for the installation webhook sync");

    await unmount();
  });

  it("renders distinct remediation when repository access is denied", async () => {
    onboardingResponse = makeGithubSteps({
      github_repo_access: {
        status: ONBOARDING_STEP_STATUS.NOT_CONNECTED,
        reasonCode: ONBOARDING_REASON_CODES.GITHUB_REPO_ACCESS_DENIED,
        actionType: ONBOARDING_ACTION_TYPES.MANAGE_ACCESS,
      },
    });

    const { container, unmount } = await renderWithSearch("");

    await waitForText(container, "Repository access is still blocked");
    expect(container.textContent).toContain("acme/widgets is not currently granted to Cycloid");

    await unmount();
  });

  it("renders distinct remediation when repository access check fails", async () => {
    onboardingResponse = makeGithubSteps({
      github_repo_access: {
        status: ONBOARDING_STEP_STATUS.LOOKUP_FAILED,
        reasonCode: ONBOARDING_REASON_CODES.GITHUB_REPO_ACCESS_CHECK_FAILED,
        actionType: ONBOARDING_ACTION_TYPES.NONE,
      },
    });

    const { container, unmount } = await renderWithSearch("");

    await waitForText(container, "Repository access check failed");
    expect(container.textContent).toContain("Cycloid couldn't confirm access to acme/widgets.");

    await unmount();
  });

  it("renders the legacy Slack row even when Slack is absent from available integrations", async () => {
    const { container, unmount } = await renderWithSearch("");

    await waitForText(container, "Slack");
    expect(container.textContent).toContain("Not connected");

    await unmount();
  });

  it("renders one Slack row when Slack is available", async () => {
    userIntegrationsResponse = {
      availableIntegrations: ["github", "slack", "linear", "openai"],
      integrationTools: [],
      integrationScopes: { slack: "user", linear: "user" },
      currentHealth: {},
    };

    const { container, unmount } = await renderWithSearch("");

    await waitForText(container, "Slack");
    const slackHeadings = Array.from(container.querySelectorAll("h3")).filter(
      (heading) => heading.textContent === "Slack",
    );
    expect(slackHeadings).toHaveLength(1);

    await unmount();
  });

  it("renders Slack reconnect state for legacy OpenID-only links", async () => {
    layoutMocks.user = {
      ...layoutMocks.defaultUser,
      slackConnected: false,
      slackNeedsReconnect: true,
    };

    const { container, unmount } = await renderWithSearch("");

    await waitForText(container, "Slack");
    expect(container.textContent).toContain("Reconnect required");
    expect(container.textContent).toContain("Search and thread reading need a refreshed token.");

    await unmount();
  });

  it("renders magic-link Slack identity as linked and makes search optional", async () => {
    layoutMocks.user = {
      ...layoutMocks.defaultUser,
      slackConnected: false,
      slackLinked: true,
      slackNeedsReconnect: false,
    };

    const { container, unmount } = await renderWithSearch("");

    await waitForText(container, "Linked - @Cycloid works");
    expect(container.textContent).toContain("Enabling Slack search may require a workspace owner.");
    expect(
      Array.from(container.querySelectorAll('a[href="/auth/slack"]')).find(
        (link) => link.textContent?.trim() === "Connect",
      ),
    ).toBeUndefined();
    expect(container.textContent).toContain("Enable Slack search (optional)");

    await unmount();
  });

  it("falls back to the existing Slack copy when linked state is absent", async () => {
    const { container, unmount } = await renderWithSearch("");

    await waitForText(container, "Not connected");
    expect(container.textContent).not.toContain("Linked - @Cycloid works");

    await unmount();
  });

  it("does not force reconnect from stale disconnected lifecycle health when Slack is connected", async () => {
    layoutMocks.user = {
      ...layoutMocks.defaultUser,
      slackConnected: true,
      slackNeedsReconnect: false,
    };
    userIntegrationsResponse = {
      availableIntegrations: ["github", "slack", "linear", "openai"],
      integrationTools: [],
      integrationScopes: { slack: "user", linear: "user" },
      currentHealth: {
        slack: {
          state: "disconnected",
          source: "lifecycle",
          status: "failed",
          checkedAt: 1_700_000_000_000,
          reasonCode: "token_revoked",
          diagnostic: "credential_resolved",
          message: null,
        },
      },
    };

    const { container, unmount } = await renderWithSearch("");

    await waitForText(container, "Slack");
    expect(container.textContent).toContain("Connected");
    expect(container.textContent).not.toContain("Reconnect required");
    expect(container.textContent).not.toContain("Needs attention");

    await unmount();
  });

  it("does not show reconnect for a never-connected integration with disconnected lifecycle health", async () => {
    userIntegrationsResponse = {
      availableIntegrations: ["github", "slack", "linear", "openai"],
      integrationTools: [],
      integrationScopes: { slack: "user", linear: "user" },
      currentHealth: {
        slack: {
          state: "disconnected",
          source: "lifecycle",
          status: "failed",
          checkedAt: 1_700_000_000_000,
          reasonCode: "token_missing",
          diagnostic: "credential_resolved",
          message: null,
        },
      },
    };

    const { container, unmount } = await renderWithSearch("");

    await waitForText(container, "Slack");
    expect(container.textContent).toContain("Not connected");
    expect(container.textContent).not.toContain("Reconnect required");
    expect(container.textContent).not.toContain("Needs attention");

    await unmount();
  });

  it("turns disconnected lifecycle health into a reconnect CTA for connected Linear accounts", async () => {
    layoutMocks.user = { ...layoutMocks.defaultUser, linearConnected: true };
    userIntegrationsResponse = {
      availableIntegrations: ["github", "linear", "openai"],
      integrationTools: [],
      integrationScopes: { linear: "user" },
      currentHealth: {
        linear: {
          state: "disconnected",
          source: "lifecycle",
          status: "failed",
          checkedAt: 1_700_000_000_000,
          reasonCode: "token_refresh_failed",
          diagnostic: "credential_resolved",
          message: "Linear credentials could not be refreshed. Reconnect Linear and try again.",
        },
      },
    };

    const { container, unmount } = await renderWithSearch("");

    await waitForText(container, "Linear");
    expect(container.textContent).toContain("Reconnect required");
    expect(container.textContent).toContain("Needs attention");
    expect(container.textContent).toContain(
      "Linear credentials could not be refreshed. Reconnect Linear and try again.",
    );
    expect(
      Array.from(container.querySelectorAll('a[href="/auth/linear"]')).some(
        (link) => link.textContent?.trim() === "Reconnect",
      ),
    ).toBe(true);

    await unmount();
  });

  it("surfaces business health-check failures for Jira without forcing a personal reconnect", async () => {
    layoutMocks.user = { ...layoutMocks.defaultUser, jiraConnected: true, jiraSiteName: "trycycloid" };
    userIntegrationsResponse = {
      availableIntegrations: ["github", "jira", "linear", "openai"],
      integrationTools: [],
      integrationScopes: { jira: "business", linear: "user" },
      currentHealth: {
        jira: {
          state: "disconnected",
          source: "health_check",
          status: "failed",
          checkedAt: 1_700_000_000_000,
          reasonCode: null,
          diagnostic: "jira_installer_token_missing",
          message:
            "The Jira installer's OAuth token is missing or can no longer be refreshed; reconnect Jira in workspace settings.",
        },
      },
    };

    const { container, unmount } = await renderWithSearch("");

    await waitForText(container, "Jira");
    expect(container.textContent).toContain("Connected");
    expect(container.textContent).toContain("Needs attention");
    expect(container.textContent).toContain(
      "The Jira installer's OAuth token is missing or can no longer be refreshed; reconnect Jira in workspace settings.",
    );
    expect(container.textContent).not.toContain("Reconnect required");
    expect(
      Array.from(container.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Disconnect"),
    ).toBe(true);

    await unmount();
  });

  it("does not disconnect a connected account until the confirm dialog is confirmed", async () => {
    layoutMocks.user = { ...layoutMocks.defaultUser, linearConnected: true };

    const { container, unmount } = await renderWithSearch("");
    await waitForText(container, "Linear");

    const dialogButton = (label: string) => {
      const dialog = container.querySelector('[role="alertdialog"]');
      return (
        ([...(dialog?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.trim() === label) as
          HTMLButtonElement | undefined) ?? null
      );
    };
    const disconnectButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Disconnect" && !button.closest('[role="alertdialog"]'),
    ) as HTMLButtonElement | undefined;
    expect(disconnectButton).toBeTruthy();

    // Cancelling the dialog must not disconnect.
    await act(async () => {
      disconnectButton!.click();
      await flushAsyncWork();
    });
    expect(layoutMocks.onLinearChange).not.toHaveBeenCalled();
    await act(async () => {
      dialogButton("Cancel")!.click();
      await flushAsyncWork();
    });
    expect(layoutMocks.onLinearChange).not.toHaveBeenCalled();

    // Confirming fires the disconnect.
    await act(async () => {
      disconnectButton!.click();
      await flushAsyncWork();
    });
    await act(async () => {
      dialogButton("Disconnect")!.click();
      await flushAsyncWork();
    });
    // The disconnect path lazily imports the auth API module; poll until the
    // resulting state change lands (the import can be slow under parallel load).
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && layoutMocks.onLinearChange.mock.calls.length === 0) {
      await act(async () => {
        await flushAsyncWork();
      });
    }
    expect(layoutMocks.onLinearChange).toHaveBeenCalledWith(false);

    await unmount();
  });

  it("requests Slack disconnect for a linked and connected account", async () => {
    layoutMocks.user = {
      ...layoutMocks.defaultUser,
      slackConnected: true,
      slackLinked: true,
    };

    const { container, unmount } = await renderWithSearch("");
    await waitForText(container, "Connected");

    const disconnectButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Disconnect",
    ) as HTMLButtonElement | undefined;
    expect(disconnectButton).toBeTruthy();

    await act(async () => {
      disconnectButton!.click();
      await flushAsyncWork();
    });
    const dialog = container.querySelector('[role="alertdialog"]');
    const confirmButton = [...(dialog?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.trim() === "Disconnect",
    ) as HTMLButtonElement | undefined;
    expect(confirmButton).toBeTruthy();

    await act(async () => {
      confirmButton!.click();
      await flushAsyncWork();
    });

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && layoutMocks.onSlackChange.mock.calls.length === 0) {
      await act(async () => {
        await flushAsyncWork();
      });
    }
    expect(layoutMocks.onSlackChange).toHaveBeenCalledWith(false);

    await unmount();
  });
});
