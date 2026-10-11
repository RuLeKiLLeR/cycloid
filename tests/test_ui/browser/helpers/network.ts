import type { Page, Request, Route } from "@playwright/test";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

export type SendCall = {
  sessionId: string;
  prompt: string;
  body: Record<string, unknown>;
};

export type CreateCall = {
  body: Record<string, unknown>;
};

type StubSession = {
  sessionId: string;
  createdAt: number;
  title: string | null;
  status: "idle" | "sandbox_creating";
  baseBranch: string;
  prompts: Array<{ promptId: string; prompt: string }>;
};

type PendingCreateSession = {
  order: number;
  route: Route;
  release: Deferred<string>;
};

const BOOTSTRAP = {
  authenticated: true,
  user: {
    id: 1,
    login: "test-user",
    name: "Test User",
    email: "test@example.com",
    avatarUrl: "https://example.com/avatar.png",
    businessId: "biz-1",
    businessRole: "admin",
    sharedSessions: false,
    linearConnected: false,
    slackConnected: false,
    slackNeedsReconnect: false,
    canViewEvalsUi: true,
  },
  capabilities: {
    canAccessEvals: true,
    canAccessIntegrationDebug: true,
    canManageBusinessIntegrations: true,
    canManageCliTokens: true,
    canUseBusinessSessions: false,
    canAdminPendingSignups: false,
  },
  repos: [
    {
      fullName: "org/repo",
      url: "https://github.com/org/repo",
      private: false,
      defaultBranch: "main",
      ownerType: "Organization",
    },
  ],
  models: [
    {
      id: "openai",
      name: "OpenAI",
      models: [
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          label: "GPT 4.7",
          reasoning: { efforts: ["low", "medium", "high", "xhigh", "max"], default: "high" },
        },
      ],
    },
  ],
  ssoOrgs: [],
  settings: {
    theme: "dark",
    prReviewAutoResponseEnabled: true,
    defaultPrDraft: false,
    autoVerifyEnabled: true,
    automaticReviewsEnabled: false,
    useCodexSubscription: false,
    defaultModel: "gpt-5.5",
    defaultRepo: "org/repo",
    apiKeys: {},
  },
  warnings: [],
} as const;

const SETTINGS = {
  theme: "dark",
  prReviewAutoResponseEnabled: true,
  defaultPrDraft: false,
  autoVerifyEnabled: true,
  automaticReviewsEnabled: false,
  useCodexSubscription: false,
  defaultModel: "gpt-5.5",
  defaultRepo: "org/repo",
} as const;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePromptTitle(prompt: string) {
  const normalized = prompt.trim().split("\n")[0]?.trim() ?? "";
  return normalized || null;
}

function json(route: Route, payload: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(payload),
  });
}

function sessionSummary(session: StubSession) {
  return {
    sessionId: session.sessionId,
    status: session.status,
    closeReason: null,
    prUrl: null,
    createdAt: session.createdAt,
    model: {
      providerID: "openai",
      modelID: "gpt-5.5",
    },
    title: session.title,
  };
}

function sessionView(session: StubSession) {
  return {
    session: {
      sessionId: session.sessionId,
      status: session.status,
      closeReason: null,
      title: session.title,
      createdAt: session.createdAt,
      repoUrl: "https://github.com/org/repo",
      baseBranch: session.baseBranch,
      startBranch: null,
      lastBranch: null,
      prUrl: null,
      prCreating: false,
      model: {
        providerID: "openai",
        modelID: "gpt-5.5",
        label: "GPT 4.7",
      },
      queueLength: 0,
    },
    prompts: {
      items: session.prompts.map((entry) => ({
        promptId: entry.promptId,
        prompt: entry.prompt,
        status: "running",
        result: null,
      })),
      nextCursor: null,
      total: session.prompts.length,
    },
    actions: {
      canSendPrompt: true,
      canStop: false,
      canResume: false,
    },
  };
}

function matchSessionPath(pathname: string, suffix: string) {
  const match = pathname.match(new RegExp(`^/api/sessions/([^/]+)${suffix}$`));
  if (!match) return null;
  return match[1];
}

function getJsonBody(request: Request) {
  const payload = request.postDataJSON();
  if (payload && typeof payload === "object") return payload as Record<string, unknown>;
  return {};
}

function getBaseBranch(body: Record<string, unknown>) {
  const context = body.context;
  if (!context || typeof context !== "object") return "main";
  const branch = (context as Record<string, unknown>).baseBranch;
  return typeof branch === "string" && branch.trim() ? branch : "main";
}

export class CreateSessionGate {
  private readonly pending: PendingCreateSession[] = [];

  constructor(private readonly timeoutMs = 10_000) {}

  async hold(route: Route) {
    const pending: PendingCreateSession = {
      order: this.pending.length + 1,
      route,
      release: deferred<string>(),
    };
    this.pending.push(pending);

    return this.withTimeout(
      pending.release.promise,
      `Timed out waiting to release POST /api/sessions request #${pending.order}`,
    );
  }

  async release(order: number, sessionId: string) {
    const pending = await this.waitFor(order);
    pending.release.resolve(sessionId);
  }

  async waitFor(order: number): Promise<PendingCreateSession> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const pending = this.pending[order - 1];
      if (pending) return pending;
      await wait(10);
    }
    throw new Error(`Timed out waiting for POST /api/sessions request #${order}`);
  }

  private async withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
    const timeout = deferred<never>();
    const id = setTimeout(() => timeout.reject(new Error(message)), this.timeoutMs);
    try {
      return await Promise.race([promise, timeout.promise]);
    } finally {
      clearTimeout(id);
    }
  }
}

export type BrowserFixture = {
  createSessionGate: CreateSessionGate;
  createCalls: CreateCall[];
  sendCalls: SendCall[];
  waitForSendCount: (count: number) => Promise<void>;
};

export async function installBrowserFixture(page: Page): Promise<BrowserFixture> {
  const createSessionGate = new CreateSessionGate();
  const createCalls: CreateCall[] = [];
  const sendCalls: SendCall[] = [];
  const sessions = new Map<string, StubSession>();

  // The session page opens a real WebSocket to /api/sessions/<id>/ws for live
  // events. page.route() only intercepts HTTP, so without this the upgrade
  // escapes the fixture and hits the vite dev-server proxy, which targets the
  // API port (3000) that is not running under `npm run dev:ui`. That produced a
  // repeating `[vite] ws proxy error: ECONNREFUSED` reconnect storm whose
  // re-render churn raced the transcript assertion and timed it out on slow
  // runners. Stub the socket in-browser so it connects and stays quiet: the
  // transcript renders from the mocked GET /view, no live events are needed.
  await page.routeWebSocket(/\/api\/sessions\/[^/]+\/ws(\?|$)/, () => {
    // Intentionally do not connectToServer(): accept the client connection and
    // send nothing, so onopen fires (no reconnect storm) and no proxy is hit.
  });

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();

    if (method === "GET" && pathname === "/auth/status") {
      await json(route, { authenticated: true });
      return;
    }

    if (method === "GET" && pathname === "/auth/me") {
      await json(route, {
        authenticated: true,
        user: BOOTSTRAP.user,
      });
      return;
    }

    if (method === "GET" && pathname === "/api/bootstrap") {
      await json(route, BOOTSTRAP);
      return;
    }

    if (method === "GET" && pathname === "/api/github/install-url") {
      await json(route, { url: "https://github.com/apps/cycloid/installations/new" });
      return;
    }

    if (method === "GET" && pathname === "/api/repos") {
      await json(route, { repos: BOOTSTRAP.repos, ssoOrgs: BOOTSTRAP.ssoOrgs });
      return;
    }

    if (method === "GET" && pathname === "/api/repos/org/repo/branches") {
      await json(route, { branches: ["main", "release/2026-06"] });
      return;
    }

    if (method === "GET" && pathname === "/api/settings") {
      await json(route, SETTINGS);
      return;
    }

    if (method === "GET" && pathname === "/api/sessions/prerequisites") {
      await json(route, { canStartSession: true });
      return;
    }

    if (method === "GET" && pathname === "/api/onboarding/status") {
      await json(route, { ok: true, steps: [] });
      return;
    }

    if (method === "GET" && pathname === "/api/sessions") {
      const listedSessions = Array.from(sessions.values())
        .sort((left, right) => right.createdAt - left.createdAt)
        .map(sessionSummary);
      await json(route, { sessions: listedSessions, nextCursor: null });
      return;
    }

    if (method === "POST" && pathname === "/api/sessions") {
      const body = getJsonBody(request);
      createCalls.push({ body });
      const sessionId = await createSessionGate.hold(route);
      sessions.set(sessionId, {
        sessionId,
        createdAt: Date.now(),
        title: null,
        status: "sandbox_creating",
        baseBranch: getBaseBranch(body),
        prompts: [],
      });
      await json(route, { sessionId });
      return;
    }

    const warmSessionId = matchSessionPath(pathname, "/warm");
    if (method === "POST" && warmSessionId) {
      await json(route, { ok: true });
      return;
    }

    const sendSessionId = matchSessionPath(pathname, "/send");
    if (method === "POST" && sendSessionId) {
      const body = getJsonBody(request);
      const prompt = typeof body.prompt === "string" ? body.prompt : "";
      sendCalls.push({ sessionId: sendSessionId, prompt, body });

      const session = sessions.get(sendSessionId);
      if (session) {
        session.status = "idle";
        session.title = normalizePromptTitle(prompt);
        // Recorded so the /view stub renders the sent prompt in the
        // transcript, not just the derived header title.
        session.prompts.push({ promptId: `prompt-${sendCalls.length}`, prompt });
      }

      await json(route, {
        prompt: {
          promptId: `prompt-${sendCalls.length}`,
        },
      });
      return;
    }

    const eventsHistorySessionId = matchSessionPath(pathname, "/events/history");
    if (method === "GET" && eventsHistorySessionId) {
      await json(route, { events: [], hasMore: false, lastSequence: null });
      return;
    }

    const memoryFeedbackSessionId = matchSessionPath(pathname, "/memory-feedback");
    if (method === "GET" && memoryFeedbackSessionId) {
      await json(route, { feedback: [] });
      return;
    }

    const artifactsSessionId = matchSessionPath(pathname, "/artifacts/list");
    if (method === "GET" && artifactsSessionId) {
      await json(route, { artifacts: [] });
      return;
    }

    const wsTelemetrySessionId = matchSessionPath(pathname, "/ws-telemetry");
    if (method === "POST" && wsTelemetrySessionId) {
      await json(route, {});
      return;
    }

    const viewSessionId = matchSessionPath(pathname, "/view");
    if (method === "GET" && viewSessionId) {
      const session = sessions.get(viewSessionId);
      if (!session) {
        await json(route, { error: "Not found" }, 404);
        return;
      }
      await json(route, sessionView(session));
      return;
    }

    const detailSessionId = pathname.match(/^\/api\/sessions\/([^/]+)$/)?.[1];
    if (method === "GET" && detailSessionId) {
      const session = sessions.get(detailSessionId);
      if (!session) {
        await json(route, { error: "Not found" }, 404);
        return;
      }
      await json(route, {
        session: {
          ...sessionSummary(session),
          queueLength: 0,
          repoUrl: "https://github.com/org/repo",
          prCreating: false,
          startBranch: null,
          lastBranch: null,
          baseBranch: session.baseBranch,
        },
      });
      return;
    }

    if (pathname.startsWith("/api/") || pathname.startsWith("/auth/")) {
      throw new Error(`Unhandled browser fixture request: ${method} ${pathname}`);
    }

    await route.fallback();
  });

  return {
    createSessionGate,
    createCalls,
    sendCalls,
    async waitForSendCount(count: number) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (sendCalls.length >= count) return;
        await wait(10);
      }
      throw new Error(`Timed out waiting for ${count} send call(s); saw ${sendCalls.length}`);
    },
  };
}
