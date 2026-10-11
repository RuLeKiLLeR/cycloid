import {
  buildTracingReadiness,
  observabilityReadinessFromTracing,
  observabilityReadinessLogFields,
} from "../../../shared/observability/trace.js";
import { AgentBridge } from "./bridge.js";
import { createBridgeLogger, LOG_ORDINALS, type LogLevel } from "./logger.js";
import { initBraintrust } from "./services/braintrust.js";
import { parseEnvCorrelation, runWithCorrelation } from "./services/correlation.js";
import { flushDdLogs, initDdLogs, shutdownDdLogs } from "./services/dd-logs.js";
import { emitStartupEgressLog } from "./services/egress-log.js";
import { configureFetchDispatcher } from "./services/fetch-dispatcher.js";
import { installFetchLogger } from "./services/fetch-logger.js";
import { runMemoryHookFromStdin } from "./services/memory-hook-runner.js";
import { OPENCODE_FIRST_PARTY_MCP_SERVER_FLAG } from "./services/opencode-first-party-dynamic-tools.js";
import { runOpencodeFirstPartyMcpServer } from "./services/opencode-first-party-mcp-server.js";
import { captureBridgeException, flushSentry, initSentry } from "./services/sentry.js";
import { isDdLogsBrokerReady } from "./services/telemetry-broker.js";
import { runWriteAgentGhAuth } from "./utils/agent-gh-auth.js";
import {
  getManagedMcpServers,
  getRestorableAgentSessionAgent,
  getRestorableAgentSessionId,
  getSessionAgentProfile,
  getSessionAgentRole,
  getSessionHarnessKind,
  getSessionRuntimeStartupProfile,
  getSessionTargetPrUrl,
  getSessionVerificationRuntimeMode,
  getUseOpenAIFlexServiceTier,
  parseSessionConfig,
} from "./utils/session-config.js";

const REQUIRED_ENV = ["SANDBOX_ID", "CONTROL_PLANE_URL", "SANDBOX_AUTH_TOKEN"] as const;

async function main() {
  if (process.argv.includes("--memory-hook")) {
    await runMemoryHookFromStdin();
    return;
  }

  // opencode spawns this same bundle as its first-party dynamic-tools MCP server.
  if (process.argv.includes(OPENCODE_FIRST_PARTY_MCP_SERVER_FLAG)) {
    await runOpencodeFirstPartyMcpServer();
    return;
  }

  // Must run before any fetch() in the bridge so LLM/MCP/provider calls honor
  // the tightened headers timeout.
  const fetchDispatcherConfig = configureFetchDispatcher();

  // Initialize Sentry first — captures errors from all subsequent init steps
  await initSentry();

  // Initialize DD Logs — before env validation so early errors ship
  initDdLogs();

  const envLevel = (process.env.LOG_LEVEL || "info") as LogLevel;
  const log = createBridgeLogger(LOG_ORDINALS[envLevel] ?? 0, { component: "bridge-init" });
  log.info({ ...fetchDispatcherConfig }, "Bridge fetch dispatcher configured");
  emitStartupEgressLog(log);

  // Wrap globalThis.fetch so slow and failed requests carry the target URL into
  // DD. Without this the bundled call sites are minified and we cannot tell
  // which host hung on UND_ERR_HEADERS_TIMEOUT.
  installFetchLogger(log);

  for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
      log.error({ key }, "Missing required environment variable");
      captureBridgeException(new Error(`Missing required env var: ${key}`), { operation: "env_validation" });
      await flushSentry();
      await flushDdLogs();
      process.exit(1);
    }
  }

  const bootCorrelation = parseEnvCorrelation();
  if (process.env.ARCANIST_CORRELATION && !bootCorrelation) {
    log.warn({}, "Invalid correlation payload in environment");
  }

  const sessionId = process.env.SESSION_ID || bootCorrelation?.sessionId;
  if (!sessionId) {
    log.error({ key: "SESSION_ID" }, "Missing required environment variable");
    captureBridgeException(new Error("Missing required session identifier"), { operation: "env_validation" });
    await flushSentry();
    await flushDdLogs();
    process.exit(1);
  }

  // Give the agent's real `gh` a repo-scoped READ-ONLY GitHub token by writing its gh
  // config. #6891 denies every GitHub token to the agent env, so without this the agent's
  // gh is unauthenticated -- this is why the daily-changelog automation (whose only data
  // source is `gh pr list`) began aborting. Fire-and-forget + fail-soft: kicked off here
  // so it completes during WS connect / before the first prompt turn, without adding boot
  // latency or ever throwing. The boot helper retries the expected 403 while the sandbox
  // is not active yet. This bundle starts only after start-bridge.sh's workspace-setup
  // gate, so the token never lands on disk while an untrusted repo `.cycloid/setup.sh`
  // can read the workspace.
  void runWriteAgentGhAuth({
    signal: AbortSignal.timeout(60_000),
    log: (fields, msg) => log.info(fields, msg),
  });

  // Report Datadog log readiness. Bridge debugging runs through Datadog Logs and
  // Braintrust; there is no OTLP trace exporter to initialize.
  const tracingReadiness = buildTracingReadiness({ ddApiKey: isDdLogsBrokerReady() });
  const tracingLogPayload = observabilityReadinessLogFields(observabilityReadinessFromTracing(tracingReadiness));
  log.info(tracingLogPayload, "Bridge observability readiness");
  await initBraintrust();

  const sessionConfig = parseSessionConfig();
  const bridge = new AgentBridge({
    sandboxId: process.env.SANDBOX_ID!,
    sessionId,
    controlPlaneUrl: process.env.CONTROL_PLANE_URL!,
    publicAppUrl: process.env.FRONTEND_URL,
    authToken: process.env.SANDBOX_AUTH_TOKEN!,
    bootCorrelation,
    repoPath: process.env.REPO_PATH,
    baseBranch: process.env.BRANCH,
    agentSessionId: getRestorableAgentSessionId(sessionConfig),
    agentSessionAgent: getRestorableAgentSessionAgent(sessionConfig),
    agentRole: getSessionAgentRole(sessionConfig),
    agentProfile: getSessionAgentProfile(sessionConfig),
    harnessKind: getSessionHarnessKind(sessionConfig),
    runtimeStartupProfile: getSessionRuntimeStartupProfile(sessionConfig),
    verificationRuntimeMode: getSessionVerificationRuntimeMode(sessionConfig),
    targetPrUrl: getSessionTargetPrUrl(sessionConfig),
    adoptedExternalPr: sessionConfig.adoptedExternalPr === true,
    useOpenAIFlexServiceTier: getUseOpenAIFlexServiceTier(sessionConfig),
    managedMcpServers: getManagedMcpServers(sessionConfig),
  });

  // Safety net: kill the codex child process on ANY exit path.
  // This runs synchronously and catches crashes, double-Ctrl+C, process.exit(), etc.
  process.on("exit", () => bridge.killServer());

  let shuttingDown = false;
  const handleSignal = () => {
    if (shuttingDown) {
      // Second signal = force exit — flush logs, then die.
      // S3 upload is handled by the parent entrypoint process after bridge exits.
      void Promise.all([
        flushSentry().catch(() => {}),
        shutdownDdLogs().catch((err) => console.error("[dd-logs] flush on second signal failed:", err)),
      ]).finally(() => process.exit(1));
      return;
    }
    shuttingDown = true;
    // gracefulShutdown: aborts prompt, waits 5s, flushes telemetry, then kills.
    // S3 upload is handled by the parent entrypoint process after bridge exits.
    bridge
      .gracefulShutdown()
      .catch((err) => console.error("[bridge] graceful shutdown failed:", err))
      .finally(() => {
        void (async () => {
          await flushSentry().catch(() => {});
          process.exit(0);
        })();
      });
  };

  process.on("SIGTERM", handleSignal);
  process.on("SIGINT", handleSignal);

  void runWithCorrelation(bootCorrelation, () => bridge.run()).catch(async (err) => {
    log.error({ error: String(err) }, "Bridge fatal error");
    // captureBridgeException is intentionally omitted: log.error above already
    // auto-captures to Sentry via the logger (logger.ts:56), so calling it here
    // would produce a duplicate capture.
    await Promise.all([
      flushSentry().catch(() => {}),
      shutdownDdLogs().catch((e) => console.error("[dd-logs] flush on fatal error failed:", e)),
    ]);
    process.exit(1);
  });
}

void main();
