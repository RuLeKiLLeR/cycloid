import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import { register } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

if (typeof globalThis.DurableObject === "undefined") {
  globalThis.DurableObject = class {
    constructor(_state, _env) {}
  };
}

// Register a custom loader so Node.js can resolve `cloudflare:*` imports.
// The loader returns a module that re-exports the globalThis polyfills above.
register(
  `data:text/javascript,${encodeURIComponent(`
  export function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("cloudflare:")) {
      return { url: specifier, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
  export function load(url, context, nextLoad) {
    if (url.startsWith("cloudflare:")) {
      return {
        format: "module",
        source: "export const DurableObject = globalThis.DurableObject;",
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  }
`)}`,
  import.meta.url,
);

const THRESHOLDS_MS = {
  enqueueToProcessingMs: 2000,
  doReadWriteMs: 150,
  callbackRoundtripMs: 800,
};

const ITERATIONS = parsePositiveInteger(process.env.CLOUDFLARE_BENCH_ITERATIONS, 60);
const RUNS = Math.max(2, parsePositiveInteger(process.env.CLOUDFLARE_BENCH_RUNS, 2));
const REPORT_PATH = process.env.CLOUDFLARE_BENCH_REPORT_PATH || null;

class FakeStorage {
  constructor() {
    this.map = new Map();
  }

  async get(key) {
    return this.map.get(key);
  }

  async put(key, value) {
    this.map.set(key, value);
  }
}

class FakeDurableState {
  constructor() {
    this.storage = new FakeStorage();
  }
}

class FakeD1Statement {
  constructor(db, query) {
    this.db = db;
    this.query = query;
    this.boundValues = [];
  }

  bind(...values) {
    this.boundValues = values;
    return this;
  }

  async run() {
    if (this.query.includes("UPDATE session_index SET rich_status")) {
      const [richStatus, sessionId] = this.boundValues;
      const existing = this.db.sessionIndex.get(sessionId);
      if (existing) {
        existing.rich_status = richStatus;
      }
      return { success: true };
    }

    if (this.query.includes("INSERT INTO session_index")) {
      const [sessionId, ownerUserId, status, createdAt, updatedAt, closedAt, lastEventId, _title, richStatus] =
        this.boundValues;
      const existing = this.db.sessionIndex.get(sessionId);
      this.db.sessionIndex.set(sessionId, {
        session_id: sessionId,
        owner_user_id: ownerUserId,
        status,
        created_at: createdAt,
        updated_at: updatedAt,
        closed_at: closedAt,
        last_event_id: lastEventId,
        rich_status: richStatus ?? existing?.rich_status ?? null,
      });
      return { success: true };
    }

    if (this.query.includes("INSERT INTO durable_event_replay_metadata")) {
      const [sessionId, sequence, timestamp, updatedAt] = this.boundValues;
      this.db.replayMetadata.set(sessionId, {
        session_id: sessionId,
        last_event_sequence: sequence,
        last_event_timestamp: timestamp,
        updated_at: updatedAt,
      });
      return { success: true };
    }

    throw new Error(`Unhandled D1 run query: ${this.query}`);
  }

  async all() {
    if (!this.query.includes("FROM session_index")) {
      throw new Error(`Unhandled D1 all query: ${this.query}`);
    }

    return {
      results: [...this.db.sessionIndex.values()],
    };
  }

  async first() {
    if (!this.query.includes("FROM durable_event_replay_metadata")) {
      throw new Error(`Unhandled D1 first query: ${this.query}`);
    }

    const [sessionId] = this.boundValues;
    return this.db.replayMetadata.get(sessionId) || null;
  }
}

class FakeD1 {
  constructor() {
    this.sessionIndex = new Map();
    this.replayMetadata = new Map();
  }

  prepare(query) {
    return new FakeD1Statement(this, query);
  }
}

function createDurableNamespace(durableClass, env) {
  const instances = new Map();

  return {
    idFromName(name) {
      return name;
    },
    get(id) {
      return {
        fetch: async (request, init) => {
          let instance = instances.get(id);
          if (!instance) {
            instance = new durableClass(new FakeDurableState(), env);
            instances.set(id, instance);
          }

          const actualRequest = request instanceof Request ? request : new Request(request, init);
          return instance.fetch(actualRequest);
        },
      };
    },
  };
}

function createWorkerEnv(workerModule) {
  const db = new FakeD1();

  const env = {
    DB: db,
    WORKER_ENV: "benchmark",
    AUTH_SMOKE_TOKEN: "smoke-token",
    ARCANIST_ADMIN_TOKEN: "api-secret",
  };

  env.SESSION = createDurableNamespace(workerModule.SessionDO, env);

  return { env };
}

async function workerFetch(workerModule, env, pathName, init) {
  return workerModule.default.fetch(new Request(`https://worker.test${pathName}`, init), env);
}

function parsePositiveInteger(rawValue, fallback) {
  const parsed = Number.parseInt(String(rawValue || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) {
    return 0;
  }

  const rawIndex = Math.ceil((percentileValue / 100) * sortedValues.length) - 1;
  const index = Math.min(sortedValues.length - 1, Math.max(rawIndex, 0));
  return sortedValues[index];
}

function roundMs(value) {
  return Number(value.toFixed(3));
}

function computeMetricStats(samples) {
  if (samples.length === 0) {
    return {
      sampleCount: 0,
      minMs: 0,
      maxMs: 0,
      avgMs: 0,
      p50Ms: 0,
      p95Ms: 0,
    };
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);

  return {
    sampleCount: sorted.length,
    minMs: roundMs(sorted[0]),
    maxMs: roundMs(sorted[sorted.length - 1]),
    avgMs: roundMs(total / sorted.length),
    p50Ms: roundMs(percentile(sorted, 50)),
    p95Ms: roundMs(percentile(sorted, 95)),
  };
}

async function expectJson(response, expectedStatus, context) {
  if (response.status !== expectedStatus) {
    const body = await response.text();
    throw new Error(`${context} failed with status ${response.status}: ${body}`);
  }

  const json = await response.json();
  if (!json || json.ok !== true) {
    throw new Error(`${context} returned non-ok response payload`);
  }

  return json;
}

async function createSession(workerModule, env, sessionId, ownerUserId) {
  const response = await workerFetch(workerModule, env, "/api/sessions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer api-secret",
    },
    body: JSON.stringify({
      sessionId,
      ownerUserId,
    }),
  });

  await expectJson(response, 201, `create session ${sessionId}`);
}

async function measureWorkerPromptFlow(workerModule, env, sessionId) {
  const enqueueSamples = [];
  const callbackSamples = [];

  for (let index = 0; index < ITERATIONS; index += 1) {
    const enqueueStart = performance.now();
    const enqueueResponse = await workerFetch(workerModule, env, `/api/sessions/${sessionId}/prompts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer api-secret",
      },
      body: JSON.stringify({
        prompt: `benchmark enqueue ${index + 1}`,
      }),
    });
    const enqueueElapsedMs = performance.now() - enqueueStart;

    const enqueueBody = await expectJson(enqueueResponse, 202, `enqueue prompt ${index + 1}`);
    const promptId = enqueueBody?.prompt?.promptId;
    if (!promptId) {
      throw new Error(`enqueue prompt ${index + 1} missing promptId`);
    }
    enqueueSamples.push(enqueueElapsedMs);

    const callbackStart = performance.now();
    const callbackResponse = await workerFetch(
      workerModule,
      env,
      `/internal/sandbox/sessions/${encodeURIComponent(sessionId)}/prompts/${encodeURIComponent(promptId)}/callback`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer api-secret",
        },
        body: JSON.stringify({
          success: true,
          result: {
            benchmark: true,
            promptId,
          },
        }),
      },
    );
    const callbackElapsedMs = performance.now() - callbackStart;

    await expectJson(callbackResponse, 200, `callback prompt ${promptId}`);
    callbackSamples.push(callbackElapsedMs);
  }

  return {
    enqueueSamples,
    callbackSamples,
  };
}

async function measureDurableObjectReadWrite(env, sessionId) {
  const samples = [];
  const sessionStub = env.SESSION.get(env.SESSION.idFromName(sessionId));

  for (let index = 0; index < ITERATIONS; index += 1) {
    const startedAt = performance.now();
    const enqueueResponse = await sessionStub.fetch(
      new Request("https://internal/session/prompts/enqueue", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          prompt: `benchmark do op ${index + 1}`,
          actorUserId: "benchmark-do-user",
        }),
      }),
    );
    const enqueueBody = await expectJson(enqueueResponse, 200, `do enqueue ${index + 1}`);
    const promptId = enqueueBody?.prompt?.promptId;
    if (!promptId) {
      throw new Error(`do enqueue ${index + 1} missing promptId`);
    }

    const listResponse = await sessionStub.fetch("https://internal/session/prompts", {
      method: "GET",
    });
    await expectJson(listResponse, 200, `do list ${index + 1}`);

    const callbackResponse = await sessionStub.fetch(
      new Request("https://internal/session/prompts/callback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          promptId,
          success: true,
          result: {
            benchmark: true,
            promptId,
          },
        }),
      }),
    );
    await expectJson(callbackResponse, 200, `do callback ${index + 1}`);

    samples.push(performance.now() - startedAt);
  }

  return samples;
}

async function runSingleBenchmark(workerModule, runNumber) {
  const { env } = createWorkerEnv(workerModule);
  const sessionId = `benchmark-${Date.now()}-${runNumber}`;
  const ownerUserId = `benchmark-user-${runNumber}`;

  await createSession(workerModule, env, sessionId, ownerUserId);

  const runStart = performance.now();
  const workerPromptFlow = await measureWorkerPromptFlow(workerModule, env, sessionId);
  const doReadWriteSamples = await measureDurableObjectReadWrite(env, sessionId);
  const runDurationMs = performance.now() - runStart;

  return {
    run: runNumber,
    sessionId,
    iterations: ITERATIONS,
    runDurationMs: roundMs(runDurationMs),
    metrics: {
      enqueueToProcessingMs: computeMetricStats(workerPromptFlow.enqueueSamples),
      doReadWriteMs: computeMetricStats(doReadWriteSamples),
      callbackRoundtripMs: computeMetricStats(workerPromptFlow.callbackSamples),
    },
  };
}

function hasConsecutiveFailures(failuresByRun) {
  for (let index = 1; index < failuresByRun.length; index += 1) {
    if (failuresByRun[index - 1] && failuresByRun[index]) {
      return true;
    }
  }

  return false;
}

function evaluateGate(runResults) {
  const metricEvaluations = {};
  let gateFailed = false;

  for (const [metricName, thresholdMs] of Object.entries(THRESHOLDS_MS)) {
    const p95ByRun = runResults.map((runResult) => runResult.metrics[metricName].p95Ms);
    const failuresByRun = p95ByRun.map((value) => value > thresholdMs);
    const consecutiveFailure = hasConsecutiveFailures(failuresByRun);

    if (consecutiveFailure) {
      gateFailed = true;
    }

    metricEvaluations[metricName] = {
      thresholdMs,
      p95ByRun,
      failuresByRun,
      consecutiveFailure,
    };
  }

  return {
    passed: !gateFailed,
    metrics: metricEvaluations,
  };
}

function printSummary(runResults, gateEvaluation) {
  console.log(`Cloudflare benchmark gate: ${runResults.length} runs x ${ITERATIONS} iterations`);
  for (const runResult of runResults) {
    console.log(`run ${runResult.run}: duration=${runResult.runDurationMs}ms session=${runResult.sessionId}`);
    console.log(
      `  enqueue->processing p95=${runResult.metrics.enqueueToProcessingMs.p95Ms}ms threshold<=${THRESHOLDS_MS.enqueueToProcessingMs}`,
    );
    console.log(
      `  do read/write p95=${runResult.metrics.doReadWriteMs.p95Ms}ms threshold<=${THRESHOLDS_MS.doReadWriteMs}`,
    );
    console.log(
      `  callback roundtrip p95=${runResult.metrics.callbackRoundtripMs.p95Ms}ms threshold<=${THRESHOLDS_MS.callbackRoundtripMs}`,
    );
  }

  for (const [metricName, metricEvaluation] of Object.entries(gateEvaluation.metrics)) {
    const verdict = metricEvaluation.consecutiveFailure ? "FAIL_CONSECUTIVE" : "PASS";
    console.log(
      `gate ${metricName}: p95_by_run=${metricEvaluation.p95ByRun.join(",")} threshold<=${metricEvaluation.thresholdMs} ${verdict}`,
    );
  }

  console.log(`benchmark gate result: ${gateEvaluation.passed ? "PASSED" : "FAILED"}`);
}

async function maybeWriteReport(output) {
  if (!REPORT_PATH) {
    return;
  }

  const reportAbsolutePath = path.resolve(REPORT_PATH);
  await fs.mkdir(path.dirname(reportAbsolutePath), { recursive: true });
  await fs.writeFile(reportAbsolutePath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`wrote benchmark report to ${reportAbsolutePath}`);
}

async function main() {
  const scriptPath = fileURLToPath(import.meta.url);
  const scriptDir = path.dirname(scriptPath);
  // Build the TypeScript worker into a temp directory so Node.js can import it
  const workerDir = path.join(scriptDir, "../apps/control-plane-worker");
  const buildDir = path.join(os.tmpdir(), "wrangler-benchmark-" + process.pid);
  execSync(`npx wrangler deploy --dry-run --outdir ${buildDir}`, { cwd: workerDir, stdio: "pipe" });
  const workerModuleUrl = pathToFileURL(path.join(buildDir, "index.js")).href;
  const workerModule = await import(workerModuleUrl);

  const runResults = [];
  for (let runNumber = 1; runNumber <= RUNS; runNumber += 1) {
    runResults.push(await runSingleBenchmark(workerModule, runNumber));
  }

  const gateEvaluation = evaluateGate(runResults);
  const output = {
    generatedAt: new Date().toISOString(),
    iterations: ITERATIONS,
    runs: RUNS,
    thresholdsMs: THRESHOLDS_MS,
    runResults,
    gateEvaluation,
  };

  printSummary(runResults, gateEvaluation);
  await maybeWriteReport(output);

  if (!gateEvaluation.passed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("benchmark gate execution failed");
  console.error(error);
  process.exitCode = 1;
});
