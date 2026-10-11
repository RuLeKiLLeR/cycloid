/**
 * Static guard for the sandbox-state-multi-writer bug class.
 *
 * Background: the alarm-slot incident (5h33m runaway prompt) had a single
 * root cause: a singleton resource with multiple uncoordinated writers.
 * Phases 1-6 of the multi-writer cleanup gave each high-risk field exactly
 * one production owner. This guard pins that ownership so a future change
 * cannot silently reintroduce a second writer.
 *
 * Two checks live here:
 *
 * 1. `bulkUpdatePrompts` (phase 6) -- the only DAO that mutates
 *    `prompt.status` -- may only be imported by `prompt-queue.ts`. Pure
 *    regex match on the import statement is sufficient because the surface
 *    is one symbol; an AST pass would be overkill.
 *
 * 2. Sandbox-state column writes (phase 7) -- AST walker over every `.ts`
 *    file in `apps/control-plane-worker/src/`. For each owned column the
 *    walker asserts that:
 *      a. Every `doDb.updateSandboxState(_, _, { <col>: ... })` literal is
 *         in an approved owner file.
 *      b. Every direct `sql.exec("UPDATE sandbox_state ...")` /
 *         `INSERT INTO sandbox_state` / `DELETE FROM sandbox_state` is in
 *         an approved owner file (catches the `disarmLifecycleWatchdogs`
 *         direct-SQL pattern).
 *      c. The same shape for `platform_llm_prompt_status`.
 *      d. Direct DAO wrappers that mutate runtime identity columns
 *         (`doDb.clearRuntimeState`) only appear in their approved file.
 *
 *    Non-literal third args to `updateSandboxState` (e.g. a forwarded
 *    `patch` variable) are out of static reach and skipped. Owner files
 *    that need to thread an opaque patch -- e.g. the `applyRuntimePatch`
 *    helper in `runtime-identity.ts` -- are themselves in the allowlist,
 *    so callers that route through them remain covered.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import * as ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

const APP_ROOT = path.resolve(__dirname, "../../apps/control-plane-worker");
const SRC_ROOT = path.join(APP_ROOT, "src");

const owner = (relativePath: string) => path.join(SRC_ROOT, relativePath);

// --- Phase 6: bulkUpdatePrompts importers ------------------------------------

const ALLOWED_BULK_UPDATE_PROMPTS_FILES = new Set<string>([owner("session/prompt-queue.ts")]);

const NAMED_IMPORT_RE =
  /import\s*(?:type\s+)?\{[^}]*\bbulkUpdatePrompts\b[^}]*\}\s*from\s*["'][^"']*do-db(?:\.js)?["']/;
const NAMESPACE_IMPORT_RE = /import\s*\*\s+as\s+(\w+)\s+from\s*["'][^"']*do-db(?:\.js)?["']/;

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      yield* walk(full);
    } else if (entry.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) {
      yield full;
    }
  }
}

async function findFilesImportingBulkUpdatePrompts(): Promise<string[]> {
  const hits: string[] = [];
  const doDbPath = owner("session/do-db.ts");
  for await (const file of walk(SRC_ROOT)) {
    if (file === doDbPath) continue;
    const text = await fs.readFile(file, "utf8");
    if (NAMED_IMPORT_RE.test(text)) {
      hits.push(file);
      continue;
    }
    const ns = text.match(NAMESPACE_IMPORT_RE);
    if (ns) {
      const usageRe = new RegExp(`\\b${ns[1]}\\.bulkUpdatePrompts\\b`);
      if (usageRe.test(text)) hits.push(file);
    }
  }
  return hits;
}

// --- Phase 7: sandbox-state column ownership --------------------------------

const PROMPT_ACTIVITY = owner("session/sandbox-state-owners/prompt-activity.ts");
const SPAWN_RETRY = owner("session/sandbox-state-owners/spawn-retry.ts");
const TRANSPORT_MARKERS = owner("session/sandbox-state-owners/transport-markers.ts");
const RUNTIME_IDENTITY = owner("session/sandbox-state-owners/runtime-identity.ts");
const E2B_RUNTIME_LIFECYCLE = owner("session/e2b-runtime-lifecycle.ts");
const DO_DB = owner("session/do-db.ts");

const RUNTIME_IDENTITY_OWNERS = new Set<string>([RUNTIME_IDENTITY, E2B_RUNTIME_LIFECYCLE]);

const COLUMN_OWNERS: Record<string, Set<string>> = {
  // Phase 1 -- prompt activity timestamp feeds the alarm scheduler.
  promptLastActivityAt: new Set([PROMPT_ACTIVITY]),

  // Phase 2 -- spawn coordinator state. spawnRetryCount, spawnStartedAt,
  // and lastSpawnAttemptId all flow through spawn-retry.ts helpers.
  spawnRetryCount: new Set([SPAWN_RETRY]),
  spawnStartedAt: new Set([SPAWN_RETRY]),
  lastSpawnAttemptId: new Set([SPAWN_RETRY]),

  // Phase 3 -- transport markers (disconnect grace + auto-close deadline).
  disconnectStartedAt: new Set([TRANSPORT_MARKERS]),
  autoCloseScheduledAt: new Set([TRANSPORT_MARKERS]),

  // Phase 5 -- full runtime patch on sandbox_state. runtime-identity.ts
  // owns the named operations; e2b-runtime-lifecycle.ts hosts the shared
  // write helper (`writeRunningRuntimeState`) it delegates through.
  runtimeState: RUNTIME_IDENTITY_OWNERS,
  runtimeSandboxId: RUNTIME_IDENTITY_OWNERS,
  runtimeProvider: RUNTIME_IDENTITY_OWNERS,
  runtimeLiveLeaseExpiresAt: RUNTIME_IDENTITY_OWNERS,
  runtimeBackend: RUNTIME_IDENTITY_OWNERS,
  runtimeTemplateId: RUNTIME_IDENTITY_OWNERS,
  runtimeStateExpiresAt: RUNTIME_IDENTITY_OWNERS,
  runtimeCreatedAt: RUNTIME_IDENTITY_OWNERS,
  runtimeLastResumedAt: RUNTIME_IDENTITY_OWNERS,
  runtimeLastPausedAt: RUNTIME_IDENTITY_OWNERS,
  runtimeLastProviderRefreshedAt: RUNTIME_IDENTITY_OWNERS,
  runtimeProviderTtlExpiresAt: RUNTIME_IDENTITY_OWNERS,
  runtimePreviewUrl: RUNTIME_IDENTITY_OWNERS,
};

const TABLE_OWNERS: Record<string, Set<string>> = {
  sandbox_state: new Set([DO_DB]),
  platform_llm_prompt_status: new Set([DO_DB]),
};

const DAO_WRAPPER_OWNERS: Record<string, Set<string>> = {
  // doDb.clearRuntimeState mutates the runtime-identity columns directly.
  // Only e2b-runtime-lifecycle.ts (via clearRuntimeAndSyncProjection) may
  // call it.
  clearRuntimeState: new Set([E2B_RUNTIME_LIFECYCLE]),
};

interface Violation {
  file: string;
  line: number;
  kind: "column" | "table" | "daoWrapper";
  detail: string;
}

function getCalleeName(call: ts.CallExpression): { ns: string | null; name: string } | null {
  // ns is only populated when the receiver is a bare identifier (e.g.
  // `doDb.<name>`); deeper chains (`this.sql.exec`, `getSql().exec`) and
  // chained calls return ns=null but still surface the final method name
  // so the `exec` SQL-write guard can run on `this.sql.exec(...)` and
  // similar patterns.
  const expr = call.expression;
  if (ts.isIdentifier(expr)) return { ns: null, name: expr.text };
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    const ns = ts.isIdentifier(expr.expression) ? expr.expression.text : null;
    return { ns, name: expr.name.text };
  }
  return null;
}

const TABLE_WRITE_RE = /^\s*(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(sandbox_state|platform_llm_prompt_status)\b/i;

function classifySqlWrite(literal: string): string | null {
  const m = literal.match(TABLE_WRITE_RE);
  return m ? m[1].toLowerCase() : null;
}

function lineOfNode(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function checkUpdateSandboxState(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  filePath: string,
  violations: Violation[],
): void {
  if (call.arguments.length < 3) return;
  const patchArg = call.arguments[2];
  if (!ts.isObjectLiteralExpression(patchArg)) {
    // Variable / spread / call-expression patches are statically opaque.
    // Owner files handle these (the helper takes a typed patch and writes
    // it); non-owner files that need to forward an opaque patch must route
    // through an owner helper.
    return;
  }
  for (const prop of patchArg.properties) {
    let name: string | null = null;
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) name = prop.name.text;
    else if (ts.isShorthandPropertyAssignment(prop)) name = prop.name.text;
    else if (ts.isSpreadAssignment(prop)) {
      // Spread expands at runtime; we cannot statically know the keys.
      // The spread source is typically a small literal in the owner file. A future caller that adds direct
      // literal writes of owned columns will still surface here.
      continue;
    }
    if (!name) continue;
    if (!Object.prototype.hasOwnProperty.call(COLUMN_OWNERS, name)) continue;
    const allowed = COLUMN_OWNERS[name];
    if (!allowed.has(filePath)) {
      violations.push({
        file: filePath,
        line: lineOfNode(sourceFile, prop),
        kind: "column",
        detail: `updateSandboxState({ ${name}: ... }) outside owner. Allowed owners: ${[...allowed]
          .map((p) => path.relative(SRC_ROOT, p))
          .join(", ")}`,
      });
    }
  }
}

function checkSqlExec(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  filePath: string,
  violations: Violation[],
): void {
  if (call.arguments.length < 1) return;
  const first = call.arguments[0];
  let literal: string | null = null;
  if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) {
    literal = first.text;
  } else if (ts.isTemplateExpression(first)) {
    literal = first.head.text;
  }
  if (literal == null) return;
  const table = classifySqlWrite(literal);
  if (!table) return;
  if (!Object.prototype.hasOwnProperty.call(TABLE_OWNERS, table)) return;
  const allowed = TABLE_OWNERS[table];
  if (!allowed.has(filePath)) {
    violations.push({
      file: filePath,
      line: lineOfNode(sourceFile, call),
      kind: "table",
      detail: `direct write SQL on ${table} outside owner. Allowed: ${[...allowed]
        .map((p) => path.relative(SRC_ROOT, p))
        .join(", ")}`,
    });
  }
}

function checkDaoWrapperCall(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  filePath: string,
  violations: Violation[],
): void {
  const callee = getCalleeName(call);
  if (!callee) return;
  // Match only qualified `doDb.<name>` calls so unrelated objects that
  // happen to expose a same-named method do not trip the guard.
  if (callee.ns !== "doDb") return;
  if (!Object.prototype.hasOwnProperty.call(DAO_WRAPPER_OWNERS, callee.name)) return;
  const allowed = DAO_WRAPPER_OWNERS[callee.name];
  if (allowed.has(filePath)) return;
  // do-db.ts defines the wrapper; its own definition is not a call.
  if (filePath === DO_DB) return;
  violations.push({
    file: filePath,
    line: lineOfNode(sourceFile, call),
    kind: "daoWrapper",
    detail: `call to DAO wrapper ${callee.name}() outside owner. Allowed: ${[...allowed]
      .map((p) => path.relative(SRC_ROOT, p))
      .join(", ")}`,
  });
}

async function collectViolations(): Promise<Violation[]> {
  const violations: Violation[] = [];
  for await (const file of walk(SRC_ROOT)) {
    const text = await fs.readFile(file, "utf8");
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = getCalleeName(node);
        if (callee) {
          if (callee.name === "updateSandboxState") {
            checkUpdateSandboxState(node, sourceFile, file, violations);
          }
          if (callee.name === "exec") {
            checkSqlExec(node, sourceFile, file, violations);
          }
          if (Object.prototype.hasOwnProperty.call(DAO_WRAPPER_OWNERS, callee.name)) {
            checkDaoWrapperCall(node, sourceFile, file, violations);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return violations;
}

function formatViolations(violations: Violation[]): string {
  if (violations.length === 0) return "";
  return violations.map((v) => `  ${path.relative(SRC_ROOT, v.file)}:${v.line} [${v.kind}] ${v.detail}`).join("\n");
}

// ----------------------------------------------------------------------------

describe("sandbox-state ownership static guard", () => {
  it("only prompt-queue.ts imports bulkUpdatePrompts from do-db (single owner for prompt.status)", async () => {
    const hits = await findFilesImportingBulkUpdatePrompts();
    const violations = hits.filter((file) => !ALLOWED_BULK_UPDATE_PROMPTS_FILES.has(file));
    expect(
      violations,
      `bulkUpdatePrompts must only be imported by prompt-queue.ts (the single owner for prompt.status). ` +
        `Violators: ${violations.map((f) => path.relative(APP_ROOT, f)).join(", ")}`,
    ).toEqual([]);
  });

  describe("AST ownership checks", () => {
    // Walking every .ts file and parsing it through the TypeScript compiler
    // is the slow part of this suite. Collect once and let each test filter
    // the shared list -- otherwise the same parse runs three times per
    // suite execution.
    let allViolations: Violation[];
    beforeAll(async () => {
      allViolations = await collectViolations();
    });

    it("owned sandbox_state columns are written only from their approved owner files", () => {
      const violations = allViolations.filter((v) => v.kind === "column");
      expect(
        violations,
        `Out-of-owner sandbox_state writes detected. Each owned column must be written through its sandbox-state-owners helper:\n${formatViolations(violations)}\n`,
      ).toEqual([]);
    });

    it("direct SQL on sandbox_state and platform_llm_prompt_status only happens in do-db.ts", () => {
      const violations = allViolations.filter((v) => v.kind === "table");
      expect(
        violations,
        `Direct SQL writes to owned tables detected outside do-db.ts:\n${formatViolations(violations)}\n`,
      ).toEqual([]);
    });

    it("doDb DAO wrappers that mutate runtime-identity columns are only invoked from approved owner files", () => {
      const violations = allViolations.filter((v) => v.kind === "daoWrapper");
      expect(violations, `Out-of-owner DAO wrapper calls detected:\n${formatViolations(violations)}\n`).toEqual([]);
    });
  });

  describe("matchers (unit)", () => {
    it("regex matcher: named import of bulkUpdatePrompts", () => {
      expect(NAMED_IMPORT_RE.test(`import { bulkUpdatePrompts } from "./do-db";`)).toBe(true);
      expect(NAMED_IMPORT_RE.test(`import { getPrompt, bulkUpdatePrompts, foo } from "./do-db.js";`)).toBe(true);
    });

    it("regex matcher: comment mention does not count", () => {
      const text = `// historical note: bulkUpdatePrompts used to live elsewhere\nimport { x } from "./do-db.js";`;
      expect(NAMED_IMPORT_RE.test(text)).toBe(false);
    });

    it("SQL classifier: UPDATE sandbox_state matches", () => {
      expect(classifySqlWrite("UPDATE sandbox_state SET status = ?")).toBe("sandbox_state");
      expect(classifySqlWrite("  UPDATE   sandbox_state SET x = ?")).toBe("sandbox_state");
    });

    it("SQL classifier: writes on platform_llm_prompt_status match", () => {
      expect(classifySqlWrite("INSERT INTO platform_llm_prompt_status (...) VALUES (?, ?)")).toBe(
        "platform_llm_prompt_status",
      );
      expect(classifySqlWrite("UPDATE platform_llm_prompt_status SET status = ?")).toBe("platform_llm_prompt_status");
      expect(classifySqlWrite("DELETE FROM platform_llm_prompt_status WHERE prompt_id = ?")).toBe(
        "platform_llm_prompt_status",
      );
    });

    it("SQL classifier: reads on the same tables are ignored", () => {
      expect(classifySqlWrite("SELECT * FROM sandbox_state WHERE session_id = ?")).toBeNull();
      expect(classifySqlWrite("SELECT * FROM platform_llm_prompt_status WHERE prompt_id = ?")).toBeNull();
    });

    it("SQL classifier: writes on other tables are ignored", () => {
      expect(classifySqlWrite("UPDATE sessions SET status = ?")).toBeNull();
    });
  });
});
