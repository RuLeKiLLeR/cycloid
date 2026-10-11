import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync } from "fs";
import { join, sep } from "path";

import type { BridgeLogger } from "../logger.js";

/**
 * Cycloid-owned project instructions file. Committed to the customer repo at
 * onboarding (human-reviewable); never edited in place by the sandbox.
 */
export const CYCLOID_PROJECT_DOC = "CYCLOID.md";

/**
 * Codex resolves `AGENTS.override.md` ahead of the repo's `AGENTS.md`
 * (core/src/agents_md.rs in the vendored Codex build). We surface `CYCLOID.md`
 * through that native override slot so it wins precedence over a customer's
 * `AGENTS.md` WITHOUT touching any customer file. The override is a relative
 * symlink to `CYCLOID.md`, so a single source file stays the source of truth.
 */
export const CODEX_OVERRIDE_DOC = "AGENTS.override.md";

/**
 * Precedence order Cycloid guarantees: `CYCLOID.md` > `AGENTS.md` > `CLAUDE.md`
 * > `agents.md`. `AGENTS.md` (Codex's hardcoded primary) and the fallback list in
 * codex-session.ts already encode the lower rungs; the override symlink adds the
 * `CYCLOID.md` rung. Lowercase `agents.md` is the legacy last-resort fallback.
 */
export const PROJECT_DOC_PRECEDENCE = ["CYCLOID.md", "AGENTS.md", "CLAUDE.md", "agents.md"] as const;

export type ProjectDocName = (typeof PROJECT_DOC_PRECEDENCE)[number];

/**
 * The file Codex actually injects. Usually one of the precedence names, but when
 * a repo ships its own `AGENTS.override.md` (which we never replace) that foreign
 * override is what Codex reads.
 */
export type EffectiveProjectDocName = ProjectDocName | typeof CODEX_OVERRIDE_DOC;

/**
 * Codex's default `project_doc_max_bytes`. A resolved doc larger than this is
 * silently truncated when injected into the prompt, so we warn loudly instead.
 * Kept in sync with the byte budget the onboarding generator targets.
 */
export const CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024;

export interface ProjectDocSetupDeps {
  cwd: string;
  log: BridgeLogger;
}

export interface ProjectDocResolution {
  /** The doc Codex injects (override-aware), or null if none exists. */
  winner: EffectiveProjectDocName | null;
  /** Byte size of the winning file (0 when there is no winner). */
  bytes: number;
  /** True when the winner exceeds Codex's truncation ceiling. */
  overBudget: boolean;
}

/** lstat-based existence check that does not follow (or require) symlink targets. */
function pathPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** stat-based byte size (follows symlinks); 0 on any error. */
function statBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** True when `path` is our relative symlink to CYCLOID.md (not a foreign override). */
function isOurOverride(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && readlinkSync(path) === CYCLOID_PROJECT_DOC;
  } catch {
    return false;
  }
}

/**
 * Pure precedence resolution over real repo files; no side effects and no
 * override awareness. The winner is the first of `CYCLOID.md > AGENTS.md >
 * CLAUDE.md` that exists at the repo root. For the doc Codex actually injects,
 * use `resolveEffectiveProjectDoc`.
 */
export function resolveProjectDoc(cwd: string): ProjectDocResolution {
  for (const name of PROJECT_DOC_PRECEDENCE) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    const bytes = statBytes(path);
    return { winner: name, bytes, overBudget: bytes > CODEX_PROJECT_DOC_MAX_BYTES };
  }
  return { winner: null, bytes: 0, overBudget: false };
}

/**
 * Resolve the doc Codex actually injects, accounting for the override slot.
 * Codex reads `AGENTS.override.md` ahead of everything when it exists: our
 * materialized symlink (which resolves to `CYCLOID.md`) or a customer's own
 * override. Either way that file's size drives the budget check. Call AFTER
 * `materializeCycloidOverride` so our symlink is already in place.
 */
export function resolveEffectiveProjectDoc(cwd: string): ProjectDocResolution {
  const overridePath = join(cwd, CODEX_OVERRIDE_DOC);
  if (existsSync(overridePath)) {
    const bytes = statBytes(overridePath);
    return {
      winner: isOurOverride(overridePath) ? CYCLOID_PROJECT_DOC : CODEX_OVERRIDE_DOC,
      bytes,
      overBudget: bytes > CODEX_PROJECT_DOC_MAX_BYTES,
    };
  }
  return resolveProjectDoc(cwd);
}

export interface EffectiveProjectDocContent {
  name: EffectiveProjectDocName;
  content: string;
  truncated: boolean;
}

/**
 * Read the effective project doc's contents for backends that cannot load it
 * natively. Codex reads the doc itself through the override slot; the Claude
 * Agent SDK loads no filesystem settings, so the bridge must inject the doc
 * into the system prompt. Same precedence, same byte ceiling as Codex.
 */
export function readEffectiveProjectDocContent(cwd: string, log: BridgeLogger): EffectiveProjectDocContent | null {
  const resolution = resolveEffectiveProjectDoc(cwd);
  if (!resolution.winner) return null;
  try {
    const docPath = join(cwd, resolution.winner);
    // A repo-committed symlink (e.g. a foreign AGENTS.override.md) must not pull
    // file content from outside the repo into the system prompt.
    const repoRoot = realpathSync(cwd);
    const realDocPath = realpathSync(docPath);
    if (realDocPath !== repoRoot && !realDocPath.startsWith(repoRoot + sep)) {
      log.warn(
        { event: "project_doc_outside_repo_skipped", doc: resolution.winner, resolvedPath: realDocPath },
        "Project doc resolves outside the repository; skipping injection",
      );
      return null;
    }
    const raw = readFileSync(docPath);
    const truncated = raw.byteLength > CODEX_PROJECT_DOC_MAX_BYTES;
    // Back the cut off any UTF-8 continuation bytes so truncation never leaves a
    // partial multi-byte sequence (which would decode to U+FFFD).
    let end = CODEX_PROJECT_DOC_MAX_BYTES;
    while (truncated && end > 0 && (raw[end]! & 0xc0) === 0x80) end--;
    const content = (truncated ? raw.subarray(0, end) : raw).toString("utf-8").trim();
    if (truncated) {
      log.warn(
        { event: "project_doc_truncated_for_injection", doc: resolution.winner, bytes: raw.byteLength },
        "Project doc exceeds the injection byte budget; injecting a truncated prefix",
      );
    }
    if (!content) return null;
    return { name: resolution.winner, content, truncated };
  } catch (err) {
    log.warn(
      { event: "project_doc_read_failed", doc: resolution.winner, error: String(err) },
      "Failed to read the effective project doc for injection",
    );
    return null;
  }
}

export type OverrideAction =
  "created" | "already_ours" | "foreign_exists" | "removed_stale_override" | "skipped_no_cycloid_doc";

/**
 * Materialize the `AGENTS.override.md` symlink when `CYCLOID.md` is present, so
 * Codex reads the Cycloid doc ahead of the customer's `AGENTS.md`. Idempotent
 * and non-destructive: a pre-existing override that is not our symlink is left
 * untouched (the customer owns it).
 *
 * When `CYCLOID.md` is absent but a prior session left OUR override symlink
 * behind (e.g. the customer deleted `CYCLOID.md` and a paused sandbox resumed),
 * the symlink now dangles and Codex would resolve the override slot to a missing
 * target. We unlink only our own symlink (never a customer-owned override).
 */
export function materializeCycloidOverride(cwd: string): OverrideAction {
  const cycloidPath = join(cwd, CYCLOID_PROJECT_DOC);
  const overridePathForCleanup = join(cwd, CODEX_OVERRIDE_DOC);
  if (!existsSync(cycloidPath)) {
    if (isOurOverride(overridePathForCleanup)) {
      try {
        unlinkSync(overridePathForCleanup);
        return "removed_stale_override";
      } catch {
        // Best-effort: leave the stale link for a later pass rather than throw.
      }
    }
    return "skipped_no_cycloid_doc";
  }

  const overridePath = join(cwd, CODEX_OVERRIDE_DOC);
  if (pathPresent(overridePath)) {
    try {
      if (lstatSync(overridePath).isSymbolicLink() && readlinkSync(overridePath) === CYCLOID_PROJECT_DOC) {
        return "already_ours";
      }
    } catch {
      // fall through and treat as foreign
    }
    return "foreign_exists";
  }

  // Relative target so the link resolves regardless of the repo's mount path.
  symlinkSync(CYCLOID_PROJECT_DOC, overridePath);
  return "created";
}

/**
 * Establish the `CYCLOID.md > AGENTS.md > CLAUDE.md` precedence for the Codex
 * project doc and surface an over-budget warning. Runs once at bridge startup,
 * before any Codex session is spawned. Fail-soft: a filesystem error here must
 * not block the agent from starting.
 */
export function setupProjectDocPrecedence(deps: ProjectDocSetupDeps): ProjectDocResolution {
  let action: OverrideAction | "error" = "skipped_no_cycloid_doc";
  try {
    action = materializeCycloidOverride(deps.cwd);
  } catch (err) {
    // Record a distinct sentinel so the resolution log below doesn't claim
    // "skipped_no_cycloid_doc" (its initial value) when materialization failed.
    action = "error";
    deps.log.warn({ error: String(err) }, "Failed to materialize CYCLOID.md override symlink");
  }

  // Resolve after materialization so the budget check sizes the file Codex
  // actually injects (our symlink, a foreign override, or a fallback file).
  const resolution = resolveEffectiveProjectDoc(deps.cwd);
  deps.log.info(
    { winner: resolution.winner, bytes: resolution.bytes, overrideAction: action },
    "Resolved Codex project doc precedence",
  );
  if (action === "foreign_exists") {
    deps.log.warn(
      { override: CODEX_OVERRIDE_DOC },
      "Repo ships its own AGENTS.override.md; leaving it in place and not linking CYCLOID.md",
    );
  }

  if (resolution.winner && resolution.overBudget) {
    deps.log.error(
      {
        event: "project_doc_over_budget",
        winner: resolution.winner,
        bytes: resolution.bytes,
        maxBytes: CODEX_PROJECT_DOC_MAX_BYTES,
      },
      "Resolved project doc exceeds Codex project_doc_max_bytes and will be truncated",
    );
  }

  return resolution;
}
