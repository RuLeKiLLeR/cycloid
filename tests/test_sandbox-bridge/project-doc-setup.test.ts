// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { lstatSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CODEX_OVERRIDE_DOC,
  CODEX_PROJECT_DOC_MAX_BYTES,
  CYCLOID_PROJECT_DOC,
  materializeCycloidOverride,
  readEffectiveProjectDocContent,
  resolveEffectiveProjectDoc,
  resolveProjectDoc,
  setupProjectDocPrecedence,
} from "../../apps/sandbox-bridge/src/utils/project-doc-setup.js";

function makeLog() {
  const warns: unknown[] = [];
  const infos: unknown[] = [];
  const errors: unknown[] = [];
  const log = {
    info: (obj: unknown) => infos.push(obj),
    warn: (obj: unknown) => warns.push(obj),
    error: (obj: unknown) => errors.push(obj),
    debug: () => {},
    child: () => log,
  };
  return { log, warns, infos, errors };
}

let cwd: string;
const cleanup: string[] = [];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "project-doc-"));
  cleanup.push(cwd);
});

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, body = "x") => writeFileSync(join(cwd, name), body, "utf-8");

describe("resolveProjectDoc", () => {
  it("returns null when no doc exists", () => {
    expect(resolveProjectDoc(cwd)).toEqual({ winner: null, bytes: 0, overBudget: false });
  });

  it("prefers CYCLOID.md over AGENTS.md and CLAUDE.md", () => {
    write("CYCLOID.md");
    write("AGENTS.md");
    write("CLAUDE.md");
    expect(resolveProjectDoc(cwd).winner).toBe("CYCLOID.md");
  });

  it("falls back to AGENTS.md when CYCLOID.md is absent", () => {
    write("AGENTS.md");
    write("CLAUDE.md");
    expect(resolveProjectDoc(cwd).winner).toBe("AGENTS.md");
  });

  it("falls back to CLAUDE.md when only it exists", () => {
    write("CLAUDE.md");
    expect(resolveProjectDoc(cwd).winner).toBe("CLAUDE.md");
  });

  it("flags a winner over the byte budget", () => {
    write("CYCLOID.md", "x".repeat(CODEX_PROJECT_DOC_MAX_BYTES + 1));
    const res = resolveProjectDoc(cwd);
    expect(res.overBudget).toBe(true);
    expect(res.bytes).toBe(CODEX_PROJECT_DOC_MAX_BYTES + 1);
  });

  it("does not flag a winner at exactly the budget", () => {
    write("CYCLOID.md", "x".repeat(CODEX_PROJECT_DOC_MAX_BYTES));
    expect(resolveProjectDoc(cwd).overBudget).toBe(false);
  });
});

describe("resolveEffectiveProjectDoc", () => {
  const big = "x".repeat(CODEX_PROJECT_DOC_MAX_BYTES + 1);

  it("reports CYCLOID.md when the override is our symlink", () => {
    write(CYCLOID_PROJECT_DOC);
    write("AGENTS.md");
    materializeCycloidOverride(cwd);
    expect(resolveEffectiveProjectDoc(cwd).winner).toBe("CYCLOID.md");
  });

  it("reports the foreign override Codex actually reads", () => {
    write(CYCLOID_PROJECT_DOC, "small");
    writeFileSync(join(cwd, CODEX_OVERRIDE_DOC), big, "utf-8");
    const res = resolveEffectiveProjectDoc(cwd);
    expect(res.winner).toBe(CODEX_OVERRIDE_DOC);
    // Sizes the foreign override, not the small CYCLOID.md.
    expect(res.bytes).toBe(big.length);
    expect(res.overBudget).toBe(true);
  });

  it("falls back to real-file precedence when no override exists", () => {
    write("AGENTS.md");
    expect(resolveEffectiveProjectDoc(cwd).winner).toBe("AGENTS.md");
  });
});

describe("readEffectiveProjectDocContent", () => {
  it("returns null when no doc exists", () => {
    const { log } = makeLog();
    expect(readEffectiveProjectDocContent(cwd, log)).toBeNull();
  });

  it("reads the precedence winner's contents", () => {
    write("AGENTS.md", "agents body");
    write("CLAUDE.md", "claude body");
    const { log } = makeLog();
    expect(readEffectiveProjectDocContent(cwd, log)).toEqual({
      name: "AGENTS.md",
      content: "agents body",
      truncated: false,
    });
  });

  it("follows the CYCLOID.md override symlink", () => {
    write(CYCLOID_PROJECT_DOC, "cycloid body");
    write("AGENTS.md", "agents body");
    const { log } = makeLog();
    materializeCycloidOverride(cwd);
    expect(readEffectiveProjectDocContent(cwd, log)).toEqual({
      name: CYCLOID_PROJECT_DOC,
      content: "cycloid body",
      truncated: false,
    });
  });

  it("truncates an over-budget doc at the Codex byte ceiling and warns", () => {
    write("CLAUDE.md", "y".repeat(CODEX_PROJECT_DOC_MAX_BYTES + 100));
    const { log, warns } = makeLog();
    const result = readEffectiveProjectDocContent(cwd, log);
    expect(result?.truncated).toBe(true);
    expect(Buffer.byteLength(result!.content, "utf-8")).toBeLessThanOrEqual(CODEX_PROJECT_DOC_MAX_BYTES);
    expect(warns.length).toBe(1);
  });

  it("truncates multi-byte UTF-8 at a character boundary without U+FFFD", () => {
    // "é" is 2 bytes; an odd byte ceiling lands mid-character without the backoff.
    write("CLAUDE.md", "é".repeat(CODEX_PROJECT_DOC_MAX_BYTES));
    const { log } = makeLog();
    const result = readEffectiveProjectDocContent(cwd, log);
    expect(result?.truncated).toBe(true);
    expect(result?.content.includes("�")).toBe(false);
    expect(Buffer.byteLength(result!.content, "utf-8")).toBeLessThanOrEqual(CODEX_PROJECT_DOC_MAX_BYTES);
  });

  it("skips a doc symlinked outside the repository", () => {
    const outside = mkdtempSync(join(tmpdir(), "project-doc-outside-"));
    cleanup.push(outside);
    writeFileSync(join(outside, "secret.txt"), "secret content", "utf-8");
    symlinkSync(join(outside, "secret.txt"), join(cwd, CODEX_OVERRIDE_DOC));
    const { log, warns } = makeLog();
    expect(readEffectiveProjectDocContent(cwd, log)).toBeNull();
    expect(warns.some((w) => (w as { event?: string }).event === "project_doc_outside_repo_skipped")).toBe(true);
  });

  it("honors the legacy lowercase agents.md as the last fallback", () => {
    write("agents.md", "legacy agents body");
    const { log } = makeLog();
    const result = readEffectiveProjectDocContent(cwd, log);
    // Case-insensitive filesystems (macOS dev) report the AGENTS.md rung for the
    // same file; the sandbox runs on a case-sensitive filesystem.
    expect(result?.name.toLowerCase()).toBe("agents.md");
    expect(result?.content).toBe("legacy agents body");
    expect(result?.truncated).toBe(false);
  });

  it("returns null for an effectively empty doc", () => {
    write("CLAUDE.md", "   \n  ");
    const { log } = makeLog();
    expect(readEffectiveProjectDocContent(cwd, log)).toBeNull();
  });
});

describe("materializeCycloidOverride", () => {
  it("creates a relative symlink to CYCLOID.md", () => {
    write(CYCLOID_PROJECT_DOC);
    expect(materializeCycloidOverride(cwd)).toBe("created");
    const link = join(cwd, CODEX_OVERRIDE_DOC);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(CYCLOID_PROJECT_DOC);
  });

  it("is idempotent when our symlink already exists", () => {
    write(CYCLOID_PROJECT_DOC);
    materializeCycloidOverride(cwd);
    expect(materializeCycloidOverride(cwd)).toBe("already_ours");
  });

  it("does not clobber a customer-owned AGENTS.override.md", () => {
    write(CYCLOID_PROJECT_DOC);
    writeFileSync(join(cwd, CODEX_OVERRIDE_DOC), "customer content", "utf-8");
    expect(materializeCycloidOverride(cwd)).toBe("foreign_exists");
    expect(lstatSync(join(cwd, CODEX_OVERRIDE_DOC)).isSymbolicLink()).toBe(false);
  });

  it("does nothing when CYCLOID.md is absent", () => {
    expect(materializeCycloidOverride(cwd)).toBe("skipped_no_cycloid_doc");
    expect(() => lstatSync(join(cwd, CODEX_OVERRIDE_DOC))).toThrow();
  });

  it("removes our own stale override symlink when CYCLOID.md is deleted", () => {
    write(CYCLOID_PROJECT_DOC);
    materializeCycloidOverride(cwd);
    rmSync(join(cwd, CYCLOID_PROJECT_DOC));
    expect(materializeCycloidOverride(cwd)).toBe("removed_stale_override");
    expect(() => lstatSync(join(cwd, CODEX_OVERRIDE_DOC))).toThrow();
  });

  it("leaves a foreign override untouched when CYCLOID.md is absent", () => {
    writeFileSync(join(cwd, CODEX_OVERRIDE_DOC), "customer content", "utf-8");
    expect(materializeCycloidOverride(cwd)).toBe("skipped_no_cycloid_doc");
    expect(lstatSync(join(cwd, CODEX_OVERRIDE_DOC)).isSymbolicLink()).toBe(false);
  });
});

describe("setupProjectDocPrecedence", () => {
  it("links CYCLOID.md and reports the resolution", () => {
    write(CYCLOID_PROJECT_DOC);
    write("AGENTS.md");
    const { log, errors } = makeLog();
    const res = setupProjectDocPrecedence({ cwd, log });
    expect(res.winner).toBe("CYCLOID.md");
    expect(lstatSync(join(cwd, CODEX_OVERRIDE_DOC)).isSymbolicLink()).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it("logs an error event when the winner is over budget", () => {
    write("AGENTS.md", "x".repeat(CODEX_PROJECT_DOC_MAX_BYTES + 1));
    const { log, errors } = makeLog();
    setupProjectDocPrecedence({ cwd, log });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ event: "project_doc_over_budget", winner: "AGENTS.md" });
  });

  it("budget-checks a foreign override against the file Codex reads", () => {
    write(CYCLOID_PROJECT_DOC, "small");
    writeFileSync(join(cwd, CODEX_OVERRIDE_DOC), "x".repeat(CODEX_PROJECT_DOC_MAX_BYTES + 1), "utf-8");
    const { log, warns, errors } = makeLog();
    const res = setupProjectDocPrecedence({ cwd, log });
    expect(res.winner).toBe(CODEX_OVERRIDE_DOC);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ event: "project_doc_over_budget", winner: CODEX_OVERRIDE_DOC });
    expect(warns.some((w) => (w as { override?: string }).override === CODEX_OVERRIDE_DOC)).toBe(true);
  });

  it("does not throw when no project doc exists", () => {
    const { log } = makeLog();
    expect(() => setupProjectDocPrecedence({ cwd, log })).not.toThrow();
  });
});
