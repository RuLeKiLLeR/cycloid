import { OpenAIModel } from "../../../../shared/constants/models.js";

/**
 * The memory analyzer is async background work, not prompt dispatch. It has a
 * 120s wall-clock budget and summarizes review feedback plus session history.
 * This is a bounded platform sidecar, so use the small OpenAI model.
 */
export const MEMORY_AGENT_MODEL = OpenAIModel.GPT54Mini;

/** Max output tokens for the structured analysis call. */
export const MEMORY_AGENT_MAX_TOKENS_PER_TURN = 4096;

/** Wall-clock timeout for the full analysis. */
export const MEMORY_AGENT_TOTAL_TIMEOUT_MS = 120_000;

export const MEMORY_CONTENT_MAX_LENGTH = 2000;

/** Max queue delivery attempts before a memory analysis job is terminalized. */
export const MEMORY_JOB_MAX_ATTEMPTS = 3;

/**
 * How long a 'processing' job must be stale before it can be reclaimed.
 * Must exceed the full consumer path: comment fetch (~5s) + analysis (120s)
 * + branch/file/PR creation (~30s) ≈ 155s. Set to 10 minutes to avoid
 * reclaiming healthy-but-slow runs.
 */
export const MEMORY_JOB_STALE_THRESHOLD_MS = 600_000;
export const MEMORY_BRANCH_PREFIX = "memory/update-from-pr-";

/**
 * Docs files the analyzer may propose convention updates to. Maps path → description for the prompt.
 * This must include every doc referenced from CLAUDE.md — those files are effectively part of
 * CLAUDE.md since they're symlinked/referenced and loaded into agent context.
 */
export const CONVENTION_TARGET_FILES = new Map<string, string>([
  [
    "docs/conventions.md",
    "Code patterns, folder structure, imports, error handling, TypeScript, and engineering principles",
  ],
  ["docs/testing.md", "Test organization, what to test, mock patterns"],
  ["docs/workflow.md", "Planning, task tracking, branching, PRs, execution"],
  ["docs/security.md", "Secrets, auth modes, webhook verification, token storage"],
  ["docs/bridge.md", "Bridge event flow, prompt/runtime layering, MCP guidance, and behavioral guidance lifecycle"],
  ["docs/database.md", "Schema, D1, migration workflow, DAO layer"],
  ["docs/prompt-post-execution.md", "Post-execution LLM calls, PR generation, safety"],
  ["docs/tech-stack.md", "Technology per layer, 'not X' guards, library introduction rules"],
  ["docs/codebase-map.md", "Apps summary, file lookup table, cross-app data flow, shared types"],
  ["docs/user-access.md", "Adding users, business membership, repo access controls"],
  ["docs/adding-integrations.md", "Step-by-step runbook for new OAuth or API-key integrations"],
  ["docs/onboarding-checklist.md", "Customer onboarding steps, credentials, optional integrations"],
  ["docs/infrastructure.md", "Terraform Cloud, SSM, importing resources, TFC variables"],
  ["docs/deployments.md", "UI, control plane, and infrastructure deploy-on-push flow"],
  ["docs/production.md", "SSH access, deploy commands, env vars, troubleshooting"],
  ["docs/sandbox-architecture.md", "E2B sandbox filesystem layout, process tree, file changes, legacy eval notes"],
  ["docs/prompt-agents.md", "Agent identity prompts and builtin agent configs"],
  ["docs/debugging.md", "Tailing prod logs, filtering by status/method, debugging techniques"],
  ["docs/mcp.md", "MCP external source references and per-server tool rules"],
  ["docs/cli.md", "CLI setup, authentication, commands, troubleshooting"],
  ["docs/what-is-cycloid.md", "System overview"],
]);
