---
name: audit-prod-docs
description: Audit the public prod docs (docs.trycycloid.com, a tabbed Google Doc) against the current repo. Extracts every tab, verifies each claim against the code, and reports what is outdated (to fix) and what can be improved. Read-only on the Doc; produces a findings report a human applies.
user_invocable: true
argument: optional -- an alternate docs URL to audit (defaults to https://docs.trycycloid.com/)
---

# Audit prod docs

The prod docs at **https://docs.trycycloid.com/** are a static HTML shell that embeds a public
Google Doc (via `/preview`). The Doc uses Google Docs' **tabs** feature - as of this writing 8 tabs:
What is Cycloid, Getting Started, Start a task, Lifecycle & Reviews, Command Line Interface,
Integrations, FAQ, Getting Good Results.

This skill audits **every tab**: it extracts each tab's text, cross-references every factual claim
against the current repo, and reports two things per tab:

- **Outdated** - a claim that no longer matches the code/product and should be fixed (with the correct value + evidence).
- **Improvement** - accurate but weak: missing steps, unclear wording, a capability the code has that the docs omit, a broken/placeholder link.

**The docs live in an external Google Doc, not the repo - this skill cannot Edit them.** The output is
a findings report a human applies to the Doc. Do not attempt to modify repo files to "fix" the docs.

## Step 1: Extract every tab

The Doc renders body text to a canvas, so scraping the page yields only titles. The bundled script
enumerates tabs via a headless browser, then pulls each tab's clean plain text from Google's public
export endpoint. Run from the repo root so `playwright` resolves:

```bash
OUT=$(mktemp -d)/prod-docs-tabs
node .claude/skills/audit-prod-docs/scripts/extract-doc-tabs.mjs --out "$OUT"
```

- If it fails with a chromium/executable error, run `npx playwright install chromium` once, then re-run.
- To audit a different URL, pass `--url "$ARGUMENTS"`.
- Output: `$OUT/manifest.json` (tab name, `t.<id>`, deep-link, text file) + one `NN-<slug>.txt` per tab.

Read `manifest.json` and confirm every tab exported with a non-trivial `chars` count. If a tab is
near-empty, the export failed for that tab - note it and continue; do not audit a blank tab as if it were empty content.

## Step 2: Launch one audit agent per tab

Read `CLAUDE.md` and `docs/codebase-map.md` first so agents don't flag intentional patterns.

Launch **parallel Explore agents, one per tab** (8 tabs -> 8 agents). Give each agent the tab's text
file and its topic-to-code mapping. Each agent must:

1. **Read the tab text** in full.
2. **Cross-reference every checkable claim** against the codebase - verify, don't guess:
   - URLs, product surface names, menu paths (`Settings -> ...`), button labels, CLI commands/flags, env var names.
   - Supported providers, integrations, entrypoints (Slack/Linear/Jira/CLI/API), and any counts or lists.
   - Described behavior (PR attribution, review loop, merge policy, QA) vs the actual FSM / bridge / control-plane code.
   - Setup/onboarding steps vs the real flow (routes, `docs/session-creation-entrypoints.md`, `docs/onboarding-checklist.md`, `docs/cli.md`).
   - Links: do they resolve? Any placeholder/`TODO`/example URLs shipped as real?
3. **Return findings** as a list. Each finding: `tab`, `type` (Outdated | Improvement), the exact doc
   phrase, what reality is (with evidence: file path, grep result, route, config), and a suggested rewrite.

Suggested tab-to-code map (adapt to what the extract shows):

| Tab                    | Primary code/docs to verify against                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| What is Cycloid        | `docs/what-is-cycloid.md`, entrypoints, FSM merge/attribution policy                                                           |
| Getting Started        | onboarding + GitHub App install, `Settings -> Model API keys` providers, `docs/onboarding-checklist.md`, `docs/user-access.md` |
| Start a task           | session-creation surfaces, `docs/session-creation-entrypoints.md`, `docs/api.md`                                               |
| Lifecycle & Reviews    | `apps/control-plane-worker/src/session/fsm/`, `docs/fsm.md`, `docs/review-loop.md`, `docs/lifecycle.md`                        |
| Command Line Interface | `docs/cli.md`, CLI package, actual commands/flags                                                                              |
| Integrations           | `docs/slack.md`, `docs/jira.md`, `docs/adding-integrations.md`, feature gating                                                 |
| FAQ                    | menu paths + error strings across the above                                                                                    |
| Getting Good Results   | prompt/agent behavior, `docs/prompt-agents.md`, verification claims                                                            |

## Step 3: Aggregate

Wait for all agents, then merge:

1. **Dedupe** claims found in multiple tabs (e.g. a wrong menu path repeated in Getting Started and FAQ).
2. **Split into two buckets:** Outdated (must-fix) and Improvement.
3. **Drop non-issues:** intentional simplification for an end-user audience, approximate figures ("about 10 minutes"), stylistic preference. End-user docs are allowed to be less precise than internal docs - only flag things that are wrong or that send a user down a broken path.
4. **Rank Outdated by user impact** (blocks onboarding > cosmetic).

## Step 4: Present the report

Output a per-tab report, Outdated first. For each finding include the tab **deep-link** from the
manifest so the author can jump straight to it:

```
## <Tab name>  (<deep-link>)
### Outdated (fix)
- "<exact doc phrase>" -> <correct value>. Evidence: <path:line / grep / route>.
### Improvements
- <suggestion>. Why: <reason>.
```

End with a short summary: N outdated, M improvements, and the 3 highest-impact fixes.

Because the source is a Google Doc, **stop at the report** - the human edits the Doc. Only if the user
explicitly asks to apply changes, use the Google Drive MCP (`drive-cli` / `mcp__claude_ai_Google_Drive`)
and confirm each edit; never bulk-rewrite tabs unattended.

## Rules

- **Read-only on the Doc and the repo.** This is an audit - do not edit repo files or code.
- **Verify before claiming.** Every Outdated finding needs concrete evidence (path, line, grep, route, config). No "might be stale".
- **Audience-aware.** These are customer-facing docs. Judge against what a user needs, not internal precision. Don't flag friendly shorthand as an error.
- **Every tab, every run.** Audit all tabs the extract produced; if the tab set changed vs the map above, adapt - don't skip new tabs.
- **Deep-link every finding** so the author can act fast.
