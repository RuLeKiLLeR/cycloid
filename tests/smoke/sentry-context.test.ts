import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSetTag, mockSetUser } = vi.hoisted(() => ({
  mockSetTag: vi.fn(),
  mockSetUser: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("@sentry/cloudflare", () => ({
  instrumentDurableObjectWithSentry: (_optionsCallback: unknown, DurableObjectClass: unknown) => DurableObjectClass,
  withSentry: (_optionsCallback: unknown, handler: unknown) => handler,
  setTag: mockSetTag,
  setUser: mockSetUser,
  captureException: vi.fn(),
}));

type WorkerModule = {
  default: {
    fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
  };
};

type StoredAuthUser = {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  business_id: string;
  shared_sessions: number | null;
  expires_at: number;
};

class TestD1Statement {
  private boundValues: unknown[] = [];

  constructor(
    private readonly db: TestD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }

  async run(): Promise<{ success: true }> {
    if (this.query.includes("DELETE FROM auth_sessions")) {
      const [token] = this.boundValues as [string];
      this.db.authTokens.delete(token);
    }
    return { success: true };
  }

  async all<T extends Record<string, unknown>>(): Promise<{ results: T[] }> {
    if (this.query.includes("FROM session_index")) {
      return { results: [] as T[] };
    }

    if (this.query.includes("FROM user_integrations")) {
      return { results: [] as T[] };
    }

    if (this.query.includes("FROM users WHERE business_id")) {
      return { results: [] as T[] };
    }

    throw new Error(`Unhandled all query: ${this.query}`);
  }

  async first<T extends Record<string, unknown>>(): Promise<T | null> {
    if (this.query.includes("FROM auth_sessions")) {
      const [token] = this.boundValues as [string];
      const row = this.db.authTokens.get(token);
      return (row ?? null) as T | null;
    }

    throw new Error(`Unhandled first query: ${this.query}`);
  }
}

class TestD1 {
  readonly authTokens = new Map<string, StoredAuthUser>();

  prepare(query: string): TestD1Statement {
    return new TestD1Statement(this, query);
  }
}

function createWorkerEnv(): { env: Record<string, unknown>; db: TestD1 } {
  const db = new TestD1();
  return {
    env: {
      DB: db,
      WORKER_ENV: "test",
      ARCANIST_ADMIN_TOKEN: "admin-secret",
    },
    db,
  };
}

function seedAuthUser(db: TestD1, token: string, userId: number, login: string, email: string | null = null): void {
  db.authTokens.set(token, {
    id: userId,
    login,
    name: null,
    email,
    business_id: "biz-1",
    shared_sessions: 0,
    expires_at: Date.now() + 60_000,
  });
}

function sessionTokenHeaders(token: string): Record<string, string> {
  return { cookie: `session_token=${token}` };
}

async function workerFetch(
  workerModule: WorkerModule,
  env: Record<string, unknown>,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return workerModule.default.fetch(new Request(`https://worker.test${path}`, init), env);
}

describe("smoke: sentry context enrichment", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    const workerModulePath: string = "../../apps/control-plane-worker/src/index.js";
    workerModule = (await import(workerModulePath)) as WorkerModule;
  });

  beforeEach(() => {
    mockSetTag.mockClear();
    mockSetUser.mockClear();
  });

  it("tags sessionId when URL contains a session ID", async () => {
    const { env } = createWorkerEnv();

    await workerFetch(workerModule, env, "/api/sessions/sess-abc-123/missing", {
      headers: { authorization: "Bearer admin-secret" },
    });

    const sessionIdCall = mockSetTag.mock.calls.find((call: unknown[]) => call[0] === "sessionId");
    expect(sessionIdCall).toBeDefined();
    expect(sessionIdCall![1]).toBe("sess-abc-123");
  });

  it("does not tag sessionId for non-session routes", async () => {
    const { env } = createWorkerEnv();

    await workerFetch(workerModule, env, "/health");

    const sessionIdCall = mockSetTag.mock.calls.find((call: unknown[]) => call[0] === "sessionId");
    expect(sessionIdCall).toBeUndefined();
  });

  it("sets user email and username from session-token auth", async () => {
    const { env, db } = createWorkerEnv();
    seedAuthUser(db, "test-token", 42, "jparappally", "josiah@example.com");

    await workerFetch(workerModule, env, "/api/sessions", {
      headers: sessionTokenHeaders("test-token"),
    });

    expect(mockSetUser).toHaveBeenCalledWith({
      id: "42",
      email: "josiah@example.com",
      username: "jparappally",
    });
  });

  it("sets user with undefined email when email is null", async () => {
    const { env, db } = createWorkerEnv();
    seedAuthUser(db, "no-email-token", 99, "noemaildude");

    await workerFetch(workerModule, env, "/api/sessions", {
      headers: sessionTokenHeaders("no-email-token"),
    });

    expect(mockSetUser).toHaveBeenCalledWith({
      id: "99",
      email: undefined,
      username: "noemaildude",
    });
  });

  it("sets user without email/username for admin token auth", async () => {
    const { env } = createWorkerEnv();

    await workerFetch(workerModule, env, "/api/sessions", {
      headers: { authorization: "Bearer admin-secret" },
    });

    expect(mockSetUser).toHaveBeenCalledWith({
      id: "admin-token",
      email: undefined,
      username: undefined,
    });
  });
});
