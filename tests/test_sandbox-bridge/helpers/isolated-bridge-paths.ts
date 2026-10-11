// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
//
// Redirect every shared `/tmp/` path that sandbox-bridge code reads at module
// load to a per-test-file scratch directory. Importing this file as a side
// effect from a test file (BEFORE any `apps/sandbox-bridge` import) sets the
// override env vars; the bridge constants then resolve to per-file subpaths
// instead of shared globals. Production defaults are unchanged: each constant
// falls back to its original `/tmp/...` literal when the env var is absent.
//
// Why a separate module from `bridge-test-harness.ts`: the harness installs
// heavy `vi.mock` calls (codex-server, ws, child_process, diagnostics) that
// some test files — e.g. `codex-stdio.test.ts` — must NOT receive. This file
// is mock-free so those tests can opt into path
// isolation without inheriting harness mocks.
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export interface IsolatedSandboxBridgePaths {
  root: string;
  runtimeEvidenceDir: string;
  phaseEvidenceDir: string;
  phaseNotesDir: string;
  baselineEvidenceDir: string;
  authStateRoot: string;
  cycloidCliAuthPendingPath: string;
  cycloidCliAuthReadyPath: string;
  cycloidCliAuthFailedPath: string;
  previewContractPath: string;
  codexHomePrefix: string;
  outboxDir: string;
}

let cached: IsolatedSandboxBridgePaths | undefined;

export function setupIsolatedSandboxBridgePaths(): IsolatedSandboxBridgePaths {
  if (cached) return cached;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bridge-test-")));
  const paths: IsolatedSandboxBridgePaths = {
    root,
    runtimeEvidenceDir: join(root, "evidence"),
    phaseEvidenceDir: join(root, "phase-evidence"),
    phaseNotesDir: join(root, "phase-notes"),
    baselineEvidenceDir: join(root, "baseline"),
    authStateRoot: join(root, "auth"),
    cycloidCliAuthPendingPath: join(root, "cli-auth-pending"),
    cycloidCliAuthReadyPath: join(root, "cli-auth-ready"),
    cycloidCliAuthFailedPath: join(root, "cli-auth-failed"),
    previewContractPath: join(root, "preview-contract.json"),
    codexHomePrefix: join(root, "codex-home-"),
    outboxDir: join(root, "outbox"),
  };
  process.env.ARCANIST_RUNTIME_EVIDENCE_DIR = paths.runtimeEvidenceDir;
  process.env.ARCANIST_PHASE_EVIDENCE_DIR = paths.phaseEvidenceDir;
  process.env.ARCANIST_PHASE_NOTES_DIR = paths.phaseNotesDir;
  process.env.ARCANIST_BASELINE_EVIDENCE_DIR = paths.baselineEvidenceDir;
  process.env.ARCANIST_AUTH_STATE_ROOT = paths.authStateRoot;
  process.env.ARCANIST_CLI_AUTH_PENDING_PATH = paths.cycloidCliAuthPendingPath;
  process.env.ARCANIST_CLI_AUTH_READY_PATH = paths.cycloidCliAuthReadyPath;
  process.env.ARCANIST_CLI_AUTH_FAILED_PATH = paths.cycloidCliAuthFailedPath;
  process.env.ARCANIST_PREVIEW_CONTRACT_PATH = paths.previewContractPath;
  process.env.ARCANIST_CODEX_HOME_PREFIX = paths.codexHomePrefix;
  process.env.ARCANIST_OUTBOX_DIR = paths.outboxDir;
  process.on("exit", () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });
  cached = paths;
  return paths;
}

export const isolatedSandboxBridgePaths: IsolatedSandboxBridgePaths = setupIsolatedSandboxBridgePaths();
