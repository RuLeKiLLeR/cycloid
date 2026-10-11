declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    SESSION: DurableObjectNamespace<import("../../apps/control-plane-worker/src/session/durable-object").SessionDO>;
    TEST_SESSION_STORAGE: DurableObjectNamespace<import("./worker").TestSessionStorageDO>;
    MIGRATIONS: Fetcher;
    DD_API_KEY?: string;
    WORKER_ENV?: string;
  }
}
