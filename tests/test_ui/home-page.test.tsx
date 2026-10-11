import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchOnboardingStatus } from "../../apps/ui/src/api/onboarding";
import { fetchSessionPrerequisites } from "../../apps/ui/src/api/sessions";
import type { LayoutContext } from "../../apps/ui/src/components/Layout";
import { ToastProvider } from "../../apps/ui/src/components/Toast";
import { HomePage } from "../../apps/ui/src/pages/HomePage";
import type { ModelSelection, Repo, User } from "../../apps/ui/src/types";
import {
  clearRememberedPersonalIntegration,
  rememberConnectedPersonalIntegrations,
} from "../../apps/ui/src/utils/integration-disconnect-warning";
import { ONBOARDING_STEP_STATUS } from "../../shared/constants/onboarding";
import type { SsoOrg } from "../../shared/types/bootstrap";

const TEST_USER: User = {
  id: 1,
  login: "jagrit",
  name: "Jagrit",
  email: "jagrit@example.com",
  avatarUrl: null,
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

const TEST_REPO: Repo = {
  fullName: "jagrit/widgets",
  url: "https://github.com/jagrit/widgets",
  private: true,
  defaultBranch: "main",
  ownerType: "User",
};

const PERSONAL_REPO: Repo = {
  fullName: "jagrit/personal-site",
  url: "https://github.com/jagrit/personal-site",
  private: false,
  defaultBranch: "main",
  ownerType: "User",
};

const ORG_REPO: Repo = {
  fullName: "acme/widgets",
  url: "https://github.com/acme/widgets",
  private: true,
  defaultBranch: "main",
  ownerType: "Organization",
};

const MALFORMED_ORG_REPO: Repo = {
  fullName: "badly-formed-name",
  url: "https://github.com/acme/badly-formed-name",
  private: true,
  defaultBranch: "main",
  ownerType: "Organization",
};

const TEST_MODEL: ModelSelection = {
  providerID: "openai",
  modelID: "gpt-5.4",
};

const TEST_MODELS = [
  {
    id: "openai",
    name: "OpenAI",
    models: [
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        label: "GPT-5.4",
        backends: ["codex"],
        reasoning: { efforts: ["none", "low", "medium", "high", "xhigh"], default: undefined },
      },
    ],
  },
];

const TEST_MODELS_WITHOUT_API_KEY = [
  {
    ...TEST_MODELS[0],
    hasApiKey: false,
  },
];

const layoutMocks = vi.hoisted(() => ({
  user: undefined as LayoutContext["user"],
  capabilities: null as LayoutContext["capabilities"],
  repos: [],
  reposLoaded: false,
  reposError: null,
  ssoOrgs: [] as SsoOrg[],
  userFreshValidated: false,
  refreshingRepos: false,
  refreshRepos: vi.fn(),
  settings: null,
  settingsLoaded: false,
  settingsError: null,
  setSettings: vi.fn(),
  selectedRepo: null,
  setSelectedRepo: vi.fn(),
  selectedRepoFreshValidated: true,
  models: [],
  selectedModel: null,
  setSelectedModel: vi.fn(),
  selectModelForNewSession: vi.fn(),
  sessions: [],
  sessionsLoaded: true,
  setSessions: vi.fn(),
  creating: false,
  setCreating: vi.fn(),
  error: null,
  setError: vi.fn(),
  handleNewSessionPrompt: vi.fn(),
  loadFilesForHomePage: vi.fn(),
  onLinearChange: vi.fn(),
  onJiraChange: vi.fn(),
  onNotionChange: vi.fn(),
  onSlackChange: vi.fn(),
  onDefaultModelChange: vi.fn(),
  refreshUser: vi.fn(),
  refreshSessions: vi.fn(),
}));

vi.mock("../../apps/ui/src/components/Layout.tsx", () => ({
  useLayoutContext: () => layoutMocks,
}));

// HomePage lazy-imports this module to resolve the install URL for the
// empty-state CTA; without a mock the network guard leaves installUrl null.
vi.mock("../../apps/ui/src/api/repos.ts", () => ({
  fetchInstallUrl: vi.fn(async () => "https://github.com/apps/cycloid/installations/new"),
  fetchRepos: vi.fn(async () => ({ repos: [], ssoOrgs: [] })),
}));

vi.mock("../../apps/ui/src/api/onboarding.ts", () => ({
  fetchOnboardingStatus: vi.fn(async () => []),
}));

// Default the credential gate to "not blocked" so the composer renders normally;
// blocked-state tests override with `mockResolvedValueOnce`.
vi.mock("../../apps/ui/src/api/sessions.ts", async () => {
  const actual = await vi.importActual<typeof import("../../apps/ui/src/api/sessions")>(
    "../../apps/ui/src/api/sessions.ts",
  );
  return { ...actual, fetchSessionPrerequisites: vi.fn(async () => ({ canStartSession: true })) };
});

vi.mock("../../apps/ui/src/components/PromptForm.tsx", async () => {
  const React = await import("react");

  return {
    PromptForm: React.forwardRef(
      (
        props: {
          disabled?: boolean;
          busyLabel?: string;
          defaultReasoningEffort?: string;
          reasoningEfforts?: string[];
          onSubmit: (payload: {
            prompt: string;
            reasoningEffort?: string;
            planMode?: "off" | "auto" | "on";
          }) => void | Promise<void>;
          submitDisabledReason?: string;
          initialValue?: string;
          leadingChips?: React.ReactNode;
          planModeAvailable?: boolean;
          planMode?: "off" | "auto" | "on";
        },
        ref: React.ForwardedRef<{ submitPrompt: (prompt: string) => Promise<void> }>,
      ) => {
        const [submitError, setSubmitError] = React.useState<string | null>(null);
        const [reasoningEffort, setReasoningEffort] = React.useState<string | undefined>(props.defaultReasoningEffort);
        const submitInFlightRef = React.useRef(false);
        const submitDisabled = !!props.disabled || !!props.busyLabel || !!props.submitDisabledReason;
        const tooltip =
          props.submitDisabledReason ??
          props.busyLabel ??
          (props.disabled ? "Send is unavailable right now." : undefined);

        React.useEffect(() => {
          setReasoningEffort(props.defaultReasoningEffort);
        }, [props.defaultReasoningEffort]);

        React.useImperativeHandle(
          ref,
          () => ({
            submitPrompt: async (prompt: string) => {
              if (submitDisabled || submitInFlightRef.current) return;
              submitInFlightRef.current = true;
              try {
                await props.onSubmit({
                  prompt,
                  ...(reasoningEffort ? { reasoningEffort } : {}),
                  ...(props.planModeAvailable ? { planMode: props.planMode } : {}),
                });
                setSubmitError(null);
              } catch (error) {
                setSubmitError(error instanceof Error ? error.message : String(error));
              } finally {
                submitInFlightRef.current = false;
              }
            },
          }),
          [props, reasoningEffort, submitDisabled],
        );

        return React.createElement(
          "form",
          {
            onSubmit: async (event: React.FormEvent) => {
              event.preventDefault();
              if (submitDisabled) return;
              try {
                await props.onSubmit({
                  prompt: "Build the thing",
                  ...(reasoningEffort ? { reasoningEffort } : {}),
                });
                setSubmitError(null);
              } catch (error) {
                setSubmitError(error instanceof Error ? error.message : String(error));
              }
            },
          },
          React.createElement("textarea", {
            "aria-label": "Prompt",
            disabled: !!props.disabled || !!props.busyLabel,
            defaultValue: "Build the thing",
          }),
          props.leadingChips ?? null,
          props.reasoningEfforts && props.reasoningEfforts.length > 0
            ? React.createElement(
                "button",
                {
                  type: "button",
                  "aria-label": "Cycle reasoning effort",
                  onClick: () => {
                    const currentIndex = props.reasoningEfforts?.indexOf(reasoningEffort ?? "") ?? -1;
                    setReasoningEffort(props.reasoningEfforts?.[(currentIndex + 1) % props.reasoningEfforts.length]);
                  },
                },
                reasoningEffort,
              )
            : null,
          props.initialValue
            ? React.createElement("div", { "data-testid": "initial-value" }, props.initialValue)
            : null,
          submitError ? React.createElement("div", null, submitError) : null,
          React.createElement(
            "span",
            null,
            React.createElement("button", { type: "submit", disabled: submitDisabled }, "Send"),
            tooltip ? React.createElement("span", { role: "tooltip" }, tooltip) : null,
          ),
        );
      },
    ),
  };
});

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
    InputEvent: windowInstance.InputEvent,
    FocusEvent: windowInstance.FocusEvent,
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
}

async function renderHome(initialEntries?: string[]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(
      createElement(MemoryRouter, { initialEntries }, createElement(ToastProvider, null, createElement(HomePage))),
    );
    await flushAsyncWork();
  });

  return {
    container,
    async unmount() {
      await act(async () => {
        root.unmount();
        await flushAsyncWork();
      });
      container.remove();
    },
  };
}

async function submitForm(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flushAsyncWork();
  });
}

async function clickButton(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushAsyncWork();
  });
}

describe("HomePage auth boundary", () => {
  beforeEach(() => {
    happyWindow = new Window();
    happyWindow.location.href = "https://app.trycycloid.com/";
    installDomGlobals(happyWindow);
    vi.clearAllMocks();
    layoutMocks.user = undefined;
    layoutMocks.capabilities = null;
    layoutMocks.repos = [];
    layoutMocks.reposLoaded = false;
    layoutMocks.reposError = null;
    layoutMocks.ssoOrgs = [];
    layoutMocks.userFreshValidated = false;
    layoutMocks.refreshingRepos = false;
    layoutMocks.selectedRepo = null;
    layoutMocks.selectedRepoFreshValidated = true;
    layoutMocks.models = [];
    layoutMocks.selectedModel = null;
    layoutMocks.settings = null;
    layoutMocks.creating = false;
    layoutMocks.sessionsLoaded = true;
  });

  afterEach(() => {
    vi.useRealTimers();
    happyWindow.close();
  });

  it("does not render the public auth shell while auth is unresolved", async () => {
    const { container, unmount } = await renderHome();

    expect(container.textContent).not.toContain("Sign in");
    expect(container.querySelector("a[href='/auth/github']")).toBeNull();

    await unmount();
  });

  it("enables the sign-in CTA when auth resolves signed out", async () => {
    layoutMocks.user = null;
    const { container, unmount } = await renderHome();
    const signInLink = container.querySelector<HTMLAnchorElement>("a[href='/auth/github']");

    expect(container.textContent).toContain("Sign in");
    // The redesigned shell brings an "Cycloid" wordmark and a "Continue with
    // GitHub" CTA; the old verbose OAuth/workspace marketing copy stays gone.
    expect(container.textContent).toContain("Continue with GitHub");
    expect(container.textContent).not.toContain("Private workspace");
    expect(container.textContent).not.toContain("OAuth");
    expect(container.textContent).not.toContain("coding-agent workspace");
    expect(container.querySelector("#home-model-select")).toBeNull();
    expect(container.querySelector("textarea[aria-label='Prompt']")).toBeNull();
    expect(signInLink?.hasAttribute("aria-disabled")).toBe(false);
    expect(signInLink?.tabIndex).toBe(0);

    await unmount();
  });

  it("keeps model selection and prompt entry available before a repo is selected", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [TEST_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.models = TEST_MODELS;
    layoutMocks.selectedRepo = null;
    layoutMocks.selectedModel = null;

    const { container, unmount } = await renderHome();
    const modelSelect = container.querySelector<HTMLButtonElement>("#home-model-select");
    const promptTextarea = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Prompt']");

    expect(modelSelect).not.toBeNull();
    expect(modelSelect?.disabled).toBe(false);
    expect(modelSelect?.textContent).toContain("Model");
    expect(promptTextarea).not.toBeNull();
    expect(promptTextarea?.disabled).toBe(false);

    await unmount();
  });

  it("renders the composer while repos are unresolved", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [];
    layoutMocks.reposLoaded = false;
    layoutMocks.models = TEST_MODELS;
    layoutMocks.selectedRepo = null;
    layoutMocks.selectedModel = TEST_MODEL;

    const { container, unmount } = await renderHome();

    expect(container.querySelector("[aria-label='Loading repositories']")).not.toBeNull();
    expect(container.querySelector("textarea[aria-label='Prompt']")).not.toBeNull();
    expect(container.querySelector("#home-repo-select")).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>("#home-repo-select")?.disabled).toBe(true);
    expect(container.querySelector("#home-repo-select")?.textContent).toContain("Repository");
    expect(container.textContent).not.toContain("Connect a repository");
    expect(container.textContent).not.toContain("Authorize SSO");
    expect(container.textContent).not.toContain("Continue with GitHub");

    await unmount();
  });

  it("keeps the empty SSO state hidden while repos are still loading", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [];
    layoutMocks.reposLoaded = false;
    layoutMocks.ssoOrgs = [{ orgId: 1, login: "mialabs", authorizeUrl: "/auth/github/sso?org=mialabs" }];
    layoutMocks.models = TEST_MODELS;
    layoutMocks.selectedRepo = null;
    layoutMocks.selectedModel = TEST_MODEL;

    const { container, unmount } = await renderHome();

    expect(container.querySelector("textarea[aria-label='Prompt']")).not.toBeNull();
    expect(container.textContent).not.toContain("Authorize SSO");

    await unmount();
  });

  it("renders the session controls without the oversized new-session hero", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [TEST_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.models = TEST_MODELS;
    layoutMocks.selectedRepo = TEST_REPO;
    layoutMocks.selectedModel = TEST_MODEL;

    const { container, unmount } = await renderHome();

    expect(container.querySelector("#home-repo-select")).not.toBeNull();
    expect(container.querySelector("#home-model-select")).not.toBeNull();
    expect(container.querySelector("textarea[aria-label='Prompt']")).not.toBeNull();
    // Entrance choreography: heading (1) → notices (2) → composer (3).
    expect(container.querySelector(".editorial-rise-3 textarea[aria-label='Prompt']")).not.toBeNull();
    expect(container.textContent).not.toContain("— new session");
    expect(container.textContent).not.toContain("What are we");
    expect(container.textContent).not.toContain("building today");

    await unmount();
  });

  it("does not warn for integrations the user has never connected", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [TEST_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.models = TEST_MODELS;
    layoutMocks.selectedRepo = TEST_REPO;
    layoutMocks.selectedModel = TEST_MODEL;

    const { container, unmount } = await renderHome();

    expect(container.textContent).not.toContain("previously connected");
    expect(container.querySelector("[role='alert']")).toBeNull();

    await unmount();
  });

  it("links a credential-gated session to the Model API keys page when a personal key is missing", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [TEST_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.models = TEST_MODELS;
    layoutMocks.selectedRepo = TEST_REPO;
    layoutMocks.selectedModel = TEST_MODEL;
    vi.mocked(fetchSessionPrerequisites).mockResolvedValueOnce({
      canStartSession: false,
      blocking: { provider: "openai", reasonCode: "credentials_missing" },
    });

    const { container, unmount } = await renderHome();
    await act(async () => {
      await flushAsyncWork();
    });

    expect(container.querySelector<HTMLAnchorElement>("a[href='/settings/api-keys']")).not.toBeNull();
    expect(container.textContent).toContain("Add a model API key");

    await unmount();
  });

  it("links a business-managed credential block to general settings, not Model API keys", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [TEST_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.models = TEST_MODELS;
    layoutMocks.selectedRepo = TEST_REPO;
    layoutMocks.selectedModel = TEST_MODEL;
    vi.mocked(fetchSessionPrerequisites).mockResolvedValueOnce({
      canStartSession: false,
      blocking: { provider: "openai", reasonCode: "business_managed" },
    });

    const { container, unmount } = await renderHome();
    await act(async () => {
      await flushAsyncWork();
    });

    expect(container.querySelector("a[href='/settings/api-keys']")).toBeNull();
    expect(container.querySelector<HTMLAnchorElement>("a[href='/settings']")).not.toBeNull();

    await unmount();
  });

  it("hides disconnected integration warnings until the user is fresh validated", async () => {
    rememberConnectedPersonalIntegrations({ ...TEST_USER, linearConnected: true });
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [TEST_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.models = TEST_MODELS;
    layoutMocks.selectedRepo = TEST_REPO;
    layoutMocks.selectedModel = TEST_MODEL;

    const { container, unmount } = await renderHome();

    expect(container.textContent).not.toContain("Linear disconnected");
    expect(container.querySelector("[role='alert']")).toBeNull();

    await unmount();
  });

  it("warns when a previously connected integration is now disconnected after fresh user validation", async () => {
    rememberConnectedPersonalIntegrations({ ...TEST_USER, linearConnected: true });
    layoutMocks.user = TEST_USER;
    layoutMocks.userFreshValidated = true;
    layoutMocks.repos = [TEST_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.models = TEST_MODELS;
    layoutMocks.selectedRepo = TEST_REPO;
    layoutMocks.selectedModel = TEST_MODEL;

    const { container, unmount } = await renderHome();
    const summary = container.querySelector<HTMLButtonElement>(
      "[data-testid='home-hero-notices'] button[aria-expanded='false']",
    );
    if (summary) {
      await act(async () => {
        summary.click();
        await flushAsyncWork();
      });
    }
    const alert = container.querySelector("[role='alert']");

    expect(alert?.textContent).toContain("Linear disconnected");
    expect(alert?.textContent).toContain("Reconnect");
    expect(container.querySelector<HTMLAnchorElement>("a[href='/settings/integrations']")).not.toBeNull();

    await unmount();
  });

  it("formats two disconnected integrations in the warning", async () => {
    rememberConnectedPersonalIntegrations({ ...TEST_USER, linearConnected: true, slackConnected: true });
    layoutMocks.user = TEST_USER;
    layoutMocks.userFreshValidated = true;
    layoutMocks.repos = [TEST_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.models = TEST_MODELS;
    layoutMocks.selectedRepo = TEST_REPO;
    layoutMocks.selectedModel = TEST_MODEL;

    const { container, unmount } = await renderHome();
    const summary = container.querySelector<HTMLButtonElement>(
      "[data-testid='home-hero-notices'] button[aria-expanded='false']",
    );
    if (summary) {
      await act(async () => {
        summary.click();
        await flushAsyncWork();
      });
    }
    const alert = container.querySelector("[role='alert']");

    expect(alert?.textContent).toContain("Linear disconnected");
    expect(alert?.textContent).toContain("Reconnect");

    await unmount();
  });

  it("formats three disconnected integrations in the warning", async () => {
    rememberConnectedPersonalIntegrations({
      ...TEST_USER,
      linearConnected: true,
      jiraConnected: true,
      notionConnected: true,
    });
    layoutMocks.user = TEST_USER;
    layoutMocks.userFreshValidated = true;
    layoutMocks.repos = [TEST_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.models = TEST_MODELS;
    layoutMocks.selectedRepo = TEST_REPO;
    layoutMocks.selectedModel = TEST_MODEL;

    const { container, unmount } = await renderHome();
    const summary = container.querySelector<HTMLButtonElement>(
      "[data-testid='home-hero-notices'] button[aria-expanded='false']",
    );
    if (summary) {
      await act(async () => {
        summary.click();
        await flushAsyncWork();
      });
    }
    const alert = container.querySelector("[role='alert']");

    expect(alert?.textContent).toContain("Linear disconnected");
    expect(alert?.textContent).toContain("Reconnect");

    await unmount();
  });

  it("does not warn after the remembered connection is intentionally cleared", async () => {
    rememberConnectedPersonalIntegrations({ ...TEST_USER, jiraConnected: true });
    clearRememberedPersonalIntegration(TEST_USER.id, "jira");
    layoutMocks.user = TEST_USER;
    layoutMocks.userFreshValidated = true;
    layoutMocks.repos = [TEST_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.models = TEST_MODELS;
    layoutMocks.selectedRepo = TEST_REPO;
    layoutMocks.selectedModel = TEST_MODEL;

    const { container, unmount } = await renderHome();

    expect(container.textContent).not.toContain("Jira was previously connected");
    expect(container.querySelector("[role='alert']")).toBeNull();

    await unmount();
  });

  it("stacks simultaneous composer notices in SSO setup disconnect order", async () => {
    rememberConnectedPersonalIntegrations({ ...TEST_USER, notionConnected: true });
    vi.mocked(fetchOnboardingStatus).mockResolvedValueOnce([
      {
        id: "openai_key",
        title: "OpenAI API key",
        owner: "user",
        required: true,
        status: ONBOARDING_STEP_STATUS.NOT_CONNECTED,
        reasonCode: "credentials_missing",
        actionType: "connect",
      },
    ]);
    layoutMocks.user = TEST_USER;
    layoutMocks.userFreshValidated = true;
    layoutMocks.repos = [TEST_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.ssoOrgs = [{ orgId: 144570272, login: "mialabs", authorizeUrl: "/auth/github/sso?org=mialabs" }];
    layoutMocks.models = TEST_MODELS;
    layoutMocks.selectedRepo = TEST_REPO;
    layoutMocks.selectedModel = TEST_MODEL;

    const { container, unmount } = await renderHome();
    await act(async () => {
      await flushAsyncWork();
    });
    const summary = container.querySelector<HTMLButtonElement>(
      "[data-testid='home-hero-notices'] button[aria-expanded]",
    );
    expect(summary).not.toBeNull();
    await act(async () => {
      summary!.click();
      await flushAsyncWork();
    });
    const panelId = summary?.getAttribute("aria-controls");
    const panel = panelId ? document.getElementById(panelId) : null;
    const text = panel?.textContent ?? "";
    const ssoIndex = text.indexOf("requires SSO authorization");
    const setupIndex = text.indexOf("1 setup step left");
    const disconnectIndex = text.indexOf("Notion disconnected");

    expect(ssoIndex).toBeGreaterThanOrEqual(0);
    expect(setupIndex).toBeGreaterThan(ssoIndex);
    expect(disconnectIndex).toBeGreaterThan(setupIndex);

    await unmount();
  });

  it("lets the user pick a model before selecting a repo", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [TEST_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.models = TEST_MODELS;
    layoutMocks.selectedRepo = null;
    layoutMocks.selectedModel = null;

    const { container, unmount } = await renderHome();
    const modelSelect = container.querySelector<HTMLButtonElement>("#home-model-select");
    expect(modelSelect).not.toBeNull();

    await act(async () => {
      modelSelect!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    const modelOption = [...container.querySelectorAll<HTMLButtonElement>("[role='option']")].find(
      (button) => button.textContent === "GPT-5.4",
    );
    expect(modelOption).toBeDefined();

    await act(async () => {
      modelOption!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    expect(layoutMocks.selectModelForNewSession).toHaveBeenCalledWith(TEST_MODEL);

    await unmount();
  });

  it("disables send with a repository tooltip until a repo is selected", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [TEST_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.models = TEST_MODELS;
    layoutMocks.selectedRepo = null;
    layoutMocks.selectedModel = TEST_MODEL;

    const { container, unmount } = await renderHome();
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Prompt']");
    const form = container.querySelector<HTMLFormElement>("form");
    const sendButton = container.querySelector<HTMLButtonElement>("button[type='submit']");
    expect(textarea).not.toBeNull();
    expect(form).not.toBeNull();
    expect(sendButton).not.toBeNull();

    await submitForm(form!);

    expect(sendButton?.disabled).toBe(true);
    expect(container.querySelector("[role='tooltip']")?.textContent).toBe("Pick a repository to send prompt");
    expect(container.querySelector("#home-repo-select")?.getAttribute("aria-describedby")).toBe(
      "home-repo-select-attention",
    );
    expect(container.querySelector("#home-repo-select-attention")?.textContent).toBe("Repository requires attention");
    expect(container.querySelector("#home-repo-select")?.className).toContain("border-warning-soft-border");
    expect(container.querySelector("#home-model-select")?.getAttribute("aria-describedby")).toBeNull();
    expect(layoutMocks.handleNewSessionPrompt).not.toHaveBeenCalled();

    await unmount();
  });

  it("disables send with a model tooltip until a model is selected", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [TEST_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.models = TEST_MODELS;
    layoutMocks.selectedRepo = TEST_REPO;
    layoutMocks.selectedModel = null;

    const { container, unmount } = await renderHome();
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Prompt']");
    const form = container.querySelector<HTMLFormElement>("form");
    const sendButton = container.querySelector<HTMLButtonElement>("button[type='submit']");
    expect(textarea).not.toBeNull();
    expect(form).not.toBeNull();
    expect(sendButton).not.toBeNull();

    await submitForm(form!);

    expect(sendButton?.disabled).toBe(true);
    expect(container.querySelector("[role='tooltip']")?.textContent).toBe("Pick a model to send prompt");
    expect(container.querySelector("#home-model-select")?.getAttribute("aria-describedby")).toBe(
      "home-model-select-attention",
    );
    expect(container.querySelector("#home-model-select-attention")?.textContent).toBe("Model requires attention");
    expect(container.querySelector("#home-model-select")?.className).toContain("border-warning-soft-border");
    expect(container.querySelector("#home-repo-select")?.getAttribute("aria-describedby")).toBeNull();
    expect(layoutMocks.handleNewSessionPrompt).not.toHaveBeenCalled();

    await unmount();
  });

  it("disables send when the selected model requires an API key", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [TEST_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.models = TEST_MODELS_WITHOUT_API_KEY;
    layoutMocks.selectedRepo = TEST_REPO;
    layoutMocks.selectedModel = TEST_MODEL;

    const { container, unmount } = await renderHome();
    const form = container.querySelector<HTMLFormElement>("form");
    const sendButton = container.querySelector<HTMLButtonElement>("button[type='submit']");
    expect(form).not.toBeNull();
    expect(sendButton).not.toBeNull();

    await submitForm(form!);

    expect(sendButton?.disabled).toBe(true);
    expect(container.querySelector("[role='tooltip']")?.textContent).toBe("API key required");
    expect(container.querySelector("#home-model-select")?.getAttribute("aria-describedby")).toBe(
      "home-model-select-attention",
    );
    expect(layoutMocks.handleNewSessionPrompt).not.toHaveBeenCalled();

    await unmount();
  });

  it("allows submit with the server default model when models fail to load", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [TEST_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.models = [];
    layoutMocks.selectedRepo = TEST_REPO;
    layoutMocks.selectedModel = null;

    const { container, unmount } = await renderHome();
    const form = container.querySelector<HTMLFormElement>("form");
    const sendButton = container.querySelector<HTMLButtonElement>("button[type='submit']");

    expect(form).not.toBeNull();
    expect(sendButton).not.toBeNull();
    expect(sendButton?.disabled).toBe(false);
    expect(container.querySelector("[role='tooltip']")).toBeNull();

    await submitForm(form!);

    expect(layoutMocks.handleNewSessionPrompt).toHaveBeenCalledWith({ prompt: "Build the thing" });

    await unmount();
  });

  it("starts a session immediately from a closed starter prompt", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [TEST_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.models = TEST_MODELS;
    layoutMocks.selectedRepo = TEST_REPO;
    layoutMocks.selectedModel = TEST_MODEL;
    layoutMocks.capabilities = {
      canAccessIntegrationDebug: false,
      canManageBusinessIntegrations: false,
      canManageCliTokens: false,
      canUseBusinessSessions: false,
      canAdminPendingSignups: false,
      canStartSupportView: false,
      canUseInternalModelProviderKeys: false,
      computerUse: false,
      canUseControlRoom: false,
      planApproval: true,
    };
    layoutMocks.settings = {
      defaultPrDraft: false,
      autoVerifyEnabled: true,
      automaticReviewsEnabled: true,
      planMode: "auto",
      planApprovalRequired: false,
      settingsProfile: "autonomous",
      useCodexSubscription: false,
      defaultModel: null,
      defaultRepo: TEST_REPO.fullName,
    };

    const { container, unmount } = await renderHome();
    const starterLabels = ["Find a small bug", "Fix a flaky test", "Fix N+1 queries"];
    const starterButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Find a small bug",
    );

    expect(starterLabels.every((label) => container.textContent?.includes(label))).toBe(true);
    expect(starterButton).not.toBeUndefined();

    await clickButton(starterButton!);

    expect(layoutMocks.handleNewSessionPrompt).toHaveBeenCalledWith({
      prompt: "Find and fix one small, high-confidence bug in this repository. Add a focused regression test.",
      reasoningEffort: "high",
      planMode: "auto",
    });
    expect(container.querySelector('[data-testid="initial-value"]')).toBeNull();

    await unmount();
  });

  it("keeps the homepage focused on starting work without a session queue", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [TEST_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.models = TEST_MODELS;
    layoutMocks.selectedRepo = TEST_REPO;
    layoutMocks.selectedModel = TEST_MODEL;

    const { container, unmount } = await renderHome();
    const canvas = container.querySelector(".control-room-canvas");

    expect(canvas?.classList.contains("h-full")).toBe(true);
    expect(container.querySelector("[aria-labelledby='home-session-queue-heading']")).toBeNull();
    expect(container.textContent).not.toContain("No active sessions");

    await unmount();
  });

  it("disables starter prompts when normal submit is blocked", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [TEST_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.models = TEST_MODELS;
    layoutMocks.selectedRepo = null;
    layoutMocks.selectedModel = TEST_MODEL;

    const { container, unmount } = await renderHome();
    const starterButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Find a small bug",
    );

    expect(starterButton).not.toBeUndefined();
    expect(starterButton?.disabled).toBe(true);

    await clickButton(starterButton!);

    expect(layoutMocks.handleNewSessionPrompt).not.toHaveBeenCalled();

    await unmount();
  });

  it("shows a starting tooltip while creating a session", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [TEST_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.models = TEST_MODELS;
    layoutMocks.selectedRepo = TEST_REPO;
    layoutMocks.selectedModel = TEST_MODEL;
    layoutMocks.creating = true;

    const { container, unmount } = await renderHome();
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Prompt']");
    const sendButton = container.querySelector<HTMLButtonElement>("button[type='submit']");
    const tooltip = container.querySelector("[role='tooltip']");

    expect(textarea).not.toBeNull();
    expect(textarea?.disabled).toBe(true);
    expect(sendButton).not.toBeNull();
    expect(sendButton?.disabled).toBe(true);
    expect(tooltip?.textContent).toBe("Starting session…");
    expect(container.textContent).not.toContain("Send is unavailable right now.");
    expect(container.textContent).toContain("Creating session…");

    await unmount();
  });

  it("blocks submit while the selected repo is waiting for fresh validation", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [TEST_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.models = [];
    layoutMocks.selectedRepo = TEST_REPO;
    layoutMocks.selectedRepoFreshValidated = false;
    layoutMocks.selectedModel = null;

    const { container, unmount } = await renderHome();
    const form = container.querySelector<HTMLFormElement>("form");
    const sendButton = container.querySelector<HTMLButtonElement>("button[type='submit']");

    expect(form).not.toBeNull();
    expect(sendButton?.disabled).toBe(true);
    expect(container.querySelector("[role='tooltip']")?.textContent).toBe(
      "Repository access is still refreshing. Try again in a moment.",
    );
    expect(container.querySelector("#home-repo-select")?.getAttribute("aria-describedby")).toBe(
      "home-repo-select-attention",
    );
    expect(container.querySelector("#home-repo-select-attention")?.textContent).toBe("Repository requires attention");
    expect(container.querySelector("#home-repo-select")?.className).toContain("border-warning-soft-border");

    await submitForm(form!);

    expect(layoutMocks.handleNewSessionPrompt).not.toHaveBeenCalled();

    await unmount();
  });

  it("submits the reasoning effort from the selected model", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [TEST_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.models = TEST_MODELS;
    layoutMocks.selectedRepo = TEST_REPO;
    layoutMocks.selectedModel = TEST_MODEL;

    const { container, unmount } = await renderHome();
    const form = container.querySelector<HTMLFormElement>("form");
    expect(form).not.toBeNull();

    await submitForm(form!);

    expect(layoutMocks.handleNewSessionPrompt).toHaveBeenCalledWith({
      prompt: "Build the thing",
      reasoningEffort: "high",
    });

    await unmount();
  });

  it("submits the cycled reasoning effort for the selected model", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [TEST_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.models = TEST_MODELS;
    layoutMocks.selectedRepo = TEST_REPO;
    layoutMocks.selectedModel = TEST_MODEL;

    const { container, unmount } = await renderHome();
    const cycleButton = container.querySelector<HTMLButtonElement>("button[aria-label='Cycle reasoning effort']");
    const form = container.querySelector<HTMLFormElement>("form");
    expect(cycleButton).not.toBeNull();
    expect(form).not.toBeNull();

    await act(async () => {
      cycleButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });
    await submitForm(form!);

    expect(layoutMocks.handleNewSessionPrompt).toHaveBeenCalledWith({
      prompt: "Build the thing",
      reasoningEffort: "medium",
    });

    await unmount();
  });

  it("keeps the branch picker out of the default composer", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [TEST_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.models = TEST_MODELS;
    layoutMocks.selectedRepo = TEST_REPO;
    layoutMocks.selectedModel = TEST_MODEL;

    const { container, unmount } = await renderHome();
    const form = container.querySelector<HTMLFormElement>("form");
    expect(form).not.toBeNull();
    expect(container.querySelector("#home-base-branch-select")).toBeNull();

    await submitForm(form!);

    expect(layoutMocks.handleNewSessionPrompt).toHaveBeenCalledWith({
      prompt: "Build the thing",
      reasoningEffort: "high",
    });

    await unmount();
  });

  it("disables send with both missing selections in the tooltip", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [TEST_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.models = TEST_MODELS;
    layoutMocks.selectedRepo = null;
    layoutMocks.selectedModel = null;

    const { container, unmount } = await renderHome();
    const sendButton = container.querySelector<HTMLButtonElement>("button[type='submit']");

    expect(sendButton).not.toBeNull();
    expect(sendButton?.disabled).toBe(true);
    expect(container.querySelector("[role='tooltip']")?.textContent).toBe("Pick a repository and model to send prompt");

    await unmount();
  });

  it("hides the organization chip when the user has only personal repos", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [TEST_REPO, PERSONAL_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.models = TEST_MODELS;
    layoutMocks.selectedRepo = TEST_REPO;
    layoutMocks.selectedModel = TEST_MODEL;

    const { container, unmount } = await renderHome();

    expect(container.querySelector("#home-org-select")).toBeNull();
    expect(container.querySelector("#home-repo-select")).not.toBeNull();

    await unmount();
  });

  it("shows personal and org repos in one repository picker", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [PERSONAL_REPO, ORG_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.models = TEST_MODELS;
    layoutMocks.selectedRepo = ORG_REPO;
    layoutMocks.selectedModel = TEST_MODEL;

    const { container, unmount } = await renderHome();
    const orgSelect = container.querySelector<HTMLSelectElement>("#home-org-select");
    const repoSelect = container.querySelector<HTMLButtonElement>("#home-repo-select");
    expect(orgSelect).toBeNull();

    await act(async () => {
      repoSelect!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    const repoOptionLabels = [...container.querySelectorAll<HTMLButtonElement>("[role='option']")].map(
      (option) => option.textContent ?? "",
    );

    expect(repoSelect?.textContent).toContain("widgets");
    expect(repoOptionLabels.some((option) => option.includes("acme/widgets"))).toBe(true);
    expect(repoOptionLabels.some((option) => option.includes("jagrit/personal-site"))).toBe(true);

    await unmount();
  });

  it("shows malformed org repos in the single repository picker", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [PERSONAL_REPO, MALFORMED_ORG_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.models = TEST_MODELS;
    layoutMocks.selectedRepo = PERSONAL_REPO;
    layoutMocks.selectedModel = TEST_MODEL;

    const { container, unmount } = await renderHome();
    const repoSelect = container.querySelector<HTMLButtonElement>("#home-repo-select");
    expect(repoSelect).not.toBeNull();

    await act(async () => {
      repoSelect!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    const repoOptionLabels = [...container.querySelectorAll<HTMLButtonElement>("[role='option']")].map(
      (option) => option.textContent ?? "",
    );
    expect(repoOptionLabels.some((option) => option.includes("jagrit/personal-site"))).toBe(true);
    expect(repoOptionLabels.some((option) => option.includes("badly-formed-name"))).toBe(true);

    await unmount();
  });

  it("surfaces the SSO authorize prompt when every repo is withheld behind SSO", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [];
    layoutMocks.reposLoaded = true;
    layoutMocks.ssoOrgs = [{ orgId: 144570272, login: "mialabs", authorizeUrl: "/auth/github/sso?org=mialabs" }];

    const { container, unmount } = await renderHome();

    expect(container.textContent).toContain("requires SSO authorization");
    const authorizeLink = container.querySelector<HTMLAnchorElement>("a[href='/auth/github/sso?org=mialabs']");
    expect(authorizeLink).not.toBeNull();
    expect(authorizeLink?.getAttribute("target")).toBeNull();
    expect(container.textContent).toContain("Refresh repositories");

    await unmount();
  });

  it("calls refreshRepos when the refresh control is clicked", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [];
    layoutMocks.reposLoaded = true;
    layoutMocks.ssoOrgs = [{ orgId: 1, login: "mialabs", authorizeUrl: "/auth/github/sso?org=mialabs" }];

    const { container, unmount } = await renderHome();
    const refreshButton = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Refresh repositories"),
    );
    expect(refreshButton).toBeDefined();

    await act(async () => {
      refreshButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    expect(layoutMocks.refreshRepos).toHaveBeenCalled();

    await unmount();
  });

  it("disables the refresh control and shows progress copy while a refresh is in flight", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [];
    layoutMocks.reposLoaded = true;
    layoutMocks.ssoOrgs = [{ orgId: 1, login: "mialabs", authorizeUrl: "/auth/github/sso?org=mialabs" }];
    layoutMocks.refreshingRepos = true;

    const { container, unmount } = await renderHome();
    const refreshButton = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Refreshing…"));

    expect(refreshButton).toBeDefined();
    expect(refreshButton?.disabled).toBe(true);
    expect(container.textContent).not.toContain("Refresh repositories");

    await act(async () => {
      refreshButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });
    expect(layoutMocks.refreshRepos).not.toHaveBeenCalled();

    await unmount();
  });

  it("hides the install CTA while orgs are withheld behind SSO", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [];
    layoutMocks.reposLoaded = true;
    layoutMocks.ssoOrgs = [{ orgId: 1, login: "mialabs", authorizeUrl: "/auth/github/sso?org=mialabs" }];

    const { container, unmount } = await renderHome();
    await act(async () => {
      await flushAsyncWork();
    });

    // The blocker is SSO authorization, not app installation.
    expect(container.textContent).not.toContain("Grant access");
    expect(container.textContent).toContain("Authorize SSO");

    await unmount();
  });

  it("renders a repository setup empty state when there are no repos and no SSO orgs", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [];
    layoutMocks.reposLoaded = true;
    layoutMocks.ssoOrgs = [];

    const { container, unmount } = await renderHome();
    await act(async () => {
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("Connect a repository");
    expect(container.textContent).toContain("Install GitHub access");
    expect(
      container.querySelector<HTMLAnchorElement>("a[href='https://github.com/apps/cycloid/installations/new']"),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("Grant access");

    await unmount();
  });

  it("prefills the composer from an onboarding task template", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [TEST_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.ssoOrgs = [];
    layoutMocks.models = TEST_MODELS;
    layoutMocks.selectedRepo = TEST_REPO;
    layoutMocks.selectedModel = TEST_MODEL;

    const { container, unmount } = await renderHome([`/?template=${encodeURIComponent("Fix a small bug")}`]);
    await act(async () => {
      await flushAsyncWork();
    });

    expect(container.querySelector('[data-testid="initial-value"]')?.textContent).toBe("Fix a small bug");

    await unmount();
  });

  it("keeps org-only users on the single repository picker", async () => {
    layoutMocks.user = TEST_USER;
    layoutMocks.repos = [ORG_REPO];
    layoutMocks.reposLoaded = true;
    layoutMocks.models = TEST_MODELS;
    layoutMocks.selectedRepo = null;
    layoutMocks.selectedModel = TEST_MODEL;

    const { container, unmount } = await renderHome();
    const orgSelect = container.querySelector<HTMLSelectElement>("#home-org-select");
    const repoSelect = container.querySelector<HTMLButtonElement>("#home-repo-select");
    expect(orgSelect).toBeNull();

    await act(async () => {
      repoSelect!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsyncWork();
    });

    const repoOptionLabels = [...container.querySelectorAll<HTMLButtonElement>("[role='option']")].map(
      (option) => option.textContent ?? "",
    );

    expect(repoSelect?.textContent).toContain("Repository");
    expect(repoOptionLabels.some((option) => option.includes("acme/widgets"))).toBe(true);

    await unmount();
  });
});
