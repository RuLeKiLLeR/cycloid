# ARC-1126: `.cycloid.json` PR template precedence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the publish path resolve a PR template by precedence — `.cycloid.json` `pr.templatePath` → `.github` auto-discovery → built-in default — and render an `.cycloid.json`-pointed template exactly like an auto-discovered one.

**Architecture:** New `CycloidJsonPrTemplateProvider` in `pr-template.ts` reads `<repoRoot>/.cycloid.json` from the local checkout (same pattern as `pre-publish-tests.ts`) and yields the configured template as a candidate. New `resolvePrTemplateChain([...providers])` tries providers in order, returns the first `found`. The post-execution runner composes `[CycloidJson, RepoLocal]` with a documented insertion point for ARC-1124's memory tier between auto-discovery and the built-in default. Rendering (`renderPrBodyFromTemplate`) and the downstream `pr.ts` render call are reused unchanged — already source-agnostic.

**Tech Stack:** TypeScript, Node `fs`/`path`, Vitest. Bridge package (`apps/sandbox-bridge`).

---

## Scope guard (do NOT cross into ARC-1124)

Only touch **publish-path resolution + render**. Do **not** implement: `pr_structure` memory, the `update_pr` capture flow, `MemoryPrTemplateProvider`, or the `pr_body_agent_override` freeze removal — all ARC-1124. The only nod to ARC-1124 here is a comment marking where the memory provider plugs into the chain.

## File structure

- **Modify** `apps/sandbox-bridge/src/services/pr-template.ts` — add `"cycloid_config"` to `PrTemplateSource`; parametrize `readTemplateFile` with a `source`; add `CycloidJsonPrTemplateProvider`; add `resolvePrTemplateChain`.
- **Modify** `apps/sandbox-bridge/src/services/post-execution/post-execution-runner.ts:404` (and its import on line 65) — build the provider chain.
- **Modify** `tests/test_sandbox-bridge/pr-template.test.ts` — add provider, precedence, regression, and render tests.
- **Modify** `docs/customer-repo-config.md` — document `pr.templatePath`.

Reused unchanged (no edits): `renderPrBodyFromTemplate` and the `input.prTemplate?.status === "found"` branch at `apps/sandbox-bridge/src/services/pr.ts:1234` (source-agnostic — renders `input.prTemplate.candidate` regardless of origin). The ARC-1014 dedup marker is appended further downstream, unaffected by template source, so preserved automatically.

## Design decisions (locked)

- **Field shape:** `pr.templatePath` — single repo-relative path string to a markdown template file. Nested `pr` block matches the `verify.test` / `appRuntime` config style. Unknown to control-plane parsing (`repo-preview.ts` only reads `appRuntime`), so adding `pr` does not break it.
- **Where it's read:** the **bridge**, from the local checkout at publish time — same pattern as `apps/sandbox-bridge/src/utils/pre-publish-tests.ts`. No control-plane change.
- **Fail-soft everywhere:** missing config, invalid JSON, missing/non-string/absolute/non-`.md`/traversal path, or nonexistent target file → provider yields `[]`, chain falls through to auto-discovery → default. Matches the existing fail-soft posture of `readTemplateFile`/`resolvePrTemplate`.
- **New source value `"cycloid_config"`** distinguishes the tier in the `pr_template.resolved` telemetry log; does not affect rendering.

---

### Task 1: `CycloidJsonPrTemplateProvider` reads `pr.templatePath`

**Files:**

- Modify: `apps/sandbox-bridge/src/services/pr-template.ts`
- Test: `tests/test_sandbox-bridge/pr-template.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these imports to the existing import block from `pr-template.js` in `tests/test_sandbox-bridge/pr-template.test.ts` (it currently imports `RepoLocalPrTemplateProvider`, `resolvePrTemplate`, etc.):

```ts
import {
  CycloidJsonPrTemplateProvider,
  type CompactPrTemplateContent,
  type PrTemplateCandidate,
  renderPrBodyFromTemplate,
  RepoLocalPrTemplateProvider,
  resolvePrTemplate,
  resolvePrTemplateChain,
} from "../../apps/sandbox-bridge/src/services/pr-template.js";
```

Add a new `describe` block after the existing `resolvePrTemplate` block, before `renderPrBodyFromTemplate`. Reuses the `tempRepo()` and `writeRepoFile()` helpers defined at the top of the file:

```ts
describe("CycloidJsonPrTemplateProvider", () => {
  function writeCycloidConfig(repo: string, config: unknown): void {
    writeRepoFile(repo, ".cycloid.json", JSON.stringify(config));
  }

  it("resolves the template at pr.templatePath", async () => {
    const repo = tempRepo();
    writeCycloidConfig(repo, { pr: { templatePath: "docs/templates/pr.md" } });
    writeRepoFile(repo, "docs/templates/pr.md", "## Summary\n\n{{CYCLOID_SUMMARY}}\n");
    const resolved = await resolvePrTemplate(new CycloidJsonPrTemplateProvider(repo));
    expect(resolved).toEqual({
      status: "found",
      candidate: {
        path: "docs/templates/pr.md",
        source: "cycloid_config",
        content: "## Summary\n\n{{CYCLOID_SUMMARY}}\n",
      },
    });
  });

  it("returns none when there is no .cycloid.json", async () => {
    const resolved = await resolvePrTemplate(new CycloidJsonPrTemplateProvider(tempRepo()));
    expect(resolved).toEqual({ status: "none", reason: "no_template" });
  });

  it("returns none when .cycloid.json is invalid JSON", async () => {
    const repo = tempRepo();
    writeRepoFile(repo, ".cycloid.json", "{ not json");
    const resolved = await resolvePrTemplate(new CycloidJsonPrTemplateProvider(repo));
    expect(resolved.status).toBe("none");
  });

  it("returns none when pr.templatePath is absent", async () => {
    const repo = tempRepo();
    writeCycloidConfig(repo, { appRuntime: { kind: "web" } });
    const resolved = await resolvePrTemplate(new CycloidJsonPrTemplateProvider(repo));
    expect(resolved.status).toBe("none");
  });

  it("returns none when pr.templatePath is not a string", async () => {
    const repo = tempRepo();
    writeCycloidConfig(repo, { pr: { templatePath: 42 } });
    const resolved = await resolvePrTemplate(new CycloidJsonPrTemplateProvider(repo));
    expect(resolved.status).toBe("none");
  });

  it("refuses path traversal and non-markdown paths", async () => {
    const repo = tempRepo();
    writeRepoFile(repo, "secret.md", "## secret");
    writeCycloidConfig(repo, { pr: { templatePath: "../secret.md" } });
    expect((await resolvePrTemplate(new CycloidJsonPrTemplateProvider(repo))).status).toBe("none");

    writeCycloidConfig(repo, { pr: { templatePath: "/etc/passwd.md" } });
    expect((await resolvePrTemplate(new CycloidJsonPrTemplateProvider(repo))).status).toBe("none");

    writeRepoFile(repo, "pr.txt", "not markdown");
    writeCycloidConfig(repo, { pr: { templatePath: "pr.txt" } });
    expect((await resolvePrTemplate(new CycloidJsonPrTemplateProvider(repo))).status).toBe("none");
  });

  it("returns none when the configured template file does not exist", async () => {
    const repo = tempRepo();
    writeCycloidConfig(repo, { pr: { templatePath: "docs/missing.md" } });
    const resolved = await resolvePrTemplate(new CycloidJsonPrTemplateProvider(repo));
    expect(resolved.status).toBe("none");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/test_sandbox-bridge/pr-template.test.ts`
Expected: FAIL — `CycloidJsonPrTemplateProvider` / `resolvePrTemplateChain` are not exported (import error or "not a constructor").

- [ ] **Step 3: Implement the provider in `pr-template.ts`**

Change the `path` import (line 2) to also import `isAbsolute`:

```ts
import { isAbsolute, join } from "path";
```

Extend `PrTemplateSource` (line 4):

```ts
export type PrTemplateSource = "repo_local" | "org_default" | "cycloid_config";
```

Parametrize `readTemplateFile` (replace its signature/return so the source is caller-supplied, default unchanged):

```ts
function readTemplateFile(
  repoRoot: string,
  path: string,
  source: PrTemplateSource = "repo_local",
): PrTemplateCandidate | null {
  if (!isMarkdownPath(path)) return null;
  const fullPath = join(repoRoot, path);
  try {
    if (!existsSync(fullPath)) return null;
    const stats = lstatSync(fullPath);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_TEMPLATE_BYTES) return null;
    return { path, source, content: readFileSync(fullPath, "utf-8") };
  } catch {
    return null;
  }
}
```

Add the config path constant near the other path constants (after `GENERIC_TEMPLATE_DIRS`):

```ts
const CYCLOID_CONFIG_PATH = ".cycloid.json";

type CycloidJsonConfig = {
  pr?: { templatePath?: unknown };
};
```

Add the provider class immediately after `RepoLocalPrTemplateProvider` (after its closing brace, ~line 141):

```ts
/**
 * Tier 1 (ARC-1126): an explicit PR template pointed to by `pr.templatePath` in
 * the repo's `.cycloid.json`. Read from the local checkout at publish time, the
 * same way pre-publish tests read `.cycloid.json`. Fails soft to `[]` on any
 * problem (missing/invalid config, missing/unsafe/non-markdown path, missing
 * file) so the chain falls through to auto-discovery.
 */
export class CycloidJsonPrTemplateProvider implements PrTemplateProvider {
  constructor(private readonly repoRoot: string) {}

  async listCandidates(): Promise<PrTemplateCandidate[]> {
    const configPath = join(this.repoRoot, CYCLOID_CONFIG_PATH);
    let raw: string;
    try {
      if (!existsSync(configPath)) return [];
      raw = readFileSync(configPath, "utf-8");
    } catch {
      return [];
    }

    let config: CycloidJsonConfig;
    try {
      config = JSON.parse(raw) as CycloidJsonConfig;
    } catch {
      return [];
    }

    const templatePath = config.pr?.templatePath;
    if (typeof templatePath !== "string") return [];
    const trimmed = templatePath.trim();
    if (!trimmed || isAbsolute(trimmed)) return [];

    const candidate = readTemplateFile(this.repoRoot, trimmed, "cycloid_config");
    return candidate ? [candidate] : [];
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/test_sandbox-bridge/pr-template.test.ts -t "CycloidJsonPrTemplateProvider"`
Expected: PASS (7 tests). Whole file should still pass; `resolvePrTemplateChain` tests come in Task 2.

Note: `resolvePrTemplate` already maps a single-candidate list to `{ status: "found" }` (`candidates.length === 1`), and a configured path equal to a `.github/...` exact path resolves via the `byPath` branch — both work for this provider with no change to `resolvePrTemplate`.

- [ ] **Step 5: Commit**

```bash
git add apps/sandbox-bridge/src/services/pr-template.ts tests/test_sandbox-bridge/pr-template.test.ts
git commit -m "feat(arc-1126): add CycloidJsonPrTemplateProvider for pr.templatePath"
```

---

### Task 2: `resolvePrTemplateChain` precedence

**Files:**

- Modify: `apps/sandbox-bridge/src/services/pr-template.ts`
- Test: `tests/test_sandbox-bridge/pr-template.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block after the `CycloidJsonPrTemplateProvider` block:

```ts
describe("resolvePrTemplateChain", () => {
  function writeCycloidConfig(repo: string, config: unknown): void {
    writeRepoFile(repo, ".cycloid.json", JSON.stringify(config));
  }

  it("prefers the .cycloid.json template over the .github auto-discovered one", async () => {
    const repo = tempRepo();
    writeCycloidConfig(repo, { pr: { templatePath: "docs/custom-pr.md" } });
    writeRepoFile(repo, "docs/custom-pr.md", "## Custom\n");
    writeRepoFile(repo, ".github/pull_request_template.md", "## GitHub default\n");
    const resolved = await resolvePrTemplateChain([
      new CycloidJsonPrTemplateProvider(repo),
      new RepoLocalPrTemplateProvider(repo),
    ]);
    expect(resolved).toEqual({
      status: "found",
      candidate: { path: "docs/custom-pr.md", source: "cycloid_config", content: "## Custom\n" },
    });
  });

  it("falls through to .github auto-discovery when the .cycloid.json path is invalid", async () => {
    const repo = tempRepo();
    writeCycloidConfig(repo, { pr: { templatePath: "docs/missing.md" } });
    writeRepoFile(repo, ".github/pull_request_template.md", "## GitHub default\n");
    const resolved = await resolvePrTemplateChain([
      new CycloidJsonPrTemplateProvider(repo),
      new RepoLocalPrTemplateProvider(repo),
    ]);
    expect(resolved).toEqual({
      status: "found",
      candidate: { path: ".github/pull_request_template.md", source: "repo_local", content: "## GitHub default\n" },
    });
  });

  it("REGRESSION: a repo with only a .github template resolves exactly as today", async () => {
    const repo = tempRepo();
    writeRepoFile(repo, ".github/pull_request_template.md", "## GitHub default\n");
    const viaChain = await resolvePrTemplateChain([
      new CycloidJsonPrTemplateProvider(repo),
      new RepoLocalPrTemplateProvider(repo),
    ]);
    const viaLegacy = await resolvePrTemplate(new RepoLocalPrTemplateProvider(repo));
    expect(viaChain).toEqual(viaLegacy);
    expect(viaChain.status).toBe("found");
  });

  it("returns none when no provider resolves a template", async () => {
    const repo = tempRepo();
    const resolved = await resolvePrTemplateChain([
      new CycloidJsonPrTemplateProvider(repo),
      new RepoLocalPrTemplateProvider(repo),
    ]);
    expect(resolved.status).toBe("none");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/test_sandbox-bridge/pr-template.test.ts -t "resolvePrTemplateChain"`
Expected: FAIL — `resolvePrTemplateChain` is not exported.

- [ ] **Step 3: Implement `resolvePrTemplateChain` in `pr-template.ts`**

Add it directly after the existing `resolvePrTemplate` function (after its closing brace, ~line 160):

```ts
/**
 * Resolve a PR template by trying providers in precedence order and returning
 * the first that yields a template. ARC-1126 composes
 * [CycloidJson (tier 1), RepoLocal (tier 2)]; ARC-1124 will insert the
 * pr_structure memory provider (tier 3) before the built-in default, which is
 * the `status: "none"` fallthrough the caller handles.
 */
export async function resolvePrTemplateChain(providers: PrTemplateProvider[]): Promise<ResolvedPrTemplate> {
  let lastResolved: ResolvedPrTemplate = { status: "none", reason: "no_template" };
  for (const provider of providers) {
    const resolved = await resolvePrTemplate(provider);
    if (resolved.status === "found") return resolved;
    lastResolved = resolved;
  }
  return lastResolved;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/test_sandbox-bridge/pr-template.test.ts`
Expected: PASS — all existing tests plus the new `CycloidJsonPrTemplateProvider` and `resolvePrTemplateChain` blocks.

- [ ] **Step 5: Commit**

```bash
git add apps/sandbox-bridge/src/services/pr-template.ts tests/test_sandbox-bridge/pr-template.test.ts
git commit -m "feat(arc-1126): add resolvePrTemplateChain precedence resolver"
```

---

### Task 3: Wire the chain into the publish path

**Files:**

- Modify: `apps/sandbox-bridge/src/services/post-execution/post-execution-runner.ts` (import line 65; call site line 404)

- [ ] **Step 1: Update the import (line 65)**

Replace:

```ts
import { RepoLocalPrTemplateProvider, resolvePrTemplate } from "../pr-template.js";
```

with:

```ts
import { CycloidJsonPrTemplateProvider, RepoLocalPrTemplateProvider, resolvePrTemplateChain } from "../pr-template.js";
```

- [ ] **Step 2: Replace the call site (line 404)**

Replace:

```ts
const prTemplate = await resolvePrTemplate(new RepoLocalPrTemplateProvider(this.ctx.cwd));
```

with:

```ts
const prTemplate = await resolvePrTemplateChain([
  // Tier 1 (ARC-1126): explicit `.cycloid.json` `pr.templatePath`.
  new CycloidJsonPrTemplateProvider(this.ctx.cwd),
  // Tier 2: auto-discovered repo template (.github/pull_request_template.md, …).
  new RepoLocalPrTemplateProvider(this.ctx.cwd),
  // ARC-1124 insertion point: the tier-3 `pr_structure` MemoryPrTemplateProvider
  // plugs in HERE, between auto-discovery and the built-in default (the
  // `status: "none"` fallthrough handled below). Do NOT add it in ARC-1126.
]);
```

The `promptLog.info({ event: "pr_template.resolved", ... })` block immediately below is unchanged — it already logs `prTemplate.candidate.source`, which now reports `"cycloid_config"` for tier-1 hits.

- [ ] **Step 3: Typecheck the bridge**

Run: `npx tsc -p apps/sandbox-bridge/tsconfig.json --noEmit`
Expected: no errors. (If the bridge has no standalone tsconfig, run `npm run typecheck` or the configured bridge typecheck; confirm zero new errors.)

- [ ] **Step 4: Run the full bridge test suite for regressions**

Run: `npx vitest run tests/test_sandbox-bridge/pr-template.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add apps/sandbox-bridge/src/services/post-execution/post-execution-runner.ts
git commit -m "feat(arc-1126): resolve PR template via cycloid.json -> repo-local chain"
```

---

### Task 4: Render-from-`.cycloid.json`-path parity test

Proves an `.cycloid.json`-sourced candidate renders identically to an auto-discovered one (spec: "renders exactly like an auto-discovered one"), exercising the real resolve→render path.

**Files:**

- Test: `tests/test_sandbox-bridge/pr-template.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the existing `renderPrBodyFromTemplate` describe block (it already imports `renderPrBodyFromTemplate` and `compactContent`):

```ts
it("renders an .cycloid.json-pointed template identically to an auto-discovered one", async () => {
  const template = ["## Summary", "", "{{CYCLOID_SUMMARY}}", "", "## Testing", "", "{{CYCLOID_VERIFICATION}}", ""].join(
    "\n",
  );

  const cycloidRepo = tempRepo();
  writeRepoFile(cycloidRepo, ".cycloid.json", JSON.stringify({ pr: { templatePath: "docs/pr.md" } }));
  writeRepoFile(cycloidRepo, "docs/pr.md", template);

  const githubRepo = tempRepo();
  writeRepoFile(githubRepo, ".github/pull_request_template.md", template);

  const fromCycloid = await resolvePrTemplateChain([
    new CycloidJsonPrTemplateProvider(cycloidRepo),
    new RepoLocalPrTemplateProvider(cycloidRepo),
  ]);
  const fromGithub = await resolvePrTemplate(new RepoLocalPrTemplateProvider(githubRepo));
  expect(fromCycloid.status).toBe("found");
  expect(fromGithub.status).toBe("found");
  if (fromCycloid.status !== "found" || fromGithub.status !== "found") return;

  const content = compactContent();
  const renderedCycloid = renderPrBodyFromTemplate({ template: fromCycloid.candidate, content });
  const renderedGithub = renderPrBodyFromTemplate({ template: fromGithub.candidate, content });

  expect(renderedCycloid).toBe(renderedGithub);
  expect(renderedCycloid).toContain("<!-- cycloid:managed:start summary -->");
  expect(renderedCycloid).toContain("<!-- cycloid:managed:start verification -->");
});
```

- [ ] **Step 2: Run the test to verify it fails first, then passes**

Run: `npx vitest run tests/test_sandbox-bridge/pr-template.test.ts -t "renders an .cycloid.json-pointed template identically"`
Expected: With Tasks 1–2 implemented, PASS immediately (asserts existing behavior). If FAIL, rendering is source-sensitive somewhere — stop and investigate (it must not be).

- [ ] **Step 3: Commit**

```bash
git add tests/test_sandbox-bridge/pr-template.test.ts
git commit -m "test(arc-1126): assert cycloid.json template renders like auto-discovered"
```

---

### Task 5: Document `pr.templatePath`

**Files:**

- Modify: `docs/customer-repo-config.md`

- [ ] **Step 1: Add a `pr.templatePath` section**

In `docs/customer-repo-config.md`, update the `.cycloid.json` table row purpose to mention PR templates, then add a short section after the existing `.cycloid.json` content (token-efficient per CLAUDE.md):

````markdown
### `.cycloid.json` → `pr.templatePath`

Point Cycloid at an explicit PR template instead of relying on `.github/pull_request_template.md` auto-discovery.

- **Field:** `pr.templatePath` — a repo-relative path to a markdown (`.md`) file.
- **Precedence:** `pr.templatePath` wins over auto-discovered `.github` templates, which win over Cycloid's built-in default body.
- **Fail-soft:** a missing, non-markdown, absolute, traversing (`..`), or nonexistent path is ignored and Cycloid falls back to auto-discovery, then the default body.

```json
{
  "pr": { "templatePath": ".github/PULL_REQUEST_TEMPLATE/cycloid.md" }
}
```
````

Cycloid fills the template's sections (summary, testing/verification, screenshots, …) from the current session on every publish — the structure is yours, the content stays current.

````

- [ ] **Step 2: Verify links/format**

Run: `npx markdownlint docs/customer-repo-config.md` if configured; otherwise visually confirm the table row and new section render. No broken relative links introduced.

- [ ] **Step 3: Commit**

```bash
git add docs/customer-repo-config.md
git commit -m "docs(arc-1126): document .cycloid.json pr.templatePath"
````

---

## Final verification

- [ ] Full target test file green: `npx vitest run tests/test_sandbox-bridge/pr-template.test.ts`
- [ ] Bridge typecheck clean (Task 3 Step 3).
- [ ] Confirm working branch is correct after any `git checkout -b` — a tracked `.tmp-egress-log-test/cycloid-egress.log` can be rewritten by a local test and silently abort branch creation/rebase. Run `git branch --show-current` and `git status` before pushing.
- [ ] QA verification: `verify-pr-on-qa` skill (get your own QA CLI token). Target check: a repo with `.cycloid.json` `pr.templatePath` publishes a PR body using that template's structure with current session content; a repo with only `.github/pull_request_template.md` and no `pr.templatePath` is byte-for-byte unchanged from today; ARC-1014 dedup marker present on both.

## Self-review notes (coverage map)

- Spec tier 1 (`.cycloid.json`) → Tasks 1–3. Tier 2 unchanged (regression test, Task 2). Tier 4 default = `status:"none"` fallthrough (unchanged). Tier 3 memory = insertion-point comment only (ARC-1124).
- Invariant "renders exactly like auto-discovered" → Task 4 parity test.
- Invariant "ARC-1014 dedup marker preserved" → marker appended downstream, source-agnostic; covered by existing `pr.ts` dedup tests + QA check. No new code touches it.
- Required tests from spec: `.cycloid.json` parsing (Task 1), precedence incl. fall-through (Task 2), render-from-path (Task 4). Memory/capture tests out of scope (ARC-1124).
- Out-of-scope confirmed untouched: `memory/service.ts`, `memory-dynamic-tool.ts`, `publish-service.ts` override branch, `update_pr` — none referenced by any task.
