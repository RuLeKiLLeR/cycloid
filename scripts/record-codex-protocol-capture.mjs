#!/usr/bin/env node

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const codexRuntimeConstants = readFileSync(join(repoRoot, "shared/constants/codex-runtime.ts"), "utf8");
const pinnedVersionMatch = /PINNED_CODEX_CLI_VERSION = "([^"]+)"/.exec(codexRuntimeConstants);
const PINNED_CODEX_CLI_VERSION = pinnedVersionMatch?.[1] ?? "0.129.0";

function parseArgs(argv) {
  const options = {
    version: PINNED_CODEX_CLI_VERSION,
    outDir: resolve(repoRoot, "tests/test_sandbox-bridge/fixtures/codex-protocol"),
  };

  function requireOptionValue(flag, index) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    return value;
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--version") {
      options.version = requireOptionValue(arg, index);
      index += 1;
      continue;
    }
    if (arg === "--out-dir") {
      options.outDir = resolve(requireOptionValue(arg, index));
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function createScratchDir() {
  const cwd = mkdtempSync(join(tmpdir(), "codex-protocol-capture-"));
  writeFileSync(join(cwd, "AGENTS.md"), "Follow the user request exactly and stop.\n", "utf8");
  return cwd;
}

function wait(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function captureCase({ version, cwd, prompt }) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("npx", ["-y", `@openai/codex@${version}`, "app-server"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    const lines = [];
    let threadId = null;
    let settled = false;

    function settle(value, error) {
      if (settled) return;
      settled = true;
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise(value);
    }

    function send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      while (true) {
        const newlineIndex = stdoutBuffer.indexOf("\n");
        if (newlineIndex < 0) break;
        const raw = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (!raw) continue;
        lines.push(raw);
        let message;
        try {
          message = JSON.parse(raw);
        } catch (error) {
          settle(undefined, new Error(`Malformed Codex app-server NDJSON line: ${raw}`, { cause: error }));
          child.kill("SIGTERM");
          return;
        }
        if (message.id === 2) {
          threadId = message.result.thread.id;
          setTimeout(() => {
            send({
              id: 3,
              method: "turn/start",
              params: {
                threadId,
                cwd,
                approvalPolicy: "never",
                input: [{ type: "text", text: prompt, text_elements: [] }],
              },
            });
          }, 200);
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk;
    });
    child.on("error", (error) => settle(undefined, error));
    child.on("exit", (code, signal) => {
      if (code === 0) {
        settle(lines);
        return;
      }
      const detail = ["Codex app-server exited before capture completed"];
      if (typeof code === "number") detail.push(`exit=${code}`);
      if (signal) detail.push(`signal=${signal}`);
      if (stderrBuffer.trim()) detail.push(`stderr=${stderrBuffer.trim()}`);
      settle(undefined, new Error(detail.join(" ")));
    });

    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "cycloid-capture", title: "Cycloid Capture", version: "0.0.0" },
        capabilities: { experimentalApi: true },
      },
    });
    setTimeout(() => send({ method: "initialized" }), 100);
    setTimeout(
      () =>
        send({
          id: 2,
          method: "thread/start",
          params: {
            modelProvider: "openai",
            cwd,
            approvalPolicy: "never",
            sandbox: "danger-full-access",
            config: {},
            serviceName: "cycloid-protocol-capture",
            sessionStartSource: "startup",
            threadSource: "user",
          },
        }),
      250,
    );
    setTimeout(() => child.kill("SIGTERM"), 20_000);
  });
}

function buildInventory(captures, version) {
  const itemTypes = new Set();
  const notifications = new Set();
  const serverRequests = new Set();

  for (const lines of captures) {
    for (const line of lines) {
      const message = JSON.parse(line);
      if (typeof message.method === "string" && message.id !== undefined) {
        serverRequests.add(message.method);
      } else if (typeof message.method === "string") {
        notifications.add(message.method);
        const item = message.params?.item;
        if (item && typeof item.type === "string") {
          itemTypes.add(item.type);
        }
        const rawResponseItem = message.params?.item ?? message.params?.responseItem ?? message.params?.response_item;
        if (message.method === "raw_response_item" && rawResponseItem && typeof rawResponseItem.type === "string") {
          itemTypes.add(rawResponseItem.type);
        }
      }
    }
  }

  return {
    codexCliVersion: version,
    itemTypes: [...itemTypes].sort(),
    notifications: [...notifications].sort(),
    serverRequests: [...serverRequests].sort(),
  };
}

function sanitizeCaptureLine(line) {
  const message = JSON.parse(line);

  function sanitize(value) {
    if (Array.isArray(value)) return value.map(sanitize);
    if (!value || typeof value !== "object") {
      if (typeof value !== "string") return value;
      return value
        .replace(/\/Users\/[^/]+\/\.codex\/sessions\/[^\"]+?\.jsonl/g, "$HOME/.codex/sessions/REDACTED.jsonl")
        .replace(/\/Users\/[^/]+\/\.codex\/AGENTS\.md/g, "$HOME/.codex/AGENTS.md")
        .replace(/\/Users\/[^/]+\/\.codex/g, "$HOME/.codex")
        .replace(/\/var\/folders\/[^\"]*codex-protocol-capture-[A-Za-z0-9]+/g, "/tmp/codex-protocol-capture")
        .replace(/codex-protocol-capture-[A-Za-z0-9]+/g, "codex-protocol-capture");
    }

    const sanitized = {};
    for (const [key, rawValue] of Object.entries(value)) {
      if (key === "serverName" && typeof rawValue === "string") {
        sanitized[key] = "redacted-host.local";
        continue;
      }
      if (key === "installationId" && typeof rawValue === "string") {
        sanitized[key] = "00000000-0000-0000-0000-000000000000";
        continue;
      }
      sanitized[key] = sanitize(rawValue);
    }
    return sanitized;
  }

  return JSON.stringify(sanitize(message));
}

function sanitizeCaptureLines(lines) {
  return lines.map(sanitizeCaptureLine);
}

const options = parseArgs(process.argv.slice(2));
const versionDir = join(options.outDir, options.version);
mkdirSync(versionDir, { recursive: true });

const successDir = createScratchDir();
const failureDir = createScratchDir();
writeFileSync(join(successDir, "sample.txt"), "hello\n", "utf8");
writeFileSync(join(failureDir, "sample.txt"), "hello\n", "utf8");
writeFileSync(
  join(failureDir, "AGENTS.md"),
  "Use the exact patch the user gives you. Do not inspect files first.\n",
  "utf8",
);

try {
  const successLines = await captureCase({
    version: options.version,
    cwd: successDir,
    prompt: "Change hello to hi in sample.txt using apply_patch only.",
  });
  const failureLines = await captureCase({
    version: options.version,
    cwd: failureDir,
    prompt:
      "Use apply_patch with this exact patch and do not repair it:\n*** Begin Patch\n*** Update File: sample.txt\n@@\n-goodbye\n+hi\n*** End Patch",
  });
  const sanitizedSuccessLines = sanitizeCaptureLines(successLines);
  const sanitizedFailureLines = sanitizeCaptureLines(failureLines);

  writeFileSync(join(versionDir, "apply-patch-success.ndjson"), `${sanitizedSuccessLines.join("\n")}\n`, "utf8");
  writeFileSync(join(versionDir, "apply-patch-failure.ndjson"), `${sanitizedFailureLines.join("\n")}\n`, "utf8");
  writeFileSync(
    join(versionDir, "inventory.json"),
    `${JSON.stringify(buildInventory([sanitizedSuccessLines, sanitizedFailureLines], options.version), null, 2)}\n`,
    "utf8",
  );
} finally {
  rmSync(successDir, { recursive: true, force: true });
  rmSync(failureDir, { recursive: true, force: true });
}
