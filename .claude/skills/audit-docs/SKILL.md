---
name: audit-docs
description: Use when asked to audit project documentation against the codebase for inaccurate paths, feature descriptions, counts, links, or stale references, then fix the confirmed findings.
user_invocable: true
argument: optional -- path to a specific doc file to audit, or omit to audit all docs
---

# Audit docs

Cross-reference project documentation against the codebase. Find and fix factual inaccuracies: wrong file paths, non-existent features documented as existing, incorrect counts, broken links, stale references, descriptions that no longer match reality.

## Step 1: Determine scope

Check the argument: `$ARGUMENTS`

- If a **specific file path** is provided: audit only that file.
- Otherwise: glob `docs/**/*.md` and read `CLAUDE.md`. Exclude `node_modules/`.

## Step 2: Launch parallel audit agents

Group doc files into logical clusters (topic or proximity) and launch **parallel Explore agents**. Each agent:

1. **Reads the doc file thoroughly.**
2. **Cross-references every factual claim** against the codebase:
   - File paths and directory structures -- accurate?
   - Feature descriptions -- match what the code does?
   - File/test counts -- still correct?
   - Links to other docs or files -- do they resolve?
   - CLI commands or scripts -- exist in package.json or the filesystem?
   - Architecture descriptions -- match current data flow?
   - External tools, libraries, patterns -- still used?
3. **Reports specific inaccuracies**: doc file and line number, what the doc claims, what reality is (with evidence: actual paths, grep results), suggested fix.

### Suggested agent groupings (for full audit)

Adapt to actual doc count. Aim for 5-10 agents, each reviewing 1-3 related docs:

- **Core reference**: `CLAUDE.md`, `docs/codebase-map.md`
- **Architecture**: `docs/what-is-cycloid.md`, `docs/sandbox-architecture.md`
- **Database**: `docs/database.md`, `docs/conventions.md`
- **Testing**: `docs/testing.md`
- **Operations**: `docs/deployments.md`, `docs/infrastructure.md`, `docs/production.md`
- **Security**: `docs/security.md`
- **Debugging**: `docs/debugging-runbook.md`, `docs/debugging.md`
- **Workflows**: `docs/workflow.md`, `docs/mcp.md`
- **Onboarding**: `docs/eng-onboarding.md`, `docs/onboarding-checklist.md`, `docs/user-access.md`

## Step 3: Aggregate findings

Wait for all agents, then merge findings:

1. **Deduplicate**: group the same issue found by multiple agents (e.g., a wrong path in both CLAUDE.md and codebase-map.md).
2. **Classify by type**:
   - **Factual error**: file path or feature doesn't exist, wrong file name
   - **Stale count**: test/file counts outdated
   - **Broken link**: target doc or file doesn't exist
   - **Misleading description**: doesn't match what the code does
   - **Aspirational content**: documents unimplemented features as existing
3. **Skip non-issues**: intentional shorthand (e.g., omitting `apps/` prefix when context is clear), approximate counts marked `~`, stylistic preferences.

## Step 4: Present findings for review

Before editing, present a summary table:

| #   | File | Type | What it says | What it should say |
| --- | ---- | ---- | ------------ | ------------------ |

Ask the user to confirm before editing; they may skip findings or adjust wording.

**Exception**: if the user said "just fix them" or "don't ask", skip confirmation and go to Step 5.

## Step 5: Apply fixes

Fix each approved finding with targeted Edit-tool replacements.

Principles:

- **Match existing style.** Minimal, targeted edits; don't rewrite paragraphs.
- **Prefer accuracy over aspiration.** Remove references to non-existent features or mark them TODO; never describe them as existing.
- **Update counts conservatively.** Use `~` prefix for counts that may drift.
- **Fix broken links** by updating the path or removing the dead link.
- **Don't add new content.** This skill fixes inaccuracies, not expands docs. Note undocumented features in the summary; don't write docs for them.

## Step 6: Commit and summarize

1. Stage only the modified doc files by name (never `git add -A`).
2. Commit through Graphite with `gt modify -m "Fix outdated documentation across N files" -m "<why + what changed>" --no-interactive`.
3. Present a final summary of changes, organized by file.

## Rules

- **Do not modify code.** Docs only. If a doc accurately describes a code problem (e.g., CORS is too permissive), fix the doc to reflect reality -- not the code.
- **Be specific.** Every finding needs concrete paths, line numbers, evidence. No vague "might be outdated".
- **Verify before claiming.** Use Glob, Grep, Read to confirm a file exists or not. Don't assume from memory.
- **Respect CLAUDE.md principles.** Read CLAUDE.md before auditing; don't flag intentional patterns.
- **Don't over-edit.** Leave slightly imprecise but non-misleading descriptions alone. Focus on errors that send someone to the wrong place or a non-existent feature.
