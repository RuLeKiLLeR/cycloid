# Daily Dev Changelog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A weekday GitHub Action that collects yesterday's merged PRs, has Claude write a plain-language TLDR digest, and posts it to the `#changelog` Slack channel.

**Architecture:** `.github/workflows/daily-changelog.yml` (cron 10:00 UTC Mon–Fri) runs `scripts/daily-changelog/index.mjs`, which pipelines: `gh pr list` collect → deterministic filter/clean → one `claude-opus-4-8` structured-output call → Slack Block Kit render with a PR-number hallucination guard → webhook post. Spec: `docs/superpowers/specs/2026-06-11-daily-changelog-design.md`.

**Tech Stack:** Node 22 ESM (`.mjs`, repo is `"type": "module"`), `@anthropic-ai/sdk` (new root devDependency), `gh` CLI via `execFileSync`, native `fetch` for Slack, Vitest (tests in `tests/test_shared/`, matching the existing `sync-codex-config.test.mjs` pattern).

**Repo facts:**

- Branch: work on `jagrit/daily-changelog-spec` (already checked out; carries the spec).
- Pre-commit hook runs prettier + full typecheck automatically; just `git commit`.
- Run focused tests with `npx vitest run <path>` from the repo root.
- Tests must not hit live services (vitest network guard is active) — only pure functions get unit tests; I/O glue is verified by dry-run.
- Secrets already exist on the repo: `ANTHROPIC_API_KEY`, `CHANGELOG_SLACK_WEBHOOK_URL`, plus built-in `GITHUB_TOKEN` and the existing failure-notify `SLACK_WEBHOOK_URL`.
- Boilerplate markers below were measured on the 40 most recent merged PRs (2026-06-11): Cursor Bugbot wrapper on 75%, Claude Code footer on 65%, CodeRabbit block on 15%, Cycloid provenance on 5%, Detail doc-drift footer on 10%. (The spec's "Codesmith" guess did not appear in the sample; the measured markers supersede it.)

---

### Task 1: Add `@anthropic-ai/sdk` dependency

**Files:**

- Modify: `package.json` (root), `package-lock.json`

- [ ] **Step 1: Install**

Run: `npm install --save-dev @anthropic-ai/sdk`
Expected: exit 0; `@anthropic-ai/sdk` appears in root `package.json` devDependencies.

- [ ] **Step 2: Sanity-import**

Run: `node -e "import('@anthropic-ai/sdk').then(m => console.log(typeof m.default))"`
Expected: prints `function`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "Add @anthropic-ai/sdk for the daily changelog script"
```

---

### Task 2: Window computation (`computeWindowStart`)

**Files:**

- Create: `scripts/daily-changelog/collect.mjs`
- Test: `tests/test_shared/daily-changelog-window.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, expect, it } from "vitest";
import { computeWindowStart } from "../../scripts/daily-changelog/collect.mjs";

describe("computeWindowStart", () => {
  it("uses a 24h window on a weekday (Thursday)", () => {
    const now = new Date("2026-06-11T10:00:00Z"); // Thursday
    expect(computeWindowStart(now).toISOString()).toBe("2026-06-10T10:00:00.000Z");
  });

  it("uses a 72h window on Monday to cover the weekend", () => {
    const now = new Date("2026-06-08T10:00:00Z"); // Monday
    expect(computeWindowStart(now).toISOString()).toBe("2026-06-05T10:00:00.000Z");
  });

  it("uses 24h on Friday (the Friday run covers Thursday)", () => {
    const now = new Date("2026-06-12T10:00:00Z"); // Friday
    expect(computeWindowStart(now).toISOString()).toBe("2026-06-11T10:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/test_shared/daily-changelog-window.test.mjs`
Expected: FAIL — cannot resolve `scripts/daily-changelog/collect.mjs`.

- [ ] **Step 3: Implement**

Create `scripts/daily-changelog/collect.mjs`:

```javascript
import { execFileSync } from "node:child_process";

export const REPO = "trycycloid/cycloid";
const HOUR_MS = 60 * 60 * 1000;
const MONDAY = 1;

// Weekday runs cover the previous 24h; Monday's run covers Fri 10:00 UTC -> Mon 10:00 UTC.
export function computeWindowStart(now) {
  const hours = now.getUTCDay() === MONDAY ? 72 : 24;
  return new Date(now.getTime() - hours * HOUR_MS);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/test_shared/daily-changelog-window.test.mjs`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/daily-changelog/collect.mjs tests/test_shared/daily-changelog-window.test.mjs
git commit -m "Daily changelog: merge-window computation"
```

---

### Task 3: Body cleaning (`cleanBody`)

**Files:**

- Create: `scripts/daily-changelog/filter.mjs`
- Test: `tests/test_shared/daily-changelog-filter.test.mjs`

- [ ] **Step 1: Write the failing tests**

```javascript
import { describe, expect, it } from "vitest";
import { cleanBody } from "../../scripts/daily-changelog/filter.mjs";

describe("cleanBody", () => {
  it("strips a Cursor Bugbot summary block", () => {
    const body = [
      "## Summary",
      "Real content.",
      "",
      "<!-- CURSOR_SUMMARY -->",
      "---",
      "> [!NOTE]",
      "> **Medium Risk** blah",
      "<!-- /CURSOR_SUMMARY -->",
    ].join("\n");
    expect(cleanBody(body)).toBe("## Summary\nReal content.");
  });

  it("strips a CodeRabbit release-notes block", () => {
    const body = [
      "Real content.",
      "",
      "<!-- This is an auto-generated comment: release notes by coderabbit.ai -->",
      "## Summary by CodeRabbit",
      "* **Bug Fixes**",
      "<!-- end of auto-generated comment: release notes by coderabbit.ai -->",
    ].join("\n");
    expect(cleanBody(body)).toBe("Real content.");
  });

  it("drops an unterminated block from the start marker to the end of body", () => {
    const body = "Real content.\n\n<!-- CURSOR_SUMMARY -->\nnever closed";
    expect(cleanBody(body)).toBe("Real content.");
  });

  it("strips single-line provenance footers", () => {
    const body = [
      "Real content.",
      "",
      "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
      "<!-- cycloid:verification:rendered -->",
      "📋 [Session transcript](https://app.trycycloid.com/sessions/abc)",
      "<!-- cycloid-dedup: abc:p-1 -->",
      "Co-authored-by: Cycloid <268249142+cycloid[bot]@users.noreply.github.com>",
      "<sub>_Doc Drift PRs can be [configured here](https://app.detail.dev/x)._</sub>",
    ].join("\n");
    expect(cleanBody(body)).toBe("Real content.");
  });

  it("collapses 3+ consecutive blank lines and trims", () => {
    expect(cleanBody("a\n\n\n\nb\n\n")).toBe("a\n\nb");
  });

  it("returns empty string for null/undefined body", () => {
    expect(cleanBody(null)).toBe("");
    expect(cleanBody(undefined)).toBe("");
  });

  it("truncates bodies longer than 4000 chars with a marker", () => {
    const result = cleanBody("x".repeat(5000));
    expect(result.length).toBeLessThanOrEqual(4000 + "\n[truncated]".length);
    expect(result.endsWith("[truncated]")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/test_shared/daily-changelog-filter.test.mjs`
Expected: FAIL — cannot resolve `filter.mjs`.

- [ ] **Step 3: Implement**

Create `scripts/daily-changelog/filter.mjs`:

```javascript
// Markers measured on the 40 most recent merged PRs (2026-06-11). Bot-generated
// blocks and provenance footers are noise for the digest model.
const BLOCK_MARKERS = [
  { start: "<!-- CURSOR_SUMMARY -->", end: "<!-- /CURSOR_SUMMARY -->" },
  {
    start: "<!-- This is an auto-generated comment: release notes by coderabbit.ai -->",
    end: "<!-- end of auto-generated comment: release notes by coderabbit.ai -->",
  },
];

const LINE_MARKERS = [
  /^🤖 Generated with \[Claude Code\]/,
  /^<!-- cycloid:verification:rendered -->/,
  /^<!-- cycloid-dedup: /,
  /^📋 \[Session transcript\]/,
  /^Co-authored-by: Cycloid </,
  /^<sub>_Doc Drift PRs can be \[configured here\]/,
];

const MAX_BODY_CHARS = 4000;

export function cleanBody(body) {
  let text = body ?? "";
  for (const { start, end } of BLOCK_MARKERS) {
    let from = text.indexOf(start);
    while (from !== -1) {
      const to = text.indexOf(end, from);
      text = to === -1 ? text.slice(0, from) : text.slice(0, from) + text.slice(to + end.length);
      from = text.indexOf(start);
    }
  }
  text = text
    .split("\n")
    .filter((line) => !LINE_MARKERS.some((re) => re.test(line.trim())))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}\n[truncated]` : text;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/test_shared/daily-changelog-filter.test.mjs`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/daily-changelog/filter.mjs tests/test_shared/daily-changelog-filter.test.mjs
git commit -m "Daily changelog: PR-body boilerplate stripping"
```

---

### Task 4: PR splitting (`splitPrs`)

**Files:**

- Modify: `scripts/daily-changelog/filter.mjs`
- Test: `tests/test_shared/daily-changelog-filter.test.mjs` (append)

- [ ] **Step 1: Append failing tests**

```javascript
import { cleanBody, splitPrs } from "../../scripts/daily-changelog/filter.mjs"; // update existing import

describe("splitPrs", () => {
  const pr = (overrides) => ({
    number: 1,
    title: "t",
    body: "b",
    author: { login: "jag-arcanist", is_bot: false },
    files: [{ path: "apps/control-plane-worker/src/router.ts" }],
    ...overrides,
  });

  it("keeps a normal code PR as substantive", () => {
    const { substantive, filteredOut } = splitPrs([pr({})]);
    expect(substantive).toHaveLength(1);
    expect(filteredOut).toHaveLength(0);
  });

  it("filters out bot-authored PRs", () => {
    const { substantive, filteredOut } = splitPrs([pr({ author: { login: "app/detail-app", is_bot: true } })]);
    expect(substantive).toHaveLength(0);
    expect(filteredOut).toHaveLength(1);
  });

  it("filters out docs-only PRs (docs/ paths and .md files)", () => {
    const { substantive, filteredOut } = splitPrs([
      pr({ files: [{ path: "docs/testing.md" }, { path: "README.md" }] }),
    ]);
    expect(substantive).toHaveLength(0);
    expect(filteredOut).toHaveLength(1);
  });

  it("keeps PRs that mix docs and code", () => {
    const { substantive } = splitPrs([
      pr({ files: [{ path: "docs/testing.md" }, { path: "shared/llm/structured-output.ts" }] }),
    ]);
    expect(substantive).toHaveLength(1);
  });

  it("keeps PRs with an empty files list (not provably docs-only)", () => {
    const { substantive } = splitPrs([pr({ files: [] })]);
    expect(substantive).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run tests/test_shared/daily-changelog-filter.test.mjs`
Expected: cleanBody tests pass; splitPrs tests FAIL (`splitPrs` not exported).

- [ ] **Step 3: Implement** (append to `scripts/daily-changelog/filter.mjs`)

```javascript
function isDocsOnly(files) {
  return files.length > 0 && files.every((f) => f.path.startsWith("docs/") || f.path.endsWith(".md"));
}

// Bots (app/detail-app, app/cycloid, future apps) report is_bot from gh.
// Cycloid-published PRs are authored as the requesting human and stay in.
export function splitPrs(prs) {
  const substantive = [];
  const filteredOut = [];
  for (const pr of prs) {
    if (pr.author?.is_bot || isDocsOnly(pr.files ?? [])) filteredOut.push(pr);
    else substantive.push(pr);
  }
  return { substantive, filteredOut };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/test_shared/daily-changelog-filter.test.mjs`
Expected: 12 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/daily-changelog/filter.mjs tests/test_shared/daily-changelog-filter.test.mjs
git commit -m "Daily changelog: bot/docs-only PR filtering"
```

---

### Task 5: Renderer with hallucination guard (`applyPrGuard`, `renderBlocks`)

**Files:**

- Create: `scripts/daily-changelog/render.mjs`
- Test: `tests/test_shared/daily-changelog-render.test.mjs`

- [ ] **Step 1: Write the failing tests**

```javascript
import { describe, expect, it } from "vitest";
import { applyPrGuard, renderBlocks } from "../../scripts/daily-changelog/render.mjs";

const digest = (overrides) => ({
  tldr: ["bullet one"],
  highlights: [],
  heads_up: [],
  also_merged: [],
  ...overrides,
});

describe("applyPrGuard", () => {
  it("drops items citing PR numbers outside the input set", () => {
    const out = applyPrGuard(
      digest({
        heads_up: [
          { text: "real", pr_numbers: [10] },
          { text: "fake", pr_numbers: [10, 999] },
        ],
      }),
      new Set([10]),
    );
    expect(out.heads_up).toEqual([{ text: "real", pr_numbers: [10] }]);
  });

  it("drops items with no PR numbers at all", () => {
    const out = applyPrGuard(digest({ also_merged: [{ text: "uncited", pr_numbers: [] }] }), new Set([10]));
    expect(out.also_merged).toEqual([]);
  });

  it("caps tldr at 5, highlights and heads_up at 3", () => {
    const h = (n) => ({ title: `t${n}`, body: "b", why_it_matters: "w", pr_numbers: [n] });
    const out = applyPrGuard(
      digest({
        tldr: ["1", "2", "3", "4", "5", "6"],
        highlights: [h(1), h(2), h(3), h(4)],
      }),
      new Set([1, 2, 3, 4]),
    );
    expect(out.tldr).toHaveLength(5);
    expect(out.highlights).toHaveLength(3);
  });
});

describe("renderBlocks", () => {
  it("renders header, PR-count context, and tldr bullets", () => {
    const { text, blocks } = renderBlocks(digest({}), { dateLabel: "Thu Jun 11", prCount: 18 });
    expect(blocks[0]).toEqual({
      type: "header",
      text: { type: "plain_text", text: "Cycloid daily — Thu Jun 11", emoji: true },
    });
    expect(blocks[1].elements[0].text).toBe("18 PRs merged");
    expect(blocks[2].text.text).toBe("• bullet one");
    expect(text).toContain("bullet one");
  });

  it("renders highlights with title, why-it-matters, and Slack PR links", () => {
    const { blocks } = renderBlocks(
      digest({
        highlights: [{ title: "Big change", body: "Now you can X.", why_it_matters: "Less toil.", pr_numbers: [42] }],
      }),
      { dateLabel: "d", prCount: 1 },
    );
    const section = blocks.find((b) => b.type === "section" && b.text.text.includes("Big change"));
    expect(section.text.text).toContain("<https://github.com/trycycloid/cycloid/pull/42|#42>");
    expect(section.text.text).toContain("_Why it matters: Less toil._");
  });

  it("omits heads_up and also_merged blocks when empty", () => {
    const { blocks } = renderBlocks(digest({}), { dateLabel: "d", prCount: 0 });
    expect(blocks.some((b) => JSON.stringify(b).includes("⚠️"))).toBe(false);
    expect(blocks).toHaveLength(3); // header + context + tldr only
  });

  it("truncates any single section to Slack's limit", () => {
    const { blocks } = renderBlocks(digest({ heads_up: [{ text: "y".repeat(5000), pr_numbers: [1] }] }), {
      dateLabel: "d",
      prCount: 1,
    });
    const headsUp = blocks.find((b) => b.type === "section" && b.text.text.includes("⚠️"));
    expect(headsUp.text.text.length).toBeLessThanOrEqual(2900);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/test_shared/daily-changelog-render.test.mjs`
Expected: FAIL — cannot resolve `render.mjs`.

- [ ] **Step 3: Implement**

Create `scripts/daily-changelog/render.mjs`:

```javascript
const PR_URL = "https://github.com/trycycloid/cycloid/pull";
const SECTION_LIMIT = 2900; // Slack section text caps at 3000 chars

function prLinks(numbers) {
  return numbers.map((n) => `<${PR_URL}/${n}|#${n}>`).join(" ");
}

function clip(text) {
  return text.length > SECTION_LIMIT ? `${text.slice(0, SECTION_LIMIT - 1)}…` : text;
}

// Hallucination guard: an item only survives if every PR number it cites was in
// the model's input. Uncited items are dropped too.
export function applyPrGuard(digest, validNumbers) {
  const cited = (item) => item.pr_numbers.length > 0 && item.pr_numbers.every((n) => validNumbers.has(n));
  return {
    tldr: digest.tldr.slice(0, 5),
    highlights: digest.highlights.filter(cited).slice(0, 3),
    heads_up: digest.heads_up.filter(cited).slice(0, 3),
    also_merged: digest.also_merged.filter(cited),
  };
}

export function renderBlocks(digest, { dateLabel, prCount }) {
  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: `Cycloid daily — ${dateLabel}`, emoji: true },
    },
    { type: "context", elements: [{ type: "mrkdwn", text: `${prCount} PRs merged` }] },
    {
      type: "section",
      text: { type: "mrkdwn", text: clip(digest.tldr.map((t) => `• ${t}`).join("\n")) },
    },
  ];
  for (const h of digest.highlights) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: clip(`⭐ *${h.title}*\n${h.body}\n_Why it matters: ${h.why_it_matters}_ ${prLinks(h.pr_numbers)}`),
      },
    });
  }
  if (digest.heads_up.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: clip(digest.heads_up.map((i) => `⚠️ ${i.text} ${prLinks(i.pr_numbers)}`).join("\n")),
      },
    });
  }
  if (digest.also_merged.length > 0) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: clip(
            `*Also merged:* ${digest.also_merged.map((i) => `${i.text} ${prLinks(i.pr_numbers)}`).join(" · ")}`,
          ),
        },
      ],
    });
  }
  return { text: digest.tldr.join(" / ") || "Cycloid daily changelog", blocks };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/test_shared/daily-changelog-render.test.mjs`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/daily-changelog/render.mjs tests/test_shared/daily-changelog-render.test.mjs
git commit -m "Daily changelog: Slack Block Kit renderer with PR-number guard"
```

---

### Task 6: `gh` collection (`collectMergedPrs`)

**Files:**

- Modify: `scripts/daily-changelog/collect.mjs`

No unit test — this is `gh` I/O (network-guarded vitest can't cover it); verified by the read-only probe below and the Task 11 dry-run.

- [ ] **Step 1: Implement** (append to `scripts/daily-changelog/collect.mjs`)

```javascript
export function collectMergedPrs(windowStart) {
  const since = windowStart.toISOString().replace(/\.\d{3}Z$/, "Z");
  const out = execFileSync(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      REPO,
      "--state",
      "merged",
      "--search",
      `merged:>=${since}`,
      "--limit",
      "200",
      "--json",
      "number,title,body,author,files",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(out);
}
```

- [ ] **Step 2: Read-only probe against real data**

Run:

```bash
node -e "
import('./scripts/daily-changelog/collect.mjs').then(({ computeWindowStart, collectMergedPrs }) => {
  const prs = collectMergedPrs(computeWindowStart(new Date()));
  console.log(prs.length, 'PRs;', 'first:', prs[0]?.number, prs[0]?.title);
  console.log('author shape:', JSON.stringify(prs[0]?.author));
  console.log('files shape:', JSON.stringify(prs[0]?.files?.[0]));
});
"
```

Expected: a plausible PR count (~15–40 on a weekday window), `author` containing `login` and `is_bot`, `files` entries containing `path`.

- [ ] **Step 3: Commit**

```bash
git add scripts/daily-changelog/collect.mjs
git commit -m "Daily changelog: merged-PR collection via gh"
```

---

### Task 7: Prompt file and glossary doc

**Files:**

- Create: `scripts/daily-changelog/prompt.md`
- Create: `docs/changelog-glossary.md`

- [ ] **Step 1: Create `scripts/daily-changelog/prompt.md`**

```markdown
You write Cycloid's internal daily changelog, posted to the #changelog Slack channel so every dev knows what changed in parts of the product they don't work on.

# Audience and tone

- Write for a smart high-schooler: short sentences, zero unexplained jargon.
- Internal names (control plane, bridge, review loop, ...) must be explained on first use, using the product glossary below. If a term is not in the glossary, explain it from PR context in plain words.
- Use "Before this, X. Now, Y." framing wherever it fits.
- Be honest about regressions, reverts, and partial fixes. No hype, no filler.

# Content rules

- tldr: 3-5 bullets, each 20 words or fewer. A dev reading only this learns everything important about the day.
- highlights: the 1-3 changes most worth understanding (user-visible behavior, new capabilities, risky internals). body: 80 words or fewer. why_it_matters: one sentence on how it affects other devs' work.
- heads_up: 0-3 items, ONLY for breaking changes, migrations that run on deploy, changed defaults, and cross-feature interactions ("X now changes how Y behaves"). Leave empty when there are none — never pad.
- also_merged: short one-liners covering everything else in the input; group similar items ("3 dependency bumps"). Every input PR must be accounted for somewhere across highlights, heads_up, or also_merged.
- Treat stacked PRs (titles prefixed "[i/N]") as one change: a single item listing all of their PR numbers.
- pr_numbers must only contain numbers that appear in the input. Never invent a PR number.
```

- [ ] **Step 2: Create `docs/changelog-glossary.md`**

```markdown
# Changelog Glossary

One-line plain-language definitions of internal names, fed to the daily-changelog generator (`scripts/daily-changelog/`) so its Slack posts stay jargon-free. Keep entries to one line; add an entry when a changelog post needs a term that isn't here.

- **Cycloid**: our product — a coding agent that runs in the background and opens PRs for you.
- **Control plane**: the central server (a Cloudflare Worker) handling auth, sessions, webhooks, and state — the brain of the product.
- **Session**: one run of the agent on one task, from prompt to (usually) a PR.
- **SessionDO / session Durable Object**: the per-session stateful object in the control plane that tracks live state and streams events to the UI.
- **Sandbox**: the isolated cloud VM (provider: E2B) where the agent actually runs.
- **Bridge / sandbox-bridge**: the program inside the sandbox that drives the coding agent (Codex or Claude Code) and reports progress back.
- **Publish flow**: how a session's code changes become a real GitHub PR, opened as the requesting user.
- **Review loop**: the feature where Cycloid automatically responds to review comments on PRs it opened.
- **Automation schedules**: the product feature that runs sessions on a recurring cron schedule.
- **Memory / memory PRs**: Cycloid's learning system — it proposes repo-convention updates as small PRs after sessions.
- **Company memory**: business-level remembered facts, refined by a background LLM job.
- **Platform LLM**: the control plane's own LLM calls (ranking memories, filling PR templates) — separate from the coding agent itself.
- **CLI**: the `cycloid` command-line tool for creating and driving sessions from a terminal.
- **QA environment**: the staging copy of everything at qa.trycycloid.com, used for testing before prod.
- **Doc-drift bot (Detail)**: a third-party bot that opens PRs fixing docs that drifted from the code.
- **Graphite stack ([i/N] PRs)**: a series of small dependent PRs that land in order; together they are one change.
- **D1**: Cloudflare's SQLite database where the control plane stores its data.
- **Warm pool**: pre-started sandboxes kept ready so sessions start faster.
```

- [ ] **Step 3: Commit**

```bash
git add scripts/daily-changelog/prompt.md docs/changelog-glossary.md
git commit -m "Daily changelog: system prompt and product glossary"
```

---

### Task 8: Claude summarization (`summarize`, `buildUserPrompt`)

**Files:**

- Create: `scripts/daily-changelog/summarize.mjs`
- Test: `tests/test_shared/daily-changelog-summarize.test.mjs`

- [ ] **Step 1: Write the failing tests** (pure prompt-builder only; the API call is I/O glue verified by dry-run)

```javascript
import { describe, expect, it } from "vitest";
import { buildUserPrompt, DIGEST_SCHEMA } from "../../scripts/daily-changelog/summarize.mjs";

const pr = { number: 7, title: "Fix thing", body: "## Summary\nDetails.", author: { login: "jag-arcanist" } };

describe("buildUserPrompt", () => {
  it("includes PR number, title, author, and cleaned body", () => {
    const prompt = buildUserPrompt([pr], { quietDay: false });
    expect(prompt).toContain("PR #7: Fix thing");
    expect(prompt).toContain("jag-arcanist");
    expect(prompt).toContain("Details.");
    expect(prompt).not.toContain("QUIET DAY");
  });

  it("adds the quiet-day instruction when quietDay is set", () => {
    expect(buildUserPrompt([pr], { quietDay: true })).toContain("QUIET DAY");
  });
});

describe("DIGEST_SCHEMA", () => {
  it("requires all four sections and forbids extra keys", () => {
    expect(DIGEST_SCHEMA.required).toEqual(["tldr", "highlights", "heads_up", "also_merged"]);
    expect(DIGEST_SCHEMA.additionalProperties).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/test_shared/daily-changelog-summarize.test.mjs`
Expected: FAIL — cannot resolve `summarize.mjs`.

- [ ] **Step 3: Implement**

Create `scripts/daily-changelog/summarize.mjs`:

```javascript
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { cleanBody } from "./filter.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// Structured-output schema. Note: structured outputs do not support
// minItems/maxItems — count caps are enforced by the prompt and applyPrGuard.
export const DIGEST_SCHEMA = {
  type: "object",
  properties: {
    tldr: { type: "array", items: { type: "string" } },
    highlights: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          why_it_matters: { type: "string" },
          pr_numbers: { type: "array", items: { type: "integer" } },
        },
        required: ["title", "body", "why_it_matters", "pr_numbers"],
        additionalProperties: false,
      },
    },
    heads_up: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          pr_numbers: { type: "array", items: { type: "integer" } },
        },
        required: ["text", "pr_numbers"],
        additionalProperties: false,
      },
    },
    also_merged: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          pr_numbers: { type: "array", items: { type: "integer" } },
        },
        required: ["text", "pr_numbers"],
        additionalProperties: false,
      },
    },
  },
  required: ["tldr", "highlights", "heads_up", "also_merged"],
  additionalProperties: false,
};

export function buildUserPrompt(prs, { quietDay }) {
  const quietNote = quietDay
    ? "\n\nQUIET DAY: nothing substantive merged in this window. Every PR below was filtered as minor (docs, bots, dependency bumps). Produce a single tldr bullet briefly saying it was a quiet day and what little happened, empty highlights and heads_up, and at most a couple of also_merged one-liners."
    : "";
  const prList = prs
    .map((pr) => `### PR #${pr.number}: ${pr.title}\nAuthor: ${pr.author?.login ?? "unknown"}\n\n${cleanBody(pr.body)}`)
    .join("\n\n---\n\n");
  return `Merged PRs for this window:${quietNote}\n\n${prList}`;
}

export async function summarize(prs, { quietDay = false } = {}) {
  const systemPrompt = readFileSync(join(here, "prompt.md"), "utf8");
  const glossary = readFileSync(join(here, "../../docs/changelog-glossary.md"), "utf8");
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: `${systemPrompt}\n\n# Product glossary\n\n${glossary}`,
    output_config: { format: { type: "json_schema", schema: DIGEST_SCHEMA } },
    messages: [{ role: "user", content: buildUserPrompt(prs, { quietDay }) }],
  });
  const text = response.content.find((block) => block.type === "text")?.text;
  if (!text) {
    throw new Error(`No text in Claude response (stop_reason=${response.stop_reason})`);
  }
  return JSON.parse(text);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/test_shared/daily-changelog-summarize.test.mjs`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/daily-changelog/summarize.mjs tests/test_shared/daily-changelog-summarize.test.mjs
git commit -m "Daily changelog: Claude structured-output summarization"
```

---

### Task 9: Orchestrator (`index.mjs`)

**Files:**

- Create: `scripts/daily-changelog/index.mjs`

No unit test — pure glue over already-tested functions; verified end-to-end in Task 11.

- [ ] **Step 1: Implement**

Create `scripts/daily-changelog/index.mjs`:

```javascript
#!/usr/bin/env node
// Daily dev changelog: collect merged PRs -> filter -> Claude digest -> Slack.
// Design: docs/superpowers/specs/2026-06-11-daily-changelog-design.md
// Usage: node scripts/daily-changelog/index.mjs [--dry-run]
//   --dry-run prints the Slack payload instead of posting.
// Env: GITHUB_TOKEN (gh), ANTHROPIC_API_KEY, CHANGELOG_SLACK_WEBHOOK_URL.
import { collectMergedPrs, computeWindowStart } from "./collect.mjs";
import { splitPrs } from "./filter.mjs";
import { applyPrGuard, renderBlocks } from "./render.mjs";
import { summarize } from "./summarize.mjs";

async function postToSlack(payload) {
  const url = process.env.CHANGELOG_SLACK_WEBHOOK_URL;
  if (!url) throw new Error("CHANGELOG_SLACK_WEBHOOK_URL is not set");
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) return;
    const detail = `${res.status} ${await res.text()}`;
    if (attempt === 1 && res.status >= 500) {
      console.error(`Slack post failed (${detail}); retrying once`);
      continue;
    }
    throw new Error(`Slack post failed: ${detail}`);
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const now = new Date();
  const windowStart = computeWindowStart(now);
  const prs = collectMergedPrs(windowStart);
  const { substantive, filteredOut } = splitPrs(prs);
  const quietDay = substantive.length === 0;
  const input = quietDay ? filteredOut : substantive;
  console.error(
    `Window since ${windowStart.toISOString()}: ${prs.length} merged, ` +
      `${substantive.length} substantive${quietDay ? " (quiet day)" : ""}`,
  );

  let digest;
  if (input.length === 0) {
    // Truly nothing merged at all — nothing to summarize.
    digest = {
      tldr: ["Quiet day — nothing merged in this window."],
      highlights: [],
      heads_up: [],
      also_merged: [],
    };
  } else {
    const raw = await summarize(input, { quietDay });
    digest = applyPrGuard(raw, new Set(input.map((pr) => pr.number)));
  }

  const dateLabel = now.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  });
  const payload = renderBlocks(digest, { dateLabel, prCount: prs.length });

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  await postToSlack(payload);
  console.error("Posted to Slack.");
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
git add scripts/daily-changelog/index.mjs
git commit -m "Daily changelog: orchestrator with --dry-run"
```

---

### Task 10: GitHub Actions workflow

**Files:**

- Create: `.github/workflows/daily-changelog.yml`

- [ ] **Step 1: Implement** (mirrors existing scheduled workflow conventions)

```yaml
name: Daily Changelog

# Posts a plain-language digest of merged PRs to #changelog every weekday.
# Design: docs/superpowers/specs/2026-06-11-daily-changelog-design.md
on:
  schedule:
    - cron: "0 10 * * 1-5" # 10:00 UTC weekdays = 6am EDT / 5am EST; Monday covers the weekend
  workflow_dispatch:
    inputs:
      dry_run:
        description: Print the rendered message instead of posting
        required: false
        default: "false"

permissions:
  contents: read
  pull-requests: read

jobs:
  changelog:
    name: Generate and post daily changelog
    runs-on: ubuntu-24.04-arm
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 22
      - name: Install dependencies
        run: npm ci
      - name: Generate and post
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          CHANGELOG_SLACK_WEBHOOK_URL: ${{ secrets.CHANGELOG_SLACK_WEBHOOK_URL }}
          DRY_RUN: ${{ inputs.dry_run == 'true' && '--dry-run' || '' }}
        run: node scripts/daily-changelog/index.mjs $DRY_RUN
      - name: Notify Slack on failure
        if: failure()
        continue-on-error: true
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          if [ -z "$SLACK_WEBHOOK_URL" ]; then exit 0; fi
          PAYLOAD=$(jq -n --arg text ":x: *Daily changelog failed* | <${RUN_URL}|View run>" '{text: $text}')
          curl -s -X POST "$SLACK_WEBHOOK_URL" -H 'Content-Type: application/json' -d "$PAYLOAD"
```

- [ ] **Step 2: Commit** (the pre-commit hook runs `scripts/typecheck-workflows.mjs`, validating the YAML)

```bash
git add .github/workflows/daily-changelog.yml
git commit -m "Daily changelog: weekday GitHub Actions workflow"
```

---

### Task 11: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Full new-test sweep**

Run: `npx vitest run tests/test_shared/daily-changelog-window.test.mjs tests/test_shared/daily-changelog-filter.test.mjs tests/test_shared/daily-changelog-render.test.mjs tests/test_shared/daily-changelog-summarize.test.mjs`
Expected: all pass (≈25 tests).

- [ ] **Step 2: Live dry-run against real data** (requires `ANTHROPIC_API_KEY` exported locally; makes one real Claude call ≈ $0.15, posts nothing)

Run: `node scripts/daily-changelog/index.mjs --dry-run`
Expected: stderr shows window + counts; stdout is a Slack payload JSON. Eyeball it against the spec: 3–5 tldr bullets, ≤3 highlights each with "Why it matters", every cited PR number real, plain-language tone.

If no local `ANTHROPIC_API_KEY` is available: skip here and instead run the merged workflow via `gh workflow run daily-changelog.yml -f dry_run=true` after merge, reading the payload from the Action logs, before trusting the cron.

- [ ] **Step 3: Paste the dry-run TLDR into the session/PR notes** as verification evidence.

---

### Task 12: Pull request

- [ ] **Step 1: Push and open the PR** (no `[i/N]` prefix — single-PR plan)

```bash
git push -u origin jagrit/daily-changelog-spec
gh pr create --repo trycycloid/cycloid --title "Daily dev changelog: weekday Claude digest of merged PRs to #changelog" --body "$(cat <<'EOF'
## Summary
Weekday GitHub Action (10:00 UTC) that collects the last day's merged PRs, filters bots/docs-only/boilerplate deterministically, has claude-opus-4-8 write a plain-language TLDR digest (structured output), and posts it to #changelog via webhook. Quiet days post via the same LLM call over the filtered-out merges. Renderer drops any item citing a PR number outside the input window (hallucination guard).

## Plan
docs/superpowers/plans/2026-06-11-daily-changelog.md (spec: docs/superpowers/specs/2026-06-11-daily-changelog-design.md)

## Verification
- Vitest: window computation, body-boilerplate stripping (markers measured on 40 recent merged PRs), bot/docs-only filtering, renderer + PR-number guard, prompt builder.
- `node scripts/daily-changelog/index.mjs --dry-run` against live gh data (payload reviewed; posts nothing).
- Post-merge: `gh workflow run daily-changelog.yml -f dry_run=true`, then one real dispatch into #changelog before trusting the cron.

## External sources
- Claude model/pricing/structured-output contract: https://platform.claude.com/docs/en/about-claude/models/overview.md and https://platform.claude.com/docs/en/build-with-claude/structured-outputs.md — verified `claude-opus-4-8` ($5/$25 per MTok), `output_config.format` json_schema (no minItems support), adaptive thinking.
- Slack Block Kit limits: https://docs.slack.dev/reference/block-kit/blocks — section text caps at 3000 chars (renderer clips at 2900).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Do NOT enable auto-merge.** The user merges manually.

- [ ] **Step 3 (post-merge, user-assisted):** `gh workflow run daily-changelog.yml -f dry_run=true`, inspect the Action log payload, then `gh workflow run daily-changelog.yml` for one real post to #changelog.
