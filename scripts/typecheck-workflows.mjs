#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseDocument, visit } from "yaml";

const WORKFLOW_DIR = path.join(process.cwd(), ".github", "workflows");
const WORKFLOW_SUFFIXES = new Set([".yml", ".yaml"]);
const FIRST_PARTY_ACTION_OWNERS = new Set(["actions", "github"]);
const FULL_LENGTH_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const THIRD_PARTY_ACTION_REFERENCE_PATTERN = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.\-/]+)?)@(\S+)$/;
const REQUIRED_CHECK_WORKFLOWS = [
  {
    path: ".github/workflows/typecheck.yml",
    context: "typecheck",
  },
  {
    path: ".github/workflows/ratchet-tests.yml",
    context: "ratchet-tests",
  },
  {
    path: ".github/workflows/secret-scan.yml",
    context: "gitleaks",
  },
];

if (!existsSync(WORKFLOW_DIR)) {
  process.exit(0);
}

let errorCount = 0;
for (const entry of readdirSync(WORKFLOW_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!entry.isFile()) continue;

  const extension = path.extname(entry.name).toLowerCase();
  if (!WORKFLOW_SUFFIXES.has(extension)) continue;

  const absoluteFile = path.join(WORKFLOW_DIR, entry.name);
  const relativeFile = path.relative(process.cwd(), absoluteFile).split(path.sep).join("/");
  const contents = readFileSync(absoluteFile, "utf8");
  const document = parseDocument(contents);

  for (const error of document.errors) {
    const location = extractErrorLocation(error, contents);
    process.stderr.write(
      `${relativeFile}(${location.line},${location.column}): error ARCYAML1000: Invalid GitHub Actions workflow YAML: ${collapseWhitespace(error.message)}\n`,
    );
    errorCount += 1;
  }

  checkRequiredWorkflow(relativeFile, document.toJSON());
  checkThirdPartyActionPins(relativeFile, document, contents);
}

if (errorCount > 0) {
  process.stderr.write(`Found ${errorCount} workflow YAML error${errorCount === 1 ? "" : "s"}.\n`);
  process.exit(1);
}

function extractErrorLocation(error, contents) {
  const linePosition = Array.isArray(error?.linePos) ? error.linePos[0] : undefined;
  if (linePosition && Number.isInteger(linePosition.line) && Number.isInteger(linePosition.col)) {
    return { line: linePosition.line, column: linePosition.col };
  }

  const rawOffset = Array.isArray(error?.pos) ? error.pos[0] : error?.pos;
  if (typeof rawOffset !== "number" || !Number.isInteger(rawOffset) || rawOffset <= 0) {
    return { line: 1, column: 1 };
  }

  const preceding = contents.slice(0, rawOffset);
  const lineBreaks = preceding.match(/\n/g)?.length ?? 0;
  const lastLineStart = preceding.lastIndexOf("\n");
  return {
    line: lineBreaks + 1,
    column: rawOffset - lastLineStart,
  };
}

function collapseWhitespace(message) {
  return String(message).replace(/\s+/g, " ").trim();
}

function checkRequiredWorkflow(relativeFile, workflow) {
  const requiredWorkflow = REQUIRED_CHECK_WORKFLOWS.find((candidate) => candidate.path === relativeFile);
  if (!requiredWorkflow) return;

  const pullRequest = workflow?.on?.pull_request;
  if (!pullRequest) {
    reportWorkflowError(relativeFile, `Required check workflow must run on pull_request.`);
  }

  if (!workflow?.jobs?.[requiredWorkflow.context]) {
    reportWorkflowError(relativeFile, `Required check workflow must define the ${requiredWorkflow.context} job.`);
  }

  if (pullRequest?.paths) {
    reportWorkflowError(relativeFile, `Required check workflow must not use pull_request.paths.`);
  }

  if (pullRequest?.["paths-ignore"]) {
    reportWorkflowError(relativeFile, `Required check workflow must not use pull_request.paths-ignore.`);
  }
}

function checkThirdPartyActionPins(relativeFile, document, contents) {
  visit(document, {
    Pair(_key, pair) {
      if (pair?.key?.value !== "uses" || typeof pair?.value?.value !== "string") return;

      const reference = pair.value.value.trim();
      const actionMatch = THIRD_PARTY_ACTION_REFERENCE_PATTERN.exec(reference);
      if (!actionMatch) return;

      const [, action, ref] = actionMatch;
      const [owner] = action.split("/", 1);
      if (FIRST_PARTY_ACTION_OWNERS.has(owner)) return;
      if (FULL_LENGTH_COMMIT_SHA_PATTERN.test(ref)) return;

      reportWorkflowError(
        relativeFile,
        `Third-party GitHub Actions must pin a full 40-character commit SHA: ${action}@${ref}`,
        "ARCWF1001",
        extractOffsetLocation(pair.key?.range?.[0], contents),
      );
    },
  });
}

function reportWorkflowError(relativeFile, message, code = "ARCWF1000", location = { line: 1, column: 1 }) {
  process.stderr.write(`${relativeFile}(${location.line},${location.column}): error ${code}: ${message}\n`);
  errorCount += 1;
}

function extractOffsetLocation(rawOffset, contents) {
  if (typeof rawOffset !== "number" || !Number.isInteger(rawOffset) || rawOffset < 0) {
    return { line: 1, column: 1 };
  }

  const preceding = contents.slice(0, rawOffset);
  const lineBreaks = preceding.match(/\n/g)?.length ?? 0;
  const lastLineStart = preceding.lastIndexOf("\n");
  return {
    line: lineBreaks + 1,
    column: rawOffset - lastLineStart,
  };
}
