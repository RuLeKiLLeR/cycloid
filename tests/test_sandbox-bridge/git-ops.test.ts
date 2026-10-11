import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFileSync: mocks.execFileSync,
}));
vi.mock("node:child_process", () => ({
  execFileSync: mocks.execFileSync,
}));

vi.stubGlobal("fetch", mocks.fetch);

let savedRealGitPath: string | undefined;

// Safety net: restore any spy (e.g. the Date.now spies in the latency tests)
// even if a test throws before its inline mockRestore. Does NOT touch the
// module-level fetch stubGlobal above, which is intentional whole-file setup.
afterEach(() => {
  if (savedRealGitPath === undefined) delete process.env.ARCANIST_REAL_GIT_PATH;
  else process.env.ARCANIST_REAL_GIT_PATH = savedRealGitPath;
  vi.restoreAllMocks();
});

const { GitOperations } = await import("../../apps/sandbox-bridge/src/services/git-ops.js");
const { ensureSessionBranch } = await import("../../apps/sandbox-bridge/src/services/git/branch.js");
const { CYCLOID_CO_AUTHOR_TRAILER } = await import("../../shared/constants/git-identity.js");
const { createCommit } = await import("../../apps/sandbox-bridge/src/services/git/commit.js");
const { computeDiffPreparation } = await import("../../apps/sandbox-bridge/src/services/git/diff.js");
const { createTimelineRecorder } = await import("../../apps/sandbox-bridge/src/services/git/progress.js");
const { pushSessionBranch, CloneTokenError, isNonFastForwardRejection, isWorkflowsPermissionRejection } =
  await import("../../apps/sandbox-bridge/src/services/git/push.js");
const { decodePorcelainPath, porcelainDestinationPath } =
  await import("../../apps/sandbox-bridge/src/services/git/staging.js");
const {
  appendCollisionSuffix,
  buildCycloidBranchBaseNameFromSafeHint,
  buildCycloidBranchCollisionSuffix,
  buildCycloidBranchDisambiguator,
  buildSafeCycloidBranchHint,
  sanitizeBranchSlug,
} = await import("../../shared/utils/cycloid-branch-name.js");
const { TRUNCATED_DIFF_OMISSION_MARKER_PREFIX } = await import("../../shared/post-execution.js");

const WORKFLOWS_PERMISSION_REJECTION_STDERR = [
  "remote: error: refusing to allow a GitHub App to create or update workflow `.github/workflows/check-db-migration-sql.yaml` without `workflows` permission",
  "To https://github.com/trycycloid/openevidence-skeleton-new.git",
  " ! [remote rejected] HEAD -> repo-onboarding-setup-4a33b87e1082 (refusing to allow a GitHub App to create or update workflow `.github/workflows/check-db-migration-sql.yaml` without `workflows` permission)",
  "error: failed to push some refs to 'https://github.com/trycycloid/openevidence-skeleton-new.git'",
].join("\n");

const PUSH_FAILURE_MONITOR_SUBSTRINGS = [
  "Failed to push to origin after retries",
  "clone-token auth persistently rejected",
  "clone-token refresh failed; aborting push",
];

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
}

function createGitOps(
  options: {
    cwd?: string;
    getModifiedFiles?: () => Iterable<string>;
    truncatedFullDiffBytes?: number;
    sendEvent?: ReturnType<typeof vi.fn>;
    pushDelay?: (ms: number) => Promise<void>;
    branchNameHint?: string;
    recordPushAttemptResolved?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const sendEvent = options.sendEvent ?? vi.fn();
  const recordPushAttemptResolved = options.recordPushAttemptResolved ?? vi.fn();
  const gitOps = new GitOperations({
    cwd: options.cwd ?? "/repo",
    controlPlaneUrl: "https://control.example.com",
    getAuthToken: () => "token",
    sessionId: "sess-1",
    sandboxId: "sbx-1",
    baseBranch: "main",
    maxFullDiffBytes: 10_000,
    truncatedFullDiffBytes: options.truncatedFullDiffBytes ?? 10_000,
    getModifiedFiles: options.getModifiedFiles ?? (() => ["/repo/src/app.ts"]),
    getBranchNameHint: () => options.branchNameHint,
    sendEvent,
    recordPushAttemptResolved,
    pushDelay: options.pushDelay ?? (async () => undefined),
  });

  return { gitOps, sendEvent, recordPushAttemptResolved };
}

function mockCloneTokenResponse(token = "fresh-token") {
  mocks.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, token }),
    text: async () => "",
  } as Response);
}

function findGitCallIndex(predicate: (args: string[]) => boolean): number {
  return mocks.execFileSync.mock.calls.findIndex(([cmd, args]: [string, string[]]) => cmd === "git" && predicate(args));
}

function findTargetedAddCalls() {
  return mocks.execFileSync.mock.calls.filter(
    ([cmd, args]: [string, string[]]) => cmd === "git" && args[0] === "add" && args[1] === "--",
  );
}

function makeMissingRemoteBranchError() {
  const error = new Error("missing remote branch") as Error & { status?: number; signal?: string | null };
  error.status = 2;
  error.signal = null;
  return error;
}

function makeWorkflowsPermissionPushError() {
  return Object.assign(new Error("git push rejected"), {
    stderr: WORKFLOWS_PERMISSION_REJECTION_STDERR,
    stdout: "",
  });
}

function makePushRejection(stderr: string) {
  return Object.assign(new Error("git push rejected"), {
    stderr,
    stdout: "",
  });
}

function expectNoPushFailureMonitorSubstrings(text: string) {
  for (const substring of PUSH_FAILURE_MONITOR_SUBSTRINGS) {
    expect(text).not.toContain(substring);
  }
}

describe("GitOperations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    savedRealGitPath = process.env.ARCANIST_REAL_GIT_PATH;
    process.env.ARCANIST_REAL_GIT_PATH = "git";
    delete process.env.GIT_AUTHOR_NAME;
    delete process.env.GIT_AUTHOR_EMAIL;
    mockCloneTokenResponse();
  });

  it("classifies GitHub App workflow-permission push rejections and extracts the workflow path", () => {
    expect(isWorkflowsPermissionRejection(makeWorkflowsPermissionPushError())).toEqual({
      workflowPaths: [".github/workflows/check-db-migration-sql.yaml"],
    });
    expect(
      isWorkflowsPermissionRejection(
        Object.assign(new Error("failed to push"), {
          stderr:
            "remote: error: refusing to allow a GitHub App to create or update workflow `.github/workflows/check.yml`",
        }),
      ),
    ).toBeNull();
    expect(
      isWorkflowsPermissionRejection(
        Object.assign(new Error("failed to push"), {
          stderr: "remote: error: repository policy rejected this change without `workflows` permission",
        }),
      ),
    ).toBeNull();
    expect(
      isWorkflowsPermissionRejection(
        Object.assign(new Error("failed to push"), {
          stderr: "! [rejected] HEAD -> feature/pr-head (stale info)",
        }),
      ),
    ).toBeNull();
  });

  it("classifies only plain non-fast-forward branch rejections", () => {
    expect(
      isNonFastForwardRejection(
        makePushRejection(
          "! [rejected]        HEAD -> session-work (fetch first)\nerror: failed to push some refs\nhint: Updates were rejected because the remote contains work that you do not have locally.",
        ),
        "session-work",
      ),
    ).toBe(true);
    expect(
      isNonFastForwardRejection(
        makePushRejection("! [rejected]        HEAD -> session-work (non-fast-forward)"),
        "session-work",
      ),
    ).toBe(true);

    expect(isNonFastForwardRejection(makePushRejection("fatal: Authentication failed"), "session-work")).toBe(false);
    expect(isNonFastForwardRejection(makeWorkflowsPermissionPushError(), "session-work")).toBe(false);
    expect(isNonFastForwardRejection(makePushRejection("remote: error: GH006: Protected branch update failed"))).toBe(
      false,
    );
    expect(isNonFastForwardRejection(makePushRejection("remote: error: pre-receive hook declined"))).toBe(false);
    expect(isNonFastForwardRejection(makePushRejection("fatal: write error: No space left on device"))).toBe(false);
    expect(isNonFastForwardRejection(makePushRejection("! [rejected] session-work -> session-work (stale info)"))).toBe(
      false,
    );
  });

  it("does not report publishable changes without a base branch or staged files", () => {
    const promptLog = createLogger();

    const result = computeDiffPreparation({
      cwd: "/repo",
      maxFullDiffBytes: 10_000,
      truncatedFullDiffBytes: 10_000,
      status: "",
      hasStagedFiles: false,
      stagedFiles: [],
      promptLog,
    });

    expect(result).toMatchObject({
      hasChanges: false,
      hasStagedFiles: false,
      stagedFiles: [],
      publishFiles: [],
    });
  });

  it("detects ahead-commits against the base when the working tree is clean (ARC-1192)", () => {
    // Simulates an agent that ran `git commit` itself during the prompt: status
    // is empty, nothing is staged, but HEAD is ahead of origin/main.
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "merge-base") return "base-sha\n";
      if (args[0] === "diff" && args[1] === "--name-only" && args[2] === "origin/main") return "README.md\n";
      if (args[0] === "diff" && args[1] === "--stat=9999,9999" && args[2] === "origin/main")
        return "README.md | 5 +++--\n";
      if (args[0] === "diff" && args[1] === "origin/main") return "diff --git a/README.md b/README.md\n";
      return "";
    });

    const result = computeDiffPreparation({
      cwd: "/repo",
      baseBranch: "main",
      maxFullDiffBytes: 10_000,
      truncatedFullDiffBytes: 10_000,
      status: "",
      hasStagedFiles: false,
      stagedFiles: [],
      promptLog: createLogger(),
    });

    expect(result).toMatchObject({
      hasChanges: true,
      hasStagedFiles: false,
      publishFiles: ["README.md"],
      diffSummary: "README.md | 5 +++--",
      fullDiff: "diff --git a/README.md b/README.md\n",
    });
  });

  it("falls back to a local base ref when origin/<base> is not fetched (ARC-1192)", () => {
    const originDiffErr = Object.assign(new Error("unknown revision origin/main"), {
      status: 128,
    });
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "merge-base" && args[2] === "origin/main") throw originDiffErr;
      if (args[0] === "merge-base" && args[2] === "main") return "base-sha\n";
      if (args[0] === "diff" && args[2] === "origin/main") throw originDiffErr;
      if (args[0] === "diff" && args[1] === "--name-only" && args[2] === "main") return "README.md\n";
      if (args[0] === "diff" && args[1] === "--stat=9999,9999" && args[2] === "main") return "README.md | 5 +++--\n";
      if (args[0] === "diff" && args[1] === "main") return "diff --git a/README.md b/README.md\n";
      return "";
    });

    const result = computeDiffPreparation({
      cwd: "/repo",
      baseBranch: "main",
      maxFullDiffBytes: 10_000,
      truncatedFullDiffBytes: 10_000,
      status: "",
      hasStagedFiles: false,
      stagedFiles: [],
      promptLog: createLogger(),
    });

    expect(result.hasChanges).toBe(true);
    expect(result.publishFiles).toEqual(["README.md"]);
    expect(result.diffSummary).toBe("README.md | 5 +++--");
  });

  it("falls back to a merge-base SHA when both origin/<base> and <base> diffs fail (ARC-1192)", () => {
    const refErr = Object.assign(new Error("unknown revision"), { status: 128 });
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      // origin/main is unresolvable for both merge-base and diff
      if (args[0] === "merge-base" && args[2] === "origin/main") throw refErr;
      // local main has a merge-base but diff against it explodes
      if (args[0] === "merge-base" && args[2] === "main") return "base-sha\n";
      if (args[0] === "diff" && args[2] === "origin/main") throw refErr;
      if (args[0] === "diff" && args[2] === "main") throw refErr;
      // The merge-base SHA is the only ref that produces a usable diff
      if (args[0] === "diff" && args[1] === "--name-only" && args[2] === "base-sha") return "README.md\n";
      if (args[0] === "diff" && args[1] === "--stat=9999,9999" && args[2] === "base-sha") return "README.md | 3 +++\n";
      if (args[0] === "diff" && args[1] === "base-sha") return "diff --git a/README.md b/README.md\n";
      return "";
    });

    const result = computeDiffPreparation({
      cwd: "/repo",
      baseBranch: "main",
      maxFullDiffBytes: 10_000,
      truncatedFullDiffBytes: 10_000,
      status: "",
      hasStagedFiles: false,
      stagedFiles: [],
      promptLog: createLogger(),
    });

    expect(result.hasChanges).toBe(true);
    expect(result.publishFiles).toEqual(["README.md"]);
    expect(result.diffSummary).toBe("README.md | 3 +++");
    expect(result.fullDiff).toBe("diff --git a/README.md b/README.md\n");
  });

  it("keeps walking after an empty diff so a later ref can detect ahead-commits (ARC-1192)", () => {
    // origin/main is reachable but stale: its diff against HEAD is empty.
    // The merge-base of origin/main (also stale) is what actually shows the
    // ahead-commit, so the walk must continue past the first empty result.
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "merge-base" && args[2] === "origin/main") return "merge-base-sha\n";
      if (args[0] === "merge-base" && args[2] === "main") return "merge-base-sha\n";
      if (args[0] === "diff" && args[1] === "--name-only" && args[2] === "origin/main") return "";
      if (args[0] === "diff" && args[1] === "--stat=9999,9999" && args[2] === "origin/main") return "";
      if (args[0] === "diff" && args[1] === "--name-only" && args[2] === "merge-base-sha") return "README.md\n";
      if (args[0] === "diff" && args[1] === "--stat=9999,9999" && args[2] === "merge-base-sha")
        return "README.md | 3 +++\n";
      if (args[0] === "diff" && args[1] === "merge-base-sha") return "diff --git a/README.md b/README.md\n";
      if (args[0] === "diff" && args[1] === "--name-only" && args[2] === "main") return "";
      if (args[0] === "diff" && args[1] === "--stat=9999,9999" && args[2] === "main") return "";
      return "";
    });

    const result = computeDiffPreparation({
      cwd: "/repo",
      baseBranch: "main",
      maxFullDiffBytes: 10_000,
      truncatedFullDiffBytes: 10_000,
      status: "",
      hasStagedFiles: false,
      stagedFiles: [],
      promptLog: createLogger(),
    });

    expect(result.hasChanges).toBe(true);
    expect(result.publishFiles).toEqual(["README.md"]);
  });

  it("warns when no base ref is reachable and falls back to the working-tree status (ARC-1192)", () => {
    const err = new Error("unknown revision");
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "merge-base") throw err;
      if (args[0] === "diff") throw err;
      return "";
    });

    const logger = createLogger();
    const result = computeDiffPreparation({
      cwd: "/repo",
      baseBranch: "main",
      maxFullDiffBytes: 10_000,
      truncatedFullDiffBytes: 10_000,
      status: "",
      hasStagedFiles: false,
      stagedFiles: [],
      promptLog: logger,
    });

    expect(result.hasChanges).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ baseBranch: "main" }),
      expect.stringContaining("Failed to diff against any candidate base ref"),
    );
  });

  it("detects a committed clean-tree change against the publish branch even when no base ref resolves", () => {
    // The stranded-follow-up shape: the agent committed its work (clean tree),
    // origin/<base> was never fetched, but the sandbox was cloned on the PR
    // branch so origin/<publishBranch> exists. Pre-fix this fell through to
    // the working-tree fallback and silently dropped the commit.
    const err = new Error("unknown revision");
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "diff" && args[1] === "--name-only" && args[2] === "origin/session-branch") return "README.md\n";
      if (args[0] === "diff" && args[1] === "--stat=9999,9999" && args[2] === "origin/session-branch")
        return "README.md | 3 +++\n";
      if (args[0] === "diff" && args[1] === "origin/session-branch") return "diff --git a/README.md b/README.md\n";
      throw err;
    });

    const result = computeDiffPreparation({
      cwd: "/repo",
      baseBranch: "main",
      publishBranch: "session-branch",
      maxFullDiffBytes: 10_000,
      truncatedFullDiffBytes: 10_000,
      status: "",
      hasStagedFiles: false,
      stagedFiles: [],
      promptLog: createLogger(),
    });

    expect(result.hasChanges).toBe(true);
    expect(result.publishFiles).toEqual(["README.md"]);
    expect(result.diffSummary).toBe("README.md | 3 +++");
    expect(result.fullDiff).toBe("diff --git a/README.md b/README.md\n");
  });

  it("detects an uncommitted edit against the publish branch", () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "diff" && args[1] === "--name-only" && args[2] === "origin/session-branch") return "src/app.ts\n";
      if (args[0] === "diff" && args[1] === "--stat=9999,9999" && args[2] === "origin/session-branch")
        return "src/app.ts | 2 +-\n";
      if (args[0] === "diff" && args[1] === "origin/session-branch") return "diff --git a/src/app.ts b/src/app.ts\n";
      return "";
    });

    const result = computeDiffPreparation({
      cwd: "/repo",
      baseBranch: "main",
      publishBranch: "session-branch",
      maxFullDiffBytes: 10_000,
      truncatedFullDiffBytes: 10_000,
      status: " M src/app.ts",
      hasStagedFiles: false,
      stagedFiles: [],
      promptLog: createLogger(),
    });

    expect(result.hasChanges).toBe(true);
    expect(result.publishFiles).toEqual(["src/app.ts"]);
  });

  it("treats an empty diff against the publish branch as terminal even when the base diff is non-empty", () => {
    // Pure-Q&A follow-up on an existing PR: nothing new vs the session tip,
    // but origin/<base> shows the cumulative PR diff. Falling through to the
    // base refs here would falsely re-publish prior prompts' work.
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "diff" && args[2] === "origin/session-branch") return "";
      if (args[0] === "merge-base") return "merge-base-sha\n";
      if (args[0] === "diff" && args[1] === "--name-only" && args[2] === "origin/main")
        return "README.md\nsrc/app.ts\n";
      if (args[0] === "diff" && args[1] === "--stat=9999,9999" && args[2] === "origin/main")
        return "README.md | 3 +++\nsrc/app.ts | 2 +-\n";
      return "";
    });

    const result = computeDiffPreparation({
      cwd: "/repo",
      baseBranch: "main",
      publishBranch: "session-branch",
      maxFullDiffBytes: 10_000,
      truncatedFullDiffBytes: 10_000,
      status: "",
      hasStagedFiles: false,
      stagedFiles: [],
      promptLog: createLogger(),
    });

    expect(result.hasChanges).toBe(false);
    expect(result.publishFiles).toEqual([]);
    // The walk never consulted the base refs: the publish-branch result is final.
    expect(
      mocks.execFileSync.mock.calls.filter(
        ([cmd, args]: [string, string[]]) => cmd === "git" && args[0] === "diff" && args.includes("origin/main"),
      ),
    ).toEqual([]);
  });

  it("keeps the base-ref walk when the publish branch equals the base branch (initial prompt)", () => {
    // Initial-prompt shape: still checked out on the base branch. The publish
    // probe must not short-circuit the ARC-1192 walk that detects ahead-commits
    // via the merge-base when origin/<base> is stale.
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "merge-base") return "merge-base-sha\n";
      if (args[0] === "diff" && args[1] === "--name-only" && args[2] === "origin/main") return "";
      if (args[0] === "diff" && args[1] === "--stat=9999,9999" && args[2] === "origin/main") return "";
      if (args[0] === "diff" && args[1] === "--name-only" && args[2] === "merge-base-sha") return "README.md\n";
      if (args[0] === "diff" && args[1] === "--stat=9999,9999" && args[2] === "merge-base-sha")
        return "README.md | 3 +++\n";
      if (args[0] === "diff" && args[1] === "merge-base-sha") return "diff --git a/README.md b/README.md\n";
      return "";
    });

    const result = computeDiffPreparation({
      cwd: "/repo",
      baseBranch: "main",
      publishBranch: "main",
      maxFullDiffBytes: 10_000,
      truncatedFullDiffBytes: 10_000,
      status: "",
      hasStagedFiles: false,
      stagedFiles: [],
      promptLog: createLogger(),
    });

    expect(result.hasChanges).toBe(true);
    expect(result.publishFiles).toEqual(["README.md"]);
  });

  it("falls back to the base-ref walk when the publish-branch tracking ref is unresolvable", () => {
    const refErr = Object.assign(new Error("unknown revision origin/session-branch"), { status: 128 });
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "diff" && args[2] === "origin/session-branch") throw refErr;
      if (args[0] === "merge-base") return "base-sha\n";
      if (args[0] === "diff" && args[1] === "--name-only" && args[2] === "origin/main") return "README.md\n";
      if (args[0] === "diff" && args[1] === "--stat=9999,9999" && args[2] === "origin/main")
        return "README.md | 5 +++--\n";
      if (args[0] === "diff" && args[1] === "origin/main") return "diff --git a/README.md b/README.md\n";
      return "";
    });

    const result = computeDiffPreparation({
      cwd: "/repo",
      baseBranch: "main",
      publishBranch: "session-branch",
      maxFullDiffBytes: 10_000,
      truncatedFullDiffBytes: 10_000,
      status: "",
      hasStagedFiles: false,
      stagedFiles: [],
      promptLog: createLogger(),
    });

    expect(result.hasChanges).toBe(true);
    expect(result.publishFiles).toEqual(["README.md"]);
    expect(result.diffSummary).toBe("README.md | 5 +++--");
  });

  it("sanitizes messy task text into a readable branch slug", () => {
    expect(sanitizeBranchSlug("Ship naïve UI / [demo]*", 32)).toBe("ship-naive-ui-demo");
  });

  it("redacts sensitive task text before using it as a branch hint", () => {
    expect(buildSafeCycloidBranchHint("/codex Fix OAuth callback")).toBe("fix-oauth-callback");
    expect(buildSafeCycloidBranchHint("please make the images on this 4:3 aspect ratio")).toBe(
      "images-on-this-4-3-aspect-ratio",
    );
    expect(buildSafeCycloidBranchHint("Fix token abc1234567890abcdef leak")).toBe("");
    expect(buildSafeCycloidBranchHint("Rotate postgresql://user:pass@db.example.com:5432/app now")).toBe("rotate-now");
    expect(buildSafeCycloidBranchHint("Fix mysql://root:hunter2@db.example.com/app migration")).toBe("fix-migration");
    expect(
      buildSafeCycloidBranchHint("Check mongodb://user:pass@cluster.example.com/db and redis://:pw@cache:6379"),
    ).toBe("check-and");
    expect(buildSafeCycloidBranchHint("Keep url::parse helper behavior")).toBe("keep-url-parse-helper-behavior");
    expect(buildSafeCycloidBranchHint("Fix https://user:pass@example.com/callback issue")).toBe("fix-issue");
  });

  it("preserves pre-sanitized branch hints captured by the bridge", () => {
    const sessionId = "f2cd772c-1ef2-448f-9d94-d06e37a56486";
    const taskText =
      "Readable branch verification marker. Add a file at .cycloid-verification/pr-2594-readable-branch.txt containing exactly: PR 2594 readable branch verification. Do not modify anything else.";
    const safeHint = buildSafeCycloidBranchHint(taskText);

    expect(safeHint).toBe("readable-branch-verification-marker-add-a-file");
    expect(buildCycloidBranchBaseNameFromSafeHint(safeHint)).toBe("readable-branch-verification-marker-add-a-file");
    expect(buildCycloidBranchDisambiguator(sessionId)).toBe("d06e37a56486");
  });

  it("uses the configured task hint as the default session branch name", () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "show-ref") throw new Error("missing local branch");
      if (args[0] === "ls-remote") throw makeMissingRemoteBranchError();
      if (args[0] === "checkout" && args[1] === "-b") return "";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const { gitOps } = createGitOps({ branchNameHint: buildSafeCycloidBranchHint("Fix payment redirect") });

    expect(gitOps.ensureSessionBranch(createLogger(), "main")).toBe("fix-payment-redirect");
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      "git",
      ["checkout", "-b", "fix-payment-redirect"],
      expect.objectContaining({
        encoding: "utf-8",
        cwd: "/repo",
      }),
    );
  });

  it("keeps the clean branch name even when a token-less remote lookup would fail", () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "show-ref") throw new Error("missing local branch");
      if (args[0] === "checkout" && args[1] === "-b") return "";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const logger = createLogger();
    const { gitOps } = createGitOps({ branchNameHint: buildSafeCycloidBranchHint("Fix payment redirect") });

    expect(gitOps.ensureSessionBranch(logger, "main")).toBe("fix-payment-redirect");
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      "git",
      ["checkout", "-b", "fix-payment-redirect"],
      expect.objectContaining({
        encoding: "utf-8",
        cwd: "/repo",
      }),
    );
    expect(mocks.execFileSync).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["ls-remote"]),
      expect.anything(),
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      "Readable branch name could collide with an existing branch; using a disambiguated branch name",
    );
  });

  it("uses a disambiguated branch name when the readable branch matches the base branch", () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "show-ref") throw new Error("missing local branch");
      if (args[0] === "checkout" && args[1] === "-b") return "";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const logger = createLogger();
    const { gitOps } = createGitOps({ branchNameHint: "main" });
    const expectedBranch = appendCollisionSuffix("main", buildCycloidBranchCollisionSuffix("sess-1"));

    expect(gitOps.ensureSessionBranch(logger, "main")).toBe(expectedBranch);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: expectedBranch,
        preferredBranch: "main",
        baseBranch: "main",
        localBranchState: false,
      }),
      "Readable branch name could collide with an existing branch; using a disambiguated branch name",
    );
  });

  it("does not disambiguate when the remote branch state is unknown", () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "show-ref") throw new Error("missing local branch");
      if (args[0] === "checkout" && args[1] === "-b") return "";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const logger = createLogger();
    const { gitOps } = createGitOps({ branchNameHint: buildSafeCycloidBranchHint("Fix payment redirect") });

    expect(gitOps.ensureSessionBranch(logger, "main")).toBe("fix-payment-redirect");
    expect(mocks.execFileSync).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["ls-remote"]),
      expect.anything(),
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      "Readable branch name could collide with an existing branch; using a disambiguated branch name",
    );
  });

  it("uses a disambiguated branch name when a local branch with the readable name already exists", () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "show-ref") return "";
      if (args[0] === "checkout" && args[1] === "-b") return "";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const logger = createLogger();
    const { gitOps } = createGitOps({ branchNameHint: buildSafeCycloidBranchHint("Fix payment redirect") });
    const expectedBranch = appendCollisionSuffix("fix-payment-redirect", buildCycloidBranchCollisionSuffix("sess-1"));

    expect(gitOps.ensureSessionBranch(logger, "main")).toBe(expectedBranch);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: expectedBranch,
        preferredBranch: "fix-payment-redirect",
        localBranchState: true,
      }),
      "Readable branch name could collide with an existing branch; using a disambiguated branch name",
    );
  });

  it("pushes verifier fixes to the current PR branch without creating a session branch", async () => {
    const sendEvent = vi.fn();
    let headReads = 0;
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "feature/pr-head\n";
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "refs/remotes/origin/feature/pr-head")
        return "base123\n";
      if (args[0] === "commit") return "";
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        headReads += 1;
        return headReads === 1 ? "base123\n" : "fix123\n";
      }
      if (args[0] === "remote" && args[1] === "set-url") return "";
      if (args[0] === "push") return "";
      if (args[0] === "update-ref") return "";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });
    const { gitOps } = createGitOps({ sendEvent });

    const result = await gitOps.commitAndPushCurrentBranch(createLogger(), "msg-1", {
      expectedBranch: "feature/pr-head",
      commitMessage: "Apply verifier fixes",
    });

    expect(result).toMatchObject({ ok: true, branch: "feature/pr-head", commitSha: "fix123" });
    expect(findGitCallIndex((args) => args[0] === "checkout")).toBe(-1);
    // The push advances the local remote-tracking ref so the next prompt's
    // publish baseline (origin/<branch>) reflects what just landed.
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      "git",
      ["update-ref", "refs/remotes/origin/feature/pr-head", "refs/heads/feature/pr-head"],
      expect.objectContaining({ cwd: "/repo" }),
    );
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      "git",
      [
        "push",
        "--no-verify",
        "-u",
        "origin",
        "HEAD:refs/heads/feature/pr-head",
        "--force-with-lease=refs/heads/feature/pr-head:base123",
      ],
      expect.objectContaining({
        encoding: "utf-8",
        cwd: "/repo",
        timeout: 60_000,
      }),
    );
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "push_complete", branchName: "feature/pr-head" }),
    );
  });

  it("pushes verifier-created local commits when they descend from the origin PR branch", async () => {
    const sendEvent = vi.fn();
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "feature/pr-head\n";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "fix123\n";
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "refs/remotes/origin/feature/pr-head")
        return "base123\n";
      if (args[0] === "merge-base" && args[1] === "--is-ancestor" && args[2] === "base123" && args[3] === "fix123") {
        return "";
      }
      if (args[0] === "commit") {
        const error = new Error("nothing to commit") as Error & { stdout?: string };
        error.stdout = "nothing to commit, working tree clean\n";
        throw error;
      }
      if (args[0] === "remote" && args[1] === "set-url") return "";
      if (args[0] === "push") return "";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });
    const { gitOps } = createGitOps({ sendEvent });

    const result = await gitOps.commitAndPushCurrentBranch(createLogger(), "msg-1", {
      expectedBranch: "feature/pr-head",
      commitMessage: "Apply verifier fixes",
    });

    expect(result).toMatchObject({ ok: true, branch: "feature/pr-head", commitSha: "fix123" });
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      "git",
      [
        "push",
        "--no-verify",
        "-u",
        "origin",
        "HEAD:refs/heads/feature/pr-head",
        "--force-with-lease=refs/heads/feature/pr-head:base123",
      ],
      expect.objectContaining({
        encoding: "utf-8",
        cwd: "/repo",
        timeout: 60_000,
      }),
    );
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "push_complete", branchName: "feature/pr-head", commitSha: "fix123" }),
    );
  });

  it("refreshes a stale force-with-lease sha after fetch and pushes on retry", async () => {
    const sendEvent = vi.fn();
    let headReads = 0;
    let fetched = false;
    let pushCalls = 0;
    const staleLeaseError = Object.assign(new Error("failed to push some refs"), {
      stderr: " ! [rejected]        HEAD -> feature/pr-head (stale info)\n",
      stdout: "",
    });
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "feature/pr-head\n";
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        headReads += 1;
        return headReads === 1 ? "base123\n" : "fix123\n";
      }
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "refs/remotes/origin/feature/pr-head") {
        return fetched ? "newremote456\n" : "base123\n";
      }
      if (
        args[0] === "fetch" &&
        args[1] === "origin" &&
        args[2] === "+refs/heads/feature/pr-head:refs/remotes/origin/feature/pr-head"
      ) {
        fetched = true;
        return "";
      }
      if (args[0] === "merge-base" && args[1] === "--is-ancestor" && args[2] === "newremote456" && args[3] === "fix123")
        return "";
      if (args[0] === "commit") return "";
      if (args[0] === "remote" && args[1] === "set-url") return "";
      if (args[0] === "push") {
        pushCalls += 1;
        if (pushCalls === 1) throw staleLeaseError;
        return "";
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });
    const { gitOps } = createGitOps({ sendEvent });

    const result = await gitOps.commitAndPushCurrentBranch(createLogger(), "msg-lease", {
      expectedBranch: "feature/pr-head",
      commitMessage: "Apply verifier fixes",
    });

    expect(result).toMatchObject({ ok: true, branch: "feature/pr-head" });
    expect(pushCalls).toBe(2);
    // The retry pushes with the refreshed lease sha, not the stale one.
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      "git",
      [
        "push",
        "--no-verify",
        "-u",
        "origin",
        "HEAD:refs/heads/feature/pr-head",
        "--force-with-lease=refs/heads/feature/pr-head:newremote456",
      ],
      expect.objectContaining({ encoding: "utf-8", cwd: "/repo", timeout: 60_000 }),
    );
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "push_complete", branchName: "feature/pr-head" }),
    );
    expect(sendEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "push_error" }));
  });

  it("verifier push maps push failures to push_failed without renaming", async () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "feature/pr-head\n";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "fix123\n";
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "refs/remotes/origin/feature/pr-head")
        return "base123\n";
      if (args[0] === "merge-base") return "";
      if (args[0] === "commit") return "";
      if (args[0] === "remote") return "";
      if (args[0] === "push") {
        throw makePushRejection("! [rejected]        HEAD -> feature/pr-head (non-fast-forward)");
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });
    const { gitOps } = createGitOps();

    const result = await gitOps.commitAndPushCurrentBranch(createLogger(), "msg-verifier-no-rename", {
      expectedBranch: "feature/pr-head",
      commitMessage: "Apply verifier fixes",
    });

    expect(result).toMatchObject({ ok: false, branch: "feature/pr-head", reason: "push_failed" });
    expect(findGitCallIndex((args) => args[0] === "branch" && args[1] === "-m")).toBe(-1);
  });

  it("aborts without force-pushing when the refreshed remote head is not an ancestor of HEAD", async () => {
    const sendEvent = vi.fn();
    const recordedTimeline: unknown[][] = [];
    let headReads = 0;
    let fetched = false;
    let pushCalls = 0;
    const staleLeaseError = Object.assign(new Error("failed to push some refs"), {
      stderr: " ! [rejected]        HEAD -> feature/pr-head (stale info)\n",
      stdout: "",
    });
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "feature/pr-head\n";
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        headReads += 1;
        return headReads === 1 ? "base123\n" : "fix123\n";
      }
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "refs/remotes/origin/feature/pr-head") {
        return fetched ? "rewritten789\n" : "base123\n";
      }
      if (
        args[0] === "fetch" &&
        args[1] === "origin" &&
        args[2] === "+refs/heads/feature/pr-head:refs/remotes/origin/feature/pr-head"
      ) {
        fetched = true;
        return "";
      }
      if (
        args[0] === "merge-base" &&
        args[1] === "--is-ancestor" &&
        args[2] === "rewritten789" &&
        args[3] === "fix123"
      ) {
        throw new Error("not ancestor");
      }
      if (args[0] === "commit") return "";
      if (args[0] === "remote" && args[1] === "set-url") return "";
      if (args[0] === "push") {
        pushCalls += 1;
        throw staleLeaseError;
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });
    const { gitOps } = createGitOps({ sendEvent });

    const result = await gitOps.commitAndPushCurrentBranch(createLogger(), "msg-diverged", {
      expectedBranch: "feature/pr-head",
      commitMessage: "Apply verifier fixes",
    });

    expect(result).toMatchObject({ ok: false, branch: "feature/pr-head", reason: "push_failed" });
    // The diverged remote aborts immediately: exactly one push attempt, no
    // force push over the rewritten branch.
    expect(pushCalls).toBe(1);
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "push_error",
        branchName: "feature/pr-head",
        error: "remote_branch_diverged",
      }),
    );
  });

  it("keeps the existing retry behavior when the lease-refresh fetch fails", async () => {
    const sendEvent = vi.fn();
    let headReads = 0;
    let pushCalls = 0;
    let fetchCalls = 0;
    const staleLeaseError = Object.assign(new Error("failed to push some refs"), {
      stderr: " ! [rejected]        HEAD -> feature/pr-head (stale info)\n",
      stdout: "",
    });
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "feature/pr-head\n";
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        headReads += 1;
        return headReads === 1 ? "base123\n" : "fix123\n";
      }
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "refs/remotes/origin/feature/pr-head")
        return "base123\n";
      if (args[0] === "fetch") {
        fetchCalls += 1;
        throw new Error("could not resolve host");
      }
      if (args[0] === "commit") return "";
      if (args[0] === "remote" && args[1] === "set-url") return "";
      if (args[0] === "push") {
        pushCalls += 1;
        throw staleLeaseError;
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });
    const { gitOps } = createGitOps({ sendEvent });

    const result = await gitOps.commitAndPushCurrentBranch(createLogger(), "msg-fetch-fail", {
      expectedBranch: "feature/pr-head",
      commitMessage: "Apply verifier fixes",
    });

    expect(result).toMatchObject({ ok: false, branch: "feature/pr-head", reason: "push_failed" });
    // fetch_failed falls back to the bounded retry loop: all attempts consumed.
    expect(pushCalls).toBe(5);
    // No refresh on the final attempt: there is no retry left to use it.
    expect(fetchCalls).toBe(4);
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "push_error", branchName: "feature/pr-head" }),
    );
  });

  it("redacts credentialed URLs from push_error payloads after exhausted retries", async () => {
    const sendEvent = vi.fn();
    const fetchFreshCloneToken = vi.fn(async () => "secrettoken123");
    mocks.execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "push") {
        throw Object.assign(
          new Error("fatal: unable to access 'https://x-access-token:secrettoken123@github.com/acme/repo.git/': 403"),
          { stderr: "", stdout: "" },
        );
      }
      return "";
    });

    const pushed = await pushSessionBranch({
      config: {
        cwd: "/repo",
        controlPlaneUrl: "https://control.example.com",
        getAuthToken: () => "token",
        sessionId: "sess-1",
        sandboxId: "sbx-1",
        baseBranch: "main",
        maxFullDiffBytes: 10_000,
        truncatedFullDiffBytes: 10_000,
        getModifiedFiles: () => [],
        sendEvent,
      },
      currentBranch: "feature/redact",
      messageId: "msg-redact",
      promptLog: createLogger(),
      recordTimeline: vi.fn(),
      fetchFreshCloneToken,
      delay: async () => undefined,
    });

    expect(pushed).toEqual({ ok: false, reason: "other" });
    const pushError = sendEvent.mock.calls.map(([event]) => event).find((event) => event.type === "push_error");
    expect(pushError).toBeDefined();
    expect(pushError.error).not.toContain("secrettoken123");
    expect(pushError.error).toContain("[REDACTED]");
  });

  it("fails workflow-permission push rejections without retrying or tripping the generic push-failure monitor", async () => {
    const sendEvent = vi.fn();
    const recordTimeline = vi.fn();
    const recordPushAttemptResolved = vi.fn();
    const delay = vi.fn(async () => undefined);
    const promptLog = createLogger();
    mocks.execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "remote") return "";
      if (cmd === "git" && args[0] === "push") throw makeWorkflowsPermissionPushError();
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const pushed = await pushSessionBranch({
      config: {
        cwd: "/repo",
        controlPlaneUrl: "https://control.example.com",
        getAuthToken: () => "token",
        sessionId: "sess-1",
        sandboxId: "sbx-1",
        baseBranch: "main",
        maxFullDiffBytes: 10_000,
        truncatedFullDiffBytes: 10_000,
        getModifiedFiles: () => [],
        sendEvent,
        recordPushAttemptResolved,
      },
      currentBranch: "repo-onboarding-setup-4a33b87e1082",
      messageId: "msg-workflows",
      promptLog,
      recordTimeline,
      fetchFreshCloneToken: vi.fn(async () => "fresh-token"),
      delay,
    });

    expect(pushed).toEqual({ ok: false, reason: "other" });
    expect(
      mocks.execFileSync.mock.calls.filter(([cmd, args]: [string, string[]]) => cmd === "git" && args[0] === "push"),
    ).toHaveLength(1);
    expect(delay).not.toHaveBeenCalled();
    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "push_error",
        branchName: "repo-onboarding-setup-4a33b87e1082",
        messageId: "msg-workflows",
        error:
          "updating `.github/workflows/check-db-migration-sql.yaml` requires the `workflows` permission, which the Cycloid GitHub App does not hold for this repo.",
      }),
    );
    expect(recordTimeline).toHaveBeenCalledWith(
      "git.push",
      "failed",
      expect.stringContaining("requires the `workflows` permission"),
      expect.objectContaining({
        reason: "workflows_permission_required",
        workflowPaths: [".github/workflows/check-db-migration-sql.yaml"],
        attempts: 1,
      }),
    );
    expect(recordPushAttemptResolved).toHaveBeenCalledWith({
      messageId: "msg-workflows",
      reason: "workflows_permission_required",
    });
    expect(promptLog.error).not.toHaveBeenCalled();
    const logMessages = [...promptLog.warn.mock.calls, ...promptLog.error.mock.calls]
      .map((call: unknown[]) => String(call[1] ?? ""))
      .join("\n");
    expectNoPushFailureMonitorSubstrings(logMessages);
  });

  it("returns branch_name_taken for create-only first-publish collisions without terminal push_error", async () => {
    const sendEvent = vi.fn();
    const recordTimeline = vi.fn();
    const recordPushAttempt = vi.fn();
    const recordPushAttemptResolved = vi.fn();
    const delay = vi.fn(async () => undefined);
    const promptLog = createLogger();
    mocks.execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "remote") return "";
      if (cmd === "git" && args[0] === "push") {
        throw makePushRejection("! [rejected]        HEAD -> session-work (stale info)");
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const pushed = await pushSessionBranch({
      config: {
        cwd: "/repo",
        controlPlaneUrl: "https://control.example.com",
        getAuthToken: () => "token",
        sessionId: "sess-1",
        sandboxId: "sbx-1",
        baseBranch: "main",
        maxFullDiffBytes: 10_000,
        truncatedFullDiffBytes: 10_000,
        getModifiedFiles: () => [],
        sendEvent,
        recordPushAttempt,
        recordPushAttemptResolved,
      },
      currentBranch: "session-work",
      messageId: "msg-taken",
      promptLog,
      recordTimeline,
      fetchFreshCloneToken: vi.fn(async () => "fresh-token"),
      delay,
    });

    expect(pushed).toEqual({ ok: false, reason: "branch_name_taken" });
    expect(delay).not.toHaveBeenCalled();
    expect(sendEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "push_error" }));
    expect(recordPushAttempt).toHaveBeenCalledWith({
      messageId: "msg-taken",
      branch: "session-work",
      commitSha: undefined,
    });
    expect(recordPushAttemptResolved).toHaveBeenCalledWith({
      messageId: "msg-taken",
      branch: "session-work",
      reason: "branch_name_taken",
    });
    expect(String(promptLog.error.mock.calls)).not.toContain("Failed to push to origin after retries");
  });

  it("blocks verifier push when the current branch is not the target PR branch", async () => {
    const sendEvent = vi.fn();
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main\n";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });
    const { gitOps } = createGitOps({ sendEvent });

    const result = await gitOps.commitAndPushCurrentBranch(createLogger(), "msg-1", {
      expectedBranch: "feature/pr-head",
      commitMessage: "Apply verifier fixes",
    });

    expect(result).toMatchObject({ ok: false, branch: "main", reason: "branch_mismatch" });
    expect(findGitCallIndex((args) => args[0] === "commit")).toBe(-1);
    expect(findGitCallIndex((args) => args[0] === "push")).toBe(-1);
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "push_error", branchName: "main" }));
  });

  it("blocks verifier push when the current HEAD is not based on the origin PR branch", async () => {
    const sendEvent = vi.fn();
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "feature/pr-head\n";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "stale123\n";
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "refs/remotes/origin/feature/pr-head")
        return "base123\n";
      if (args[0] === "merge-base" && args[1] === "--is-ancestor" && args[2] === "base123" && args[3] === "stale123") {
        throw new Error("not ancestor");
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });
    const { gitOps } = createGitOps({ sendEvent });

    const result = await gitOps.commitAndPushCurrentBranch(createLogger(), "msg-1", {
      expectedBranch: "feature/pr-head",
      commitMessage: "Apply verifier fixes",
    });

    expect(result).toMatchObject({ ok: false, branch: "feature/pr-head", reason: "head_mismatch" });
    expect(findGitCallIndex((args) => args[0] === "commit")).toBe(-1);
    expect(findGitCallIndex((args) => args[0] === "push")).toBe(-1);
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "push_error", branchName: "feature/pr-head" }),
    );
  });

  it("does not push or record a verifier commit when git commit is skipped", async () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "feature/pr-head\n";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "base123\n";
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "refs/remotes/origin/feature/pr-head")
        return "base123\n";
      if (args[0] === "commit") {
        const error = new Error("nothing to commit") as Error & { stdout?: string };
        error.stdout = "nothing to commit, working tree clean\n";
        throw error;
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });
    const { gitOps } = createGitOps();

    const result = await gitOps.commitAndPushCurrentBranch(createLogger(), "msg-1", {
      expectedBranch: "feature/pr-head",
      commitMessage: "Apply verifier fixes",
    });

    expect(result).toMatchObject({ ok: false, branch: "feature/pr-head", reason: "commit_skipped" });
    expect(result.commitSha).toBeUndefined();
    expect(findGitCallIndex((args) => args[0] === "push")).toBe(-1);
  });

  it("stages tracked modified files and computes diff context", () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "status") return " M src/app.ts\n";
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/repo\n";
      if (args[0] === "add") return "";
      if (args[0] === "diff" && args.includes("--cached") && args.includes("--name-only")) return "src/app.ts\n";
      if (args[0] === "diff" && args.includes("--cached") && args.some((flag) => flag.startsWith("--stat")))
        return " src/app.ts | 2 +-\n";
      if (args[0] === "diff" && args[1] === "--name-only") return "src/app.ts\n";
      if (args[0] === "diff" && args[1]?.startsWith("--stat")) return "src/app.ts | 5 +++--\n";
      if (args[0] === "diff" && args[1] === "origin/main") return "diff --git a/src/app.ts b/src/app.ts\n";
      return "";
    });

    const { gitOps, sendEvent } = createGitOps();

    const prep = gitOps.stageAndComputeDiffs(createLogger());

    expect(prep).toEqual({
      hasStagedFiles: true,
      stagedFiles: ["src/app.ts"],
      publishFiles: ["src/app.ts"],
      diffStat: "src/app.ts | 2 +-",
      diffSummary: "src/app.ts | 5 +++--",
      fullDiff: "diff --git a/src/app.ts b/src/app.ts\n",
      hasChanges: true,
    });
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      "git",
      ["add", "--", "src/app.ts"],
      expect.objectContaining({ cwd: "/repo" }),
    );
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      "git",
      ["diff", "--cached", "--stat=9999,9999"],
      expect.objectContaining({
        encoding: "utf-8",
        cwd: "/repo",
      }),
    );
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("requests a wide diff stat so git does not abbreviate long pathnames with a leading ellipsis", () => {
    const longPath = "apps/control-plane-worker/src/automation/service.ts";
    const statArgs: string[][] = [];
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "diff" && args[1] === "--name-only" && args[2] === "origin/main") return `${longPath}\n`;
      if (args[0] === "diff" && args.some((flag) => flag.startsWith("--stat"))) {
        statArgs.push(args);
        // A wide stat width keeps the full path intact instead of ".../automation/service.ts".
        return ` ${longPath} | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n`;
      }
      if (args[0] === "diff" && args[1] === "origin/main") return `diff --git a/${longPath} b/${longPath}\n`;
      return "";
    });

    const prep = computeDiffPreparation({
      cwd: "/repo",
      baseBranch: "main",
      maxFullDiffBytes: 10_000,
      truncatedFullDiffBytes: 10_000,
      status: "",
      hasStagedFiles: false,
      stagedFiles: [],
      promptLog: createLogger(),
    });

    expect(statArgs).toContainEqual(["diff", "--stat=9999,9999", "origin/main"]);
    expect(prep.diffSummary).toContain(longPath);
    expect(prep.diffSummary).not.toContain("...");
    expect(prep.publishFiles).toEqual([longPath]);
  });

  it("preserves the tail of oversized full diff evidence", () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "status") return " M src/app.ts\n";
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/repo\n";
      if (args[0] === "add") return "";
      if (args[0] === "diff" && args.includes("--cached") && args.includes("--name-only")) return "src/app.ts\n";
      if (args[0] === "diff" && args.includes("--cached") && args.some((flag) => flag.startsWith("--stat")))
        return " src/app.ts | 2 +-\n";
      if (args[0] === "diff" && args[1] === "--name-only") return "src/app.ts\n";
      if (args[0] === "diff" && args[1]?.startsWith("--stat")) return "src/app.ts | 5 +++--\n";
      if (args[0] === "diff" && args[1] === "origin/main") {
        return [
          "diff --git a/src/start.ts b/src/start.ts",
          "start evidence",
          "x".repeat(600),
          "diff --git a/src/end.ts b/src/end.ts",
          "late evidence",
        ].join("\n");
      }
      return "";
    });

    const { gitOps } = createGitOps({ truncatedFullDiffBytes: 240 });

    const prep = gitOps.stageAndComputeDiffs(createLogger());

    expect(prep?.fullDiff).toContain("start evidence");
    expect(prep?.fullDiff).toContain("late evidence");
    expect(prep?.fullDiff).toContain(TRUNCATED_DIFF_OMISSION_MARKER_PREFIX);
    expect(prep?.fullDiff?.length).toBeLessThanOrEqual(240);
  });

  it("ignores modified file paths outside the repo even when they share the repo prefix", () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "status") return " M src/app.ts\n";
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/repo\n";
      if (args[0] === "add") return "";
      if (args[0] === "diff" && args.includes("--cached") && args.includes("--name-only")) return "src/app.ts\n";
      if (args[0] === "diff" && args.includes("--cached") && args.some((flag) => flag.startsWith("--stat")))
        return " src/app.ts | 2 +-\n";
      if (args[0] === "diff" && args[1]?.startsWith("--stat")) return "src/app.ts | 5 +++--\n";
      if (args[0] === "diff" && args[1] === "origin/main") return "diff --git a/src/app.ts b/src/app.ts\n";
      return "";
    });

    const { gitOps, sendEvent } = createGitOps({
      getModifiedFiles: () => ["/repo/src/app.ts", "/repo-evil/src/app.ts", "/repo2/src/app.ts"],
    });

    gitOps.stageAndComputeDiffs(createLogger());

    expect(findTargetedAddCalls()).toEqual([
      ["git", ["add", "--", "src/app.ts"], expect.objectContaining({ cwd: "/repo" })],
    ]);
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("runs targeted git add from the repo root when cwd is a subdirectory", () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "status") return " M src/app.ts\n";
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/repo\n";
      if (args[0] === "add") return "";
      if (args[0] === "diff" && args.includes("--cached") && args.includes("--name-only")) return "src/app.ts\n";
      if (args[0] === "diff" && args.includes("--cached") && args.some((flag) => flag.startsWith("--stat")))
        return " src/app.ts | 2 +-\n";
      if (args[0] === "diff" && args[1]?.startsWith("--stat")) return "src/app.ts | 5 +++--\n";
      if (args[0] === "diff" && args[1] === "origin/main") return "diff --git a/src/app.ts b/src/app.ts\n";
      return "";
    });

    const { gitOps, sendEvent } = createGitOps({ cwd: "/repo/apps/ui" });

    gitOps.stageAndComputeDiffs(createLogger());

    expect(findTargetedAddCalls()).toEqual([
      ["git", ["add", "--", "src/app.ts"], expect.objectContaining({ cwd: "/repo" })],
    ]);
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("keeps valid in-repo paths whose first segment starts with two dots", () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "status") return " M ..config\n";
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/repo\n";
      if (args[0] === "add") return "";
      if (args[0] === "diff" && args.includes("--cached") && args.includes("--name-only"))
        return "..config\n..foo/app.ts\n";
      if (args[0] === "diff" && args.includes("--cached") && args.some((flag) => flag.startsWith("--stat")))
        return " ..config | 2 +-\n";
      if (args[0] === "diff" && args[1]?.startsWith("--stat")) return "..config | 5 +++--\n";
      if (args[0] === "diff" && args[1] === "origin/main") return "diff --git a/..config b/..config\n";
      return "";
    });

    const { gitOps, sendEvent } = createGitOps({
      getModifiedFiles: () => ["/repo/..config", "/repo/..foo/app.ts", "/repo/...config"],
    });

    gitOps.stageAndComputeDiffs(createLogger());

    expect(findTargetedAddCalls()).toEqual([
      ["git", ["add", "--", "..config", "..foo/app.ts", "...config"], expect.objectContaining({ cwd: "/repo" })],
    ]);
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("deduplicates repo-relative paths before targeted staging", () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "status") return " M src/app.ts\n";
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/repo\n";
      if (args[0] === "add") return "";
      if (args[0] === "diff" && args.includes("--cached") && args.includes("--name-only")) return "src/app.ts\n";
      if (args[0] === "diff" && args.includes("--cached") && args.some((flag) => flag.startsWith("--stat")))
        return " src/app.ts | 2 +-\n";
      if (args[0] === "diff" && args[1]?.startsWith("--stat")) return "src/app.ts | 5 +++--\n";
      if (args[0] === "diff" && args[1] === "origin/main") return "diff --git a/src/app.ts b/src/app.ts\n";
      return "";
    });

    const { gitOps, sendEvent } = createGitOps({
      getModifiedFiles: () => ["/repo/src/app.ts", "/repo/src/../src/app.ts"],
    });

    gitOps.stageAndComputeDiffs(createLogger());

    expect(findTargetedAddCalls()).toEqual([
      ["git", ["add", "--", "src/app.ts"], expect.objectContaining({ cwd: "/repo" })],
    ]);
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("splits comma-delimited modified paths before targeted staging", () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "status") return " M docs/a.md\n M docs/b.md\n";
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/repo\n";
      if (args[0] === "add") return "";
      if (args[0] === "diff" && args.includes("--cached") && args.includes("--name-only")) {
        return "docs/a.md\ndocs/b.md\n";
      }
      if (args[0] === "diff" && args.includes("--cached") && args.some((flag) => flag.startsWith("--stat"))) {
        return " docs/a.md | 1 +\n docs/b.md | 1 +\n";
      }
      if (args[0] === "diff" && args[1]?.startsWith("--stat")) return "docs/a.md | 1 +\ndocs/b.md | 1 +\n";
      if (args[0] === "diff" && args[1] === "origin/main") return "diff --git a/docs/a.md b/docs/a.md\n";
      return "";
    });

    const { gitOps } = createGitOps({
      getModifiedFiles: () => ["/repo/docs/a.md, /repo/docs/b.md, "],
    });

    gitOps.stageAndComputeDiffs(createLogger());

    expect(findTargetedAddCalls()).toEqual([
      ["git", ["add", "--", "docs/a.md", "docs/b.md"], expect.objectContaining({ cwd: "/repo" })],
    ]);
  });

  it("treats a trailing comma without following whitespace as a list delimiter", () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "status") return " M a.md\n M b.md\n";
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/repo\n";
      if (args[0] === "add") return "";
      if (args[0] === "diff" && args.includes("--cached") && args.includes("--name-only")) return "a.md\nb.md\n";
      if (args[0] === "diff" && args.includes("--cached") && args.some((flag) => flag.startsWith("--stat")))
        return " a.md | 1 +\n b.md | 1 +\n";
      if (args[0] === "diff" && args[1]?.startsWith("--stat")) return "a.md | 1 +\nb.md | 1 +\n";
      if (args[0] === "diff" && args[1] === "origin/main") return "diff --git a/a.md b/a.md\n";
      return "";
    });

    const { gitOps } = createGitOps({
      getModifiedFiles: () => ["/repo/a.md, /repo/b.md,"],
    });

    gitOps.stageAndComputeDiffs(createLogger());

    expect(findTargetedAddCalls()).toEqual([
      ["git", ["add", "--", "a.md", "b.md"], expect.objectContaining({ cwd: "/repo" })],
    ]);
  });

  it("strips a trailing delimiter from a single modified path before targeted staging", () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "status") return " M docs/a.md\n";
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/repo\n";
      if (args[0] === "add") return "";
      if (args[0] === "diff" && args.includes("--cached") && args.includes("--name-only")) return "docs/a.md\n";
      if (args[0] === "diff" && args.includes("--cached") && args.some((flag) => flag.startsWith("--stat")))
        return " docs/a.md | 1 +\n";
      if (args[0] === "diff" && args[1]?.startsWith("--stat")) return "docs/a.md | 1 +\n";
      if (args[0] === "diff" && args[1] === "origin/main") return "diff --git a/docs/a.md b/docs/a.md\n";
      return "";
    });

    const { gitOps } = createGitOps({
      getModifiedFiles: () => ["/repo/docs/a.md, "],
    });

    gitOps.stageAndComputeDiffs(createLogger());

    expect(findTargetedAddCalls()).toEqual([
      ["git", ["add", "--", "docs/a.md"], expect.objectContaining({ cwd: "/repo" })],
    ]);
  });

  it("decodes git C-quoted status paths", () => {
    expect(decodePorcelainPath('"quote\\\"and\\\\slash.ts"')).toBe('quote"and\\slash.ts');
  });

  it("resolves porcelain destination paths for plain and rename entries", () => {
    // Plain (non-rename) path: decoded as-is.
    expect(porcelainDestinationPath("src/file.ts")).toBe("src/file.ts");
    // Pure rename: keep only the destination path.
    expect(porcelainDestinationPath("old.ts -> new.ts")).toBe("new.ts");
    // Quoted rename destination containing a space.
    expect(porcelainDestinationPath('old.ts -> "new name.ts"')).toBe("new name.ts");
    // Octal-escaped non-ASCII quoted rename destination (café.ts).
    expect(porcelainDestinationPath('old.ts -> "caf\\303\\251.ts"')).toBe("café.ts");
  });

  it("batches large staging path lists", () => {
    const modifiedFiles = Array.from({ length: 1001 }, (_, index) => `/repo/src/file-${index}.ts`);
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "status") return " M src/file-0.ts\n";
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/repo\n";
      if (args[0] === "add") return "";
      if (args[0] === "diff" && args.includes("--cached") && args.includes("--name-only")) return "src/file-0.ts\n";
      if (args[0] === "diff" && args.includes("--cached") && args.some((flag) => flag.startsWith("--stat")))
        return " src/file-0.ts | 2 +-\n";
      if (args[0] === "diff" && args[1] === "--name-only") return "src/file-0.ts\n";
      if (args[0] === "diff" && args[1]?.startsWith("--stat")) return "src/file-0.ts | 5 +++--\n";
      if (args[0] === "diff" && args[1] === "origin/main") return "diff --git a/src/file-0.ts b/src/file-0.ts\n";
      return "";
    });

    const { gitOps } = createGitOps({ getModifiedFiles: () => modifiedFiles });

    gitOps.stageAndComputeDiffs(createLogger());

    const addCalls = findTargetedAddCalls();
    expect(addCalls).toHaveLength(3);
    expect(addCalls[0]?.[1]).toHaveLength(502);
    expect(addCalls[1]?.[1]).toHaveLength(502);
    expect(addCalls[2]?.[1]).toHaveLength(3);
  });

  it("unstages protected paths before computing staged file metadata", () => {
    let stagedListCalls = 0;
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "status") return " M src/app.ts\n M .env\n";
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/repo\n";
      if (args[0] === "add") return "";
      if (args[0] === "reset") return "";
      if (args[0] === "diff" && args.includes("--cached") && args.includes("--name-only")) {
        stagedListCalls++;
        return stagedListCalls === 1 ? "src/app.ts\n.env\n" : "src/app.ts\n";
      }
      if (args[0] === "diff" && args.includes("--cached") && args.some((flag) => flag.startsWith("--stat")))
        return " src/app.ts | 2 +-\n";
      if (args[0] === "diff" && args[1] === "--name-only") return "src/app.ts\n";
      if (args[0] === "diff" && args[1]?.startsWith("--stat")) return "src/app.ts | 5 +++--\n";
      if (args[0] === "diff" && args[1] === "origin/main") return "diff --git a/src/app.ts b/src/app.ts\n";
      return "";
    });

    const { gitOps } = createGitOps({
      getModifiedFiles: () => ["/repo/src/app.ts", "/repo/.env"],
    });

    const prep = gitOps.stageAndComputeDiffs(createLogger());

    expect(prep?.stagedFiles).toEqual(["src/app.ts"]);
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      "git",
      ["add", "--", "src/app.ts"],
      expect.objectContaining({ cwd: "/repo" }),
    );
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      "git",
      ["reset", "--", ".env"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("skips protected-only diffs without staging a commit", () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "status") return " M .env\n";
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/repo\n";
      if (args[0] === "diff" && args.includes("--cached") && args.includes("--name-only")) return "";
      if (args[0] === "diff" && args[1] === "--name-only") return ".env\n";
      if (args[0] === "diff" && args[1]?.startsWith("--stat")) return ".env | 1 +\n";
      if (args[0] === "diff" && args[1] === "origin/main") return "diff --git a/.env b/.env\n";
      return "";
    });
    const log = createLogger();
    const { gitOps } = createGitOps({
      getModifiedFiles: () => ["/repo/.env"],
    });

    const prep = gitOps.stageAndComputeDiffs(log);

    expect(prep?.hasChanges).toBe(true);
    expect(prep?.hasStagedFiles).toBe(false);
    expect(prep?.stagedFiles).toEqual([]);
    expect(mocks.execFileSync).not.toHaveBeenCalledWith("git", expect.arrayContaining(["add"]), expect.anything());
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ fileCount: 1, files: [".env"] }),
      "Skipped protected paths during staging",
    );
  });

  it("skips targeted git add when every modified file path is outside the repo or resolves to the repo root", () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "status") return " M src/app.ts\n";
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/repo\n";
      if (args[0] === "add") return "";
      if (args[0] === "diff" && args.includes("--cached") && args.includes("--name-only")) return "src/app.ts\n";
      if (args[0] === "diff" && args.includes("--cached") && args.some((flag) => flag.startsWith("--stat")))
        return " src/app.ts | 2 +-\n";
      if (args[0] === "diff" && args[1]?.startsWith("--stat")) return "src/app.ts | 5 +++--\n";
      if (args[0] === "diff" && args[1] === "origin/main") return "diff --git a/src/app.ts b/src/app.ts\n";
      return "";
    });

    const { gitOps, sendEvent } = createGitOps({
      getModifiedFiles: () => ["/repo", "/repo-evil/src/app.ts", "/repo2/src/app.ts"],
    });

    gitOps.stageAndComputeDiffs(createLogger());

    expect(findTargetedAddCalls()).toEqual([]);
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("captures repo snapshots from HEAD and porcelain status", () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "feature/repo-progress\n";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "abc123\n";
      if (args[0] === "status" && args[1] === "--porcelain") return " M assets/sound.wav\n";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const { gitOps } = createGitOps();

    expect(gitOps.captureRepoSnapshot(createLogger())).toEqual({
      headSha: "abc123",
      porcelain: "M assets/sound.wav",
    });
  });

  it("records and emits progress timeline events through the progress helper", () => {
    const sendEvent = vi.fn();
    const logger = createLogger();
    const timeline = createTimelineRecorder({ sandboxId: "sbx-1", sendEvent }, logger, "msg-1");

    timeline.record("git.push", "started", "Started pushing the session branch.", {
      branch: "feature",
      token: "ghp_secret123",
    });

    expect(timeline.entries).toHaveLength(1);
    expect(timeline.entries[0]).toMatchObject({
      eventType: "git.push",
      status: "started",
      promptId: "msg-1",
    });
    expect(timeline.entries[0]?.metadata).toMatchObject({ token: "[REDACTED]" });
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agent_timeline",
        eventType: "git.push",
        status: "started",
        messageId: "msg-1",
        sandboxId: "sbx-1",
      }),
    );
  });

  it("lists current changed files from branch diff, staged diff, and untracked files", () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "diff" && args[1] === "--name-only" && args[2] === "origin/main") {
        return "apps/ui/src/App.tsx\n";
      }
      if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--name-only") {
        return "apps/ui/src/Staged.tsx\n";
      }
      if (args[0] === "ls-files") {
        return "apps/ui/src/New.tsx\n";
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const { gitOps } = createGitOps();

    expect(gitOps.currentChangedFiles(createLogger())).toEqual([
      "apps/ui/src/App.tsx",
      "apps/ui/src/Staged.tsx",
      "apps/ui/src/New.tsx",
    ]);
  });

  it("prefers the publish branch's remote tip over the base for current changed files", () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "feature/session-branch\n";
      if (args[0] === "diff" && args[1] === "--name-only" && args[2] === "origin/feature/session-branch") {
        return "apps/ui/src/App.tsx\n";
      }
      if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--name-only") return "";
      if (args[0] === "ls-files") return "";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const { gitOps } = createGitOps();

    expect(gitOps.currentChangedFiles(createLogger())).toEqual(["apps/ui/src/App.tsx"]);
    expect(findGitCallIndex((args) => args[0] === "diff" && args.includes("origin/main"))).toBe(-1);
  });

  it("falls back to the base branch for current changed files when the publish branch ref is unresolvable", () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "feature/session-branch\n";
      if (args[0] === "diff" && args[1] === "--name-only" && args[2] === "origin/feature/session-branch") {
        throw new Error("unknown revision");
      }
      if (args[0] === "diff" && args[1] === "--name-only" && args[2] === "origin/main") {
        return "apps/ui/src/App.tsx\n";
      }
      if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--name-only") return "";
      if (args[0] === "ls-files") return "";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const { gitOps } = createGitOps();

    expect(gitOps.currentChangedFiles(createLogger())).toEqual(["apps/ui/src/App.tsx"]);
  });

  it("diffs against the checked-out publish branch's remote tip in stageAndComputeDiffs", () => {
    // Follow-up prompt: HEAD is on the session branch, the agent committed its
    // work (clean tree), and origin/<session-branch> exists. The prep must use
    // that ref, not origin/<base>.
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "feature/session-branch\n";
      if (args[0] === "status") return "";
      if (args[0] === "diff" && args[1] === "--name-only" && args[2] === "origin/feature/session-branch")
        return "README.md\n";
      if (args[0] === "diff" && args[1] === "--stat=9999,9999" && args[2] === "origin/feature/session-branch")
        return "README.md | 3 +++\n";
      if (args[0] === "diff" && args[1] === "origin/feature/session-branch")
        return "diff --git a/README.md b/README.md\n";
      return "";
    });

    const { gitOps } = createGitOps({ getModifiedFiles: () => [] });

    const prep = gitOps.stageAndComputeDiffs(createLogger());

    expect(prep).toMatchObject({
      hasChanges: true,
      publishFiles: ["README.md"],
      diffSummary: "README.md | 3 +++",
      fullDiff: "diff --git a/README.md b/README.md\n",
    });
    expect(
      findGitCallIndex((args) => args[0] === "diff" && args[1] === "--name-only" && args[2] === "origin/main"),
    ).toBe(-1);
  });

  it("tracks publish files from the branch diff even when the workflow change is already committed", () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "status") return "";
      if (args[0] === "diff" && args[1] === "--name-only") return ".github/workflows/workflow-lint.yml\n";
      if (args[0] === "diff" && args[1]?.startsWith("--stat")) return ".github/workflows/workflow-lint.yml | 1 +-\n";
      if (args[0] === "diff" && args[1] === "origin/main") {
        return "diff --git a/.github/workflows/workflow-lint.yml b/.github/workflows/workflow-lint.yml\n";
      }
      return "";
    });

    const { gitOps } = createGitOps({ getModifiedFiles: () => [] });

    const prep = gitOps.stageAndComputeDiffs(createLogger());

    expect(prep).toEqual({
      hasStagedFiles: false,
      stagedFiles: [],
      publishFiles: [".github/workflows/workflow-lint.yml"],
      diffStat: undefined,
      diffSummary: ".github/workflows/workflow-lint.yml | 1 +-",
      fullDiff: "diff --git a/.github/workflows/workflow-lint.yml b/.github/workflows/workflow-lint.yml\n",
      hasChanges: true,
    });
  });

  it("detects repo progress from either HEAD or porcelain changes", () => {
    const { gitOps } = createGitOps();

    expect(gitOps.didRepoProgress({ headSha: "abc123", porcelain: "" }, { headSha: "def456", porcelain: "" })).toBe(
      true,
    );
    expect(
      gitOps.didRepoProgress(
        { headSha: "abc123", porcelain: "" },
        { headSha: "abc123", porcelain: "M assets/sound.wav" },
      ),
    ).toBe(true);
    expect(gitOps.didRepoProgress({ headSha: undefined, porcelain: "" }, { headSha: "abc123", porcelain: "" })).toBe(
      false,
    );
  });

  it("switches to the session branch before committing when starting on the base branch", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main\n";
      if (args[0] === "show-ref") throw new Error("missing local branch");
      if (args[0] === "ls-remote") throw makeMissingRemoteBranchError();
      if (args[0] === "checkout" && args[1] === "-b") return "";
      if (args[0] === "commit") return "";
      if (args[0] === "remote") return "";
      if (args[0] === "push") return "";
      if (args[0] === "update-ref") return "";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "def456\n";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const { gitOps, sendEvent } = createGitOps();

    const result = await gitOps.commitAndPush(createLogger(), "msg-1", "Commit from sandbox");

    expect(result).toMatchObject({ branch: "session-work", commitSha: "def456" });
    // The push must advance refs/remotes/origin/<branch>: a session-created
    // branch is outside the single-branch clone's fetch refspec, so `git push`
    // alone never moves it and the next prompt's diff baseline would miss.
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      "git",
      ["update-ref", "refs/remotes/origin/session-work", "refs/heads/session-work"],
      expect.objectContaining({ cwd: "/repo" }),
    );
    expect(result?.agentTimeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "git.commit",
          status: "completed",
          metadata: expect.objectContaining({ committedAtMs: 1_700_000_000_000 }),
        }),
        expect.objectContaining({
          eventType: "git.push",
          status: "started",
          metadata: expect.objectContaining({ commitToPushStartMs: 0 }),
        }),
        expect.objectContaining({
          eventType: "git.push",
          status: "completed",
          metadata: expect.objectContaining({ commitToPushMs: 0, pushDurationMs: 0 }),
        }),
      ]),
    );
    expect(
      findGitCallIndex((args) => args[0] === "checkout" && args[1] === "-b" && args[2] === "session-work"),
    ).toBeLessThan(findGitCallIndex((args) => args[0] === "commit"));
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "push_complete",
        branchName: "session-work",
        messageId: "msg-1",
      }),
    );
    nowSpy.mockRestore();
  });

  it("primary commitAndPush uses --force-with-lease (never bare -f) when the tracking ref resolves", async () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main\n";
      if (args[0] === "show-ref") throw new Error("missing local branch");
      if (args[0] === "ls-remote") throw makeMissingRemoteBranchError();
      if (args[0] === "checkout" && args[1] === "-b") return "";
      if (args[0] === "commit") return "";
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "refs/remotes/origin/session-work")
        return "base123\n";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "def456\n";
      // HEAD descends from the remote head → ancestry gate passes, lease push proceeds.
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") return "";
      if (args[0] === "remote") return "";
      if (args[0] === "push") return "";
      if (args[0] === "update-ref") return "";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const { gitOps } = createGitOps();
    const result = await gitOps.commitAndPush(createLogger(), "msg-lease", "Commit from sandbox");

    expect(result).toMatchObject({ branch: "session-work" });
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      "git",
      [
        "push",
        "--no-verify",
        "-u",
        "origin",
        "HEAD:refs/heads/session-work",
        "--force-with-lease=refs/heads/session-work:base123",
      ],
      expect.objectContaining({ cwd: "/repo" }),
    );
    // The bare -f that used to clobber remote history is never emitted.
    expect(findGitCallIndex((args) => args[0] === "push" && args.includes("-f"))).toBe(-1);
  });

  it("primary commitAndPush fails closed (remote_branch_diverged) instead of clobbering a moved remote", async () => {
    let fetched = false;
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main\n";
      if (args[0] === "show-ref") throw new Error("missing local branch");
      if (args[0] === "ls-remote") throw makeMissingRemoteBranchError();
      if (args[0] === "checkout" && args[1] === "-b") return "";
      if (args[0] === "commit") return "";
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "refs/remotes/origin/session-work")
        return fetched ? "moved999\n" : "base123\n";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "def456\n";
      if (args[0] === "fetch") {
        fetched = true;
        return "";
      }
      // HEAD descends from the pre-fetch tracking ref (base123), so the up-front
      // ancestry gate passes and the leased push is attempted. After the stale
      // rejection + fetch, HEAD does NOT descend from the moved remote (moved999),
      // so refreshLeaseSha reports diverged.
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        if (args[2] === "moved999") throw new Error("not an ancestor");
        return "";
      }
      if (args[0] === "remote") return "";
      if (args[0] === "push") {
        const err = new Error("failed to push some refs") as Error & { stderr?: string };
        err.stderr = "! [rejected] session-work -> session-work (stale info)";
        throw err;
      }
      if (args[0] === "update-ref") return "";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const { gitOps, sendEvent, recordPushAttemptResolved } = createGitOps();
    const result = await gitOps.commitAndPush(createLogger(), "msg-diverged", "Commit from sandbox");

    // Fails closed: no clobber, undefined result, explicit diverged signal.
    expect(result).toBeUndefined();
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "push_error", error: "remote_branch_diverged", branchName: "session-work" }),
    );
    // The durable attempt is resolved so crash recovery does not synthesize a duplicate push_error.
    expect(recordPushAttemptResolved).toHaveBeenCalledWith({
      messageId: "msg-diverged",
      reason: "remote_branch_diverged",
    });
    expect(findGitCallIndex((args) => args[0] === "push" && args.includes("-f"))).toBe(-1);
  });

  it("primary commitAndPush fails closed when local HEAD does not descend from a current remote head (no clobber)", async () => {
    // The P1 case: the tracking ref is current (not moved), but the local branch
    // was reset/recreated from base so HEAD is unrelated to the remote PR head. A
    // bare --force-with-lease would still succeed (the lease only checks the
    // remote has not moved), clobbering the PR branch. The up-front ancestry gate
    // must abort BEFORE any push is attempted.
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main\n";
      if (args[0] === "show-ref") throw new Error("missing local branch");
      if (args[0] === "ls-remote") throw makeMissingRemoteBranchError();
      if (args[0] === "checkout" && args[1] === "-b") return "";
      if (args[0] === "commit") return "";
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "refs/remotes/origin/session-work")
        return "base123\n";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "unrelated789\n";
      // HEAD does not descend from the (current) remote head.
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") throw new Error("not an ancestor");
      if (args[0] === "remote") return "";
      if (args[0] === "update-ref") return "";
      if (args[0] === "push") throw new Error("push must not be attempted when HEAD is unrelated");
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const { gitOps, sendEvent, recordPushAttemptResolved } = createGitOps();
    const result = await gitOps.commitAndPush(createLogger(), "msg-unrelated", "Commit from sandbox");

    expect(result).toBeUndefined();
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "push_error", error: "remote_branch_diverged", branchName: "session-work" }),
    );
    expect(recordPushAttemptResolved).toHaveBeenCalledWith({
      messageId: "msg-unrelated",
      reason: "remote_branch_diverged",
    });
    // No push was attempted at all - the clobber was prevented up front.
    expect(findGitCallIndex((args) => args[0] === "push")).toBe(-1);
  });

  it("primary commitAndPush of a brand-new session branch pushes without bare -f", async () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main\n";
      if (args[0] === "show-ref") throw new Error("missing local branch");
      if (args[0] === "ls-remote") throw makeMissingRemoteBranchError();
      if (args[0] === "checkout" && args[1] === "-b") return "";
      if (args[0] === "commit") return "";
      // No remote-tracking ref yet (first push of a session-created branch).
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "refs/remotes/origin/session-work")
        throw new Error("unknown revision");
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "def456\n";
      if (args[0] === "remote") return "";
      if (args[0] === "push") return "";
      if (args[0] === "update-ref") return "";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const { gitOps } = createGitOps();
    const result = await gitOps.commitAndPush(createLogger(), "msg-new-branch", "Commit from sandbox");

    expect(result).toMatchObject({ branch: "session-work" });
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      "git",
      [
        "push",
        "--no-verify",
        "-u",
        "origin",
        "HEAD:refs/heads/session-work",
        "--force-with-lease=refs/heads/session-work:",
      ],
      expect.objectContaining({ cwd: "/repo" }),
    );
    expect(findGitCallIndex((args) => args[0] === "push" && args.includes("-f"))).toBe(-1);
  });

  it("primary commitAndPush renames and retries without a lease when the clean branch name is taken", async () => {
    const renamedBranch = appendCollisionSuffix("session-work", buildCycloidBranchCollisionSuffix("sess-1"));
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main\n";
      if (args[0] === "show-ref") throw new Error("missing local branch");
      if (args[0] === "ls-remote") throw makeMissingRemoteBranchError();
      if (args[0] === "checkout" && args[1] === "-b") return "";
      if (args[0] === "commit") return "";
      if (args[0] === "rev-parse" && args[1] === "--verify") throw new Error("unknown revision");
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "def456\n";
      if (args[0] === "remote") return "";
      if (args[0] === "branch" && args[1] === "-m" && args[2] === "session-work" && args[3] === renamedBranch)
        return "";
      if (args[0] === "push") {
        if (args[4] === "HEAD:refs/heads/session-work") {
          throw makePushRejection("! [rejected]        HEAD -> session-work (stale info)");
        }
        return "";
      }
      if (args[0] === "update-ref") return "";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const { gitOps, sendEvent } = createGitOps();
    const result = await gitOps.commitAndPush(createLogger(), "msg-collision", "Commit from sandbox");

    expect(result).toMatchObject({ branch: renamedBranch });
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      "git",
      ["branch", "-m", "session-work", renamedBranch],
      expect.objectContaining({ cwd: "/repo" }),
    );
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      "git",
      [
        "push",
        "--no-verify",
        "-u",
        "origin",
        `HEAD:refs/heads/${renamedBranch}`,
        `--force-with-lease=refs/heads/${renamedBranch}:`,
      ],
      expect.objectContaining({ cwd: "/repo" }),
    );
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "push_complete",
        branchName: renamedBranch,
        messageId: "msg-collision",
      }),
    );
  });

  it("renames from the current branch on a second branch-name collision", async () => {
    const renamedBranch0 = appendCollisionSuffix("session-work", buildCycloidBranchCollisionSuffix("sess-1", 0));
    const renamedBranch1 = appendCollisionSuffix("session-work", buildCycloidBranchCollisionSuffix("sess-1", 1));
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main\n";
      if (args[0] === "show-ref") throw new Error("missing local branch");
      if (args[0] === "ls-remote") throw makeMissingRemoteBranchError();
      if (args[0] === "checkout" && args[1] === "-b") return "";
      if (args[0] === "commit") return "";
      if (args[0] === "rev-parse" && args[1] === "--verify") throw new Error("unknown revision");
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "def456\n";
      if (args[0] === "remote") return "";
      if (args[0] === "branch" && args[1] === "-m") return "";
      if (args[0] === "push") {
        if (args[4] === "HEAD:refs/heads/session-work" || args[4] === `HEAD:refs/heads/${renamedBranch0}`) {
          throw makePushRejection(
            `! [rejected]        HEAD -> ${args[4].replace("HEAD:refs/heads/", "")} (stale info)`,
          );
        }
        return "";
      }
      if (args[0] === "update-ref") return "";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const { gitOps } = createGitOps();
    const result = await gitOps.commitAndPush(createLogger(), "msg-double-collision", "Commit from sandbox");

    expect(result).toMatchObject({ branch: renamedBranch1 });
    const renameCalls = mocks.execFileSync.mock.calls
      .filter(([cmd, args]: [string, string[]]) => cmd === "git" && args[0] === "branch" && args[1] === "-m")
      .map(([, args]: [string, string[]]) => args);
    expect(renameCalls).toEqual([
      ["branch", "-m", "session-work", renamedBranch0],
      ["branch", "-m", renamedBranch0, renamedBranch1],
    ]);
  });

  it("switches to the session branch before pushing even when there is no commit to create", async () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main\n";
      if (args[0] === "show-ref") throw new Error("missing local branch");
      if (args[0] === "ls-remote") throw makeMissingRemoteBranchError();
      if (args[0] === "checkout" && args[1] === "-b") return "";
      if (args[0] === "remote") return "";
      if (args[0] === "push") return "";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "abc123\n";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const { gitOps, sendEvent } = createGitOps();

    const result = await gitOps.commitAndPush(createLogger(), "msg-2");

    expect(result).toMatchObject({ branch: "session-work", commitSha: "abc123" });
    expect(findGitCallIndex((args) => args[0] === "commit")).toBe(-1);
    expect(
      findGitCallIndex((args) => args[0] === "checkout" && args[1] === "-b" && args[2] === "session-work"),
    ).toBeLessThan(
      findGitCallIndex((args) => args[0] === "push" && args.some((arg) => arg === "HEAD:refs/heads/session-work")),
    );
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "push_complete",
        branchName: "session-work",
        messageId: "msg-2",
      }),
    );
  });

  it("pushes existing agent commits when the sweep commit is rejected by a commit hook", async () => {
    const hookError = Object.assign(new Error("commit failed"), {
      stderr: "error: commit-msg hook rejected: subject must follow conventional commits\n",
      stdout: "",
      status: 1,
    });
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "feature/already-here\n";
      if (args[0] === "commit") throw hookError;
      if (args[0] === "rev-list" && args[1] === "--count" && args[2] === "origin/main..HEAD") return "2\n";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "agent456\n";
      if (args[0] === "remote") return "";
      if (args[0] === "push") return "";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const { gitOps, sendEvent } = createGitOps();

    const result = await gitOps.commitAndPush(createLogger(), "msg-sweep-fail", "Apply changes");

    expect(result).toMatchObject({ branch: "feature/already-here", commitSha: "agent456" });
    expect(result?.agentTimeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "git.commit",
          status: "failed",
          metadata: expect.objectContaining({ aheadOfBase: 2 }),
        }),
      ]),
    );
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "push_complete", branchName: "feature/already-here" }),
    );
    expect(sendEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "push_error" }));
  });

  it("still fails closed on a rejected sweep commit when there are no agent commits to push", async () => {
    const hookError = Object.assign(new Error("commit failed"), {
      stderr: "error: commit-msg hook rejected: subject must follow conventional commits\n",
      stdout: "",
      status: 1,
    });
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "feature/already-here\n";
      if (args[0] === "commit") throw hookError;
      if (args[0] === "rev-list" && args[1] === "--count") return "0\n";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const { gitOps, sendEvent } = createGitOps();

    const result = await gitOps.commitAndPush(createLogger(), "msg-sweep-fail-empty", "Apply changes");

    expect(result).toBeUndefined();
    expect(findGitCallIndex((args) => args[0] === "push")).toBe(-1);
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "push_error", branchName: "feature/already-here" }),
    );
  });

  it("stops before commit when it cannot create or switch to the session branch", async () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main\n";
      if (args[0] === "show-ref") throw new Error("missing local branch");
      if (args[0] === "ls-remote") throw makeMissingRemoteBranchError();
      if (args[0] === "checkout" && args[1] === "-b") throw new Error("branch already exists");
      if (args[0] === "checkout" && args[1] === "session-work") throw new Error("missing branch");
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const { gitOps, sendEvent } = createGitOps();

    const result = await gitOps.commitAndPush(createLogger(), "msg-3", "Commit from sandbox");

    expect(result).toBeUndefined();
    expect(findGitCallIndex((args) => args[0] === "commit")).toBe(-1);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("keeps the existing non-base branch without forcing a switch", async () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "feature/already-here\n";
      if (args[0] === "commit") return "";
      if (args[0] === "remote") return "";
      if (args[0] === "push") return "";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "ghi789\n";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const logger = createLogger();
    const { gitOps, sendEvent } = createGitOps();

    const result = await gitOps.commitAndPush(logger, "msg-4", "Commit from sandbox");

    expect(result).toMatchObject({ branch: "feature/already-here", commitSha: "ghi789" });
    expect(findGitCallIndex((args) => args[0] === "checkout")).toBe(-1);
    expect(logger.warn).toHaveBeenCalledWith(
      { currentBranch: "feature/already-here", effectiveBase: "main" },
      "Current branch differs from the expected base before session branch creation; keeping current branch",
    );
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "push_complete",
        branchName: "feature/already-here",
        messageId: "msg-4",
      }),
    );
  });

  it("does not warn about a non-base branch when the base cannot be resolved", () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "symbolic-ref") throw new Error("origin head missing");
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });
    const logger = createLogger();

    expect(
      ensureSessionBranch({
        cwd: "/repo",
        sessionId: "sess-1",
        currentBranch: "feature/already-here",
        promptLog: logger,
      }),
    ).toBe("feature/already-here");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("keeps a successful push when reading the post-push HEAD SHA fails", async () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "feature/already-here\n";
      if (args[0] === "commit") return "";
      if (args[0] === "remote") return "";
      if (args[0] === "push") return "";
      if (args[0] === "rev-parse" && args[1] === "HEAD") throw new Error("rev-parse unavailable");
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });
    const logger = createLogger();
    const { gitOps, sendEvent } = createGitOps();

    const result = await gitOps.commitAndPush(logger, "msg-post-push-head", "Commit from sandbox");

    expect(result).toMatchObject({ branch: "feature/already-here" });
    expect(result?.commitSha).toBeUndefined();
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "push_complete",
        branchName: "feature/already-here",
        messageId: "msg-post-push-head",
      }),
    );
    expect(sendEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "push_error" }));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: "feature/already-here",
        error: "Error: rev-parse unavailable",
      }),
      "Push succeeded but failed to read HEAD SHA",
    );
  });

  it("skips push and emits push_error when git commit fails", async () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main\n";
      if (args[0] === "show-ref") throw new Error("missing local branch");
      if (args[0] === "ls-remote") throw makeMissingRemoteBranchError();
      if (args[0] === "checkout" && args[1] === "-b") return "";
      if (args[0] === "commit") {
        throw Object.assign(new Error("Command failed: git commit -m Commit from sandbox"), {
          status: 1,
          stdout: "[STARTED] Running tasks for staged files...\n",
          stderr: "Running typecheck before commit...\nKilled\nhusky - pre-commit script failed (code 137)\n",
        });
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const { gitOps, sendEvent } = createGitOps();

    const result = await gitOps.commitAndPush(createLogger(), "msg-commit-failed", "Commit from sandbox");

    expect(result).toBeUndefined();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(findGitCallIndex((args) => args[0] === "remote")).toBe(-1);
    expect(findGitCallIndex((args) => args[0] === "push")).toBe(-1);
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "push_error",
        branchName: "session-work",
        messageId: "msg-commit-failed",
        error: expect.stringContaining("husky - pre-commit script failed (code 137)"),
      }),
    );
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "push_error",
        error: expect.stringContaining("[STARTED] Running tasks for staged files"),
      }),
    );
  });

  it("treats nothing to commit as a skipped commit and still pushes the branch", async () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main\n";
      if (args[0] === "show-ref") throw new Error("missing local branch");
      if (args[0] === "ls-remote") throw makeMissingRemoteBranchError();
      if (args[0] === "checkout" && args[1] === "-b") return "";
      if (args[0] === "commit") {
        throw Object.assign(new Error("Command failed: git commit -m Commit from sandbox"), {
          status: 1,
          stdout: "On branch session-work-sess-1\nnothing to commit, working tree clean\n",
          stderr:
            "[STARTED] Running tasks for staged files...\n[COMPLETED] Running tasks for staged files...\nhusky - pre-commit hook completed\n",
        });
      }
      if (args[0] === "remote") return "";
      if (args[0] === "push") return "";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "noop123\n";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const { gitOps, sendEvent } = createGitOps();

    const result = await gitOps.commitAndPush(createLogger(), "msg-noop", "Commit from sandbox");

    expect(result).toMatchObject({ branch: "session-work", commitSha: "noop123" });
    expect(
      mocks.execFileSync.mock.calls.filter(([cmd, args]: [string, string[]]) => cmd === "git" && args[0] === "push"),
    ).toHaveLength(1);
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "push_complete",
        branchName: "session-work",
        messageId: "msg-noop",
      }),
    );
    expect(sendEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "push_error" }));
  });

  it("treats nothing to commit as skipped when successful hook output reports zero failed checks", async () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main\n";
      if (args[0] === "show-ref") throw new Error("missing local branch");
      if (args[0] === "ls-remote") throw makeMissingRemoteBranchError();
      if (args[0] === "checkout" && args[1] === "-b") return "";
      if (args[0] === "commit") {
        throw Object.assign(new Error("Command failed: git commit -m Commit from sandbox"), {
          status: 1,
          stdout: "On branch session-work-sess-1\nnothing to commit, working tree clean\n",
          stderr:
            "[STARTED] Running tasks for staged files...\n12 passed, 0 failed\nhusky - pre-commit hook completed\n",
        });
      }
      if (args[0] === "remote") return "";
      if (args[0] === "push") return "";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "noop124\n";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const { gitOps, sendEvent } = createGitOps();

    const result = await gitOps.commitAndPush(createLogger(), "msg-noop-zero-failed", "Commit from sandbox");

    expect(result).toMatchObject({ branch: "session-work", commitSha: "noop124" });
    expect(
      mocks.execFileSync.mock.calls.filter(([cmd, args]: [string, string[]]) => cmd === "git" && args[0] === "push"),
    ).toHaveLength(1);
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "push_complete",
        branchName: "session-work",
        messageId: "msg-noop-zero-failed",
      }),
    );
    expect(sendEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "push_error" }));
  });

  it("does not treat nothing to commit as skipped when stderr reports a hook failure", async () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main\n";
      if (args[0] === "show-ref") throw new Error("missing local branch");
      if (args[0] === "ls-remote") throw makeMissingRemoteBranchError();
      if (args[0] === "checkout" && args[1] === "-b") return "";
      if (args[0] === "commit") {
        throw Object.assign(new Error("Command failed: git commit -m Commit from sandbox"), {
          status: 1,
          stdout: "On branch session-work-sess-1\nnothing to commit, working tree clean\n",
          stderr: "Running typecheck before commit...\nhusky - pre-commit script failed (code 137)\n",
        });
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const { gitOps, sendEvent } = createGitOps();

    const result = await gitOps.commitAndPush(createLogger(), "msg-noop-hook-failed", "Commit from sandbox");

    expect(result).toBeUndefined();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(findGitCallIndex((args) => args[0] === "remote")).toBe(-1);
    expect(findGitCallIndex((args) => args[0] === "push")).toBe(-1);
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "push_error",
        branchName: "session-work",
        messageId: "msg-noop-hook-failed",
        error: expect.stringContaining("husky - pre-commit script failed (code 137)"),
      }),
    );
  });

  it("does not treat hook output mentioning nothing to commit as a skipped commit", async () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main\n";
      if (args[0] === "show-ref") throw new Error("missing local branch");
      if (args[0] === "ls-remote") throw makeMissingRemoteBranchError();
      if (args[0] === "checkout" && args[1] === "-b") return "";
      if (args[0] === "commit") {
        throw Object.assign(new Error("Command failed: git commit -m Commit with nothing to commit in message"), {
          status: 1,
          stdout: "hook diagnostic: nothing to commit in generated report\n",
          stderr: "husky - pre-commit script failed\n",
        });
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const { gitOps, sendEvent } = createGitOps();

    const result = await gitOps.commitAndPush(
      createLogger(),
      "msg-false-positive",
      "Commit with nothing to commit in message",
    );

    expect(result).toBeUndefined();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(findGitCallIndex((args) => args[0] === "remote")).toBe(-1);
    expect(findGitCallIndex((args) => args[0] === "push")).toBe(-1);
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "push_error",
        branchName: "session-work",
        messageId: "msg-false-positive",
        error: expect.stringContaining("husky - pre-commit script failed"),
      }),
    );
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "push_error",
        error: expect.stringContaining("hook diagnostic: nothing to commit in generated report"),
      }),
    );
  });

  it("returns commit failure summaries with stderr, stdout, and tail preservation", () => {
    const largeStdout = ["first line", "x".repeat(4_100), "last stdout line"].join("\n");
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "commit") {
        throw Object.assign(new Error("Command failed: git commit -m Commit from sandbox"), {
          status: 137,
          stdout: largeStdout,
          stderr: "Killed\n",
        });
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const result = createCommit({
      cwd: "/repo",
      currentBranch: "session-work-sess-1",
      commitMessage: "Commit from sandbox",
      promptLog: createLogger(),
      recordTimeline: vi.fn(),
    });

    expect(result).toMatchObject({ status: "failed" });
    if (result.status !== "failed") throw new Error("Expected failed commit");
    expect(result.errorSummary).toContain("[truncated");
    expect(result.errorSummary).toContain("Killed");
    expect(result.errorSummary).toContain("last stdout line");
    expect(result.errorSummary).toContain("exit code 137");
    expect(result.errorSummary).not.toContain("first line");
  });

  it("does not duplicate an existing linked Cycloid co-author trailer", () => {
    process.env.GIT_AUTHOR_NAME = "Josiah P";
    process.env.GIT_AUTHOR_EMAIL = "12345+josiah@users.noreply.github.com";
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "commit") return "";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "abc123\n";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const result = createCommit({
      cwd: "/repo",
      currentBranch: "session-work-sess-1",
      commitMessage: `Commit from sandbox\n\n${CYCLOID_CO_AUTHOR_TRAILER}`,
      promptLog: createLogger(),
      recordTimeline: vi.fn(),
    });

    expect(result).toMatchObject({ status: "committed", commitSha: "abc123" });
    const commitCall = mocks.execFileSync.mock.calls.find(
      ([cmd, args]: [string, string[]]) => cmd === "git" && args[0] === "commit",
    );
    expect(commitCall?.[1][2]).toBe(`Commit from sandbox\n\n${CYCLOID_CO_AUTHOR_TRAILER}`);
  });

  it("appends the linked Cycloid co-author trailer to bridge-created commits", () => {
    process.env.GIT_AUTHOR_NAME = "Josiah P";
    process.env.GIT_AUTHOR_EMAIL = "12345+josiah@users.noreply.github.com";
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "commit") return "";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "abc123\n";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const result = createCommit({
      cwd: "/repo",
      currentBranch: "session-work-sess-1",
      commitMessage: "Commit from sandbox",
      promptLog: createLogger(),
      recordTimeline: vi.fn(),
    });

    expect(result).toMatchObject({ status: "committed", commitSha: "abc123" });
    const commitCall = mocks.execFileSync.mock.calls.find(
      ([cmd, args]: [string, string[]]) => cmd === "git" && args[0] === "commit",
    );
    expect(commitCall?.[1][2]).toBe(`Commit from sandbox\n\n${CYCLOID_CO_AUTHOR_TRAILER}`);
  });

  it("keeps push best-effort when timeline event emission fails", async () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main\n";
      if (args[0] === "show-ref") throw new Error("missing local branch");
      if (args[0] === "ls-remote") throw makeMissingRemoteBranchError();
      if (args[0] === "checkout" && args[1] === "-b") return "";
      if (args[0] === "remote") return "";
      if (args[0] === "push") return "";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "jkl012\n";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });
    const sendEvent = vi.fn((event: { type: string }) => {
      if (event.type === "agent_timeline") throw new Error("timeline emitter unavailable");
    });
    const logger = createLogger();
    const { gitOps } = createGitOps({ sendEvent });

    const result = await gitOps.commitAndPush(logger, "msg-6");

    expect(result).toMatchObject({ branch: "session-work", commitSha: "jkl012" });
    expect(
      mocks.execFileSync.mock.calls.filter(([cmd, args]: [string, string[]]) => cmd === "git" && args[0] === "push"),
    ).toHaveLength(1);
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "push_complete", messageId: "msg-6" }));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Error: timeline emitter unavailable",
        eventType: "git.push",
      }),
      "Failed to emit agent_timeline event",
    );
  });

  it("push helper refreshes the token and retries without staging or diff setup", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValueOnce(1_000).mockReturnValueOnce(1_200).mockReturnValueOnce(1_250);
    const sendEvent = vi.fn();
    const recordTimeline = vi.fn();
    const promptLog = createLogger();
    const fetchFreshCloneToken = vi.fn(async () => "fresh-token");
    let pushAttempt = 0;
    mocks.execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "sleep") return "";
      if (args[0] === "remote") return "";
      if (args[0] === "push") {
        pushAttempt++;
        if (pushAttempt === 1) throw Object.assign(new Error("spawnSync git ETIMEDOUT"), { stderr: "", stdout: "" });
        return "";
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const pushed = await pushSessionBranch({
      config: {
        cwd: "/repo",
        controlPlaneUrl: "https://control.example.com",
        getAuthToken: () => "token",
        sessionId: "sess-1",
        sandboxId: "sbx-1",
        baseBranch: "main",
        maxFullDiffBytes: 10_000,
        truncatedFullDiffBytes: 10_000,
        getModifiedFiles: () => [],
        sendEvent,
      },
      currentBranch: "feature/retry",
      messageId: "msg-8",
      promptLog,
      recordTimeline,
      commitCompletedAtMs: 1_000,
      fetchFreshCloneToken,
      delay: async () => undefined,
    });

    expect(pushed).toEqual({ ok: true });
    expect(fetchFreshCloneToken).toHaveBeenCalledTimes(1);
    expect(pushAttempt).toBe(2);
    expect(
      mocks.execFileSync.mock.calls.filter(([cmd, args]: [string, string[]]) => cmd === "git" && args[0] === "push"),
    ).toHaveLength(2);
    expect(findGitCallIndex((args) => args[0] === "status" || args[0] === "add" || args[0] === "diff")).toBe(-1);
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "push_complete",
        branchName: "feature/retry",
        messageId: "msg-8",
      }),
    );
    expect(recordTimeline).toHaveBeenNthCalledWith(
      1,
      "git.push",
      "started",
      "Started pushing the session branch to origin.",
      expect.objectContaining({ branch: "feature/retry", commitToPushStartMs: 0 }),
    );
    expect(recordTimeline).toHaveBeenNthCalledWith(
      2,
      "git.push",
      "completed",
      "Pushed the session branch to origin.",
      expect.objectContaining({ branch: "feature/retry", attempts: 2, commitToPushMs: 200, pushDurationMs: 200 }),
    );
    expect(promptLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "git.commit_to_push.completed",
        prompt_id: "msg-8",
        sessionId: "sess-1",
        branch: "feature/retry",
        commit_to_push_ms: 200,
        commit_to_push_start_ms: 0,
        push_duration_ms: 200,
        attempts: 2,
      }),
      "Commit-to-push latency recorded",
    );
    nowSpy.mockRestore();
  });

  it("does not record a push attempt before token refresh chooses a final branch", async () => {
    const sendEvent = vi.fn();
    const recordPushAttempt = vi.fn();
    const recordPushCheckpoint = vi.fn();
    const fetchFreshCloneToken = vi.fn(async () => {
      throw new CloneTokenError("clone-token request failed (403): forbidden", 403);
    });
    mocks.execFileSync.mockImplementation(() => "");

    const pushed = await pushSessionBranch({
      config: {
        cwd: "/repo",
        controlPlaneUrl: "https://control.example.com",
        getAuthToken: () => "token",
        sessionId: "sess-1",
        sandboxId: "sbx-1",
        baseBranch: "main",
        maxFullDiffBytes: 10_000,
        truncatedFullDiffBytes: 10_000,
        getModifiedFiles: () => [],
        sendEvent,
        recordPushAttempt,
        recordPushCheckpoint,
      },
      currentBranch: "feature/auth-403",
      messageId: "msg-attempt",
      promptLog: createLogger(),
      recordTimeline: vi.fn(),
      commitSha: "abc123",
      fetchFreshCloneToken,
      delay: async () => undefined,
    });

    expect(pushed).toEqual({ ok: false, reason: "other" });
    expect(fetchFreshCloneToken).toHaveBeenCalled();
    expect(recordPushAttempt).not.toHaveBeenCalled();
    expect(recordPushCheckpoint).not.toHaveBeenCalled();
  });

  it("resolves the push attempt durably on the session_not_active abort (no push_error)", async () => {
    const sendEvent = vi.fn();
    const recordPushAttempt = vi.fn();
    const recordPushAttemptResolved = vi.fn();
    const fetchFreshCloneToken = vi.fn(async () => {
      throw new CloneTokenError(
        'clone-token request failed (403): {"code":"sandbox_not_active"}',
        403,
        "sandbox_not_active",
      );
    });
    mocks.execFileSync.mockImplementation(() => "");

    const pushed = await pushSessionBranch({
      config: {
        cwd: "/repo",
        controlPlaneUrl: "https://control.example.com",
        getAuthToken: () => "token",
        sessionId: "sess-1",
        sandboxId: "sbx-1",
        baseBranch: "main",
        maxFullDiffBytes: 10_000,
        truncatedFullDiffBytes: 10_000,
        getModifiedFiles: () => [],
        sendEvent,
        recordPushAttempt,
        recordPushAttemptResolved,
      },
      currentBranch: "feature/stopped",
      messageId: "msg-stopped",
      promptLog: createLogger(),
      recordTimeline: vi.fn(),
      commitSha: "abc1234",
      fetchFreshCloneToken,
      delay: async () => undefined,
    });

    expect(pushed).toEqual({ ok: false, reason: "other" });
    // The live path suppresses push_error for a stopped session...
    expect(sendEvent).not.toHaveBeenCalled();
    // ...and resolves any durable attempt from an older bridge without creating
    // a stale attempt for this token-refresh-only abort.
    expect(recordPushAttempt).not.toHaveBeenCalled();
    expect(recordPushAttemptResolved).toHaveBeenCalledWith({
      messageId: "msg-stopped",
      reason: "session_not_active",
    });
  });

  it("resolves the push attempt on the auth abort while still emitting push_error", async () => {
    const sendEvent = vi.fn();
    const recordPushAttempt = vi.fn();
    const recordPushAttemptResolved = vi.fn();
    const fetchFreshCloneToken = vi.fn(async () => {
      throw new CloneTokenError("clone-token request failed (403): forbidden", 403);
    });
    mocks.execFileSync.mockImplementation(() => "");

    const pushed = await pushSessionBranch({
      config: {
        cwd: "/repo",
        controlPlaneUrl: "https://control.example.com",
        getAuthToken: () => "token",
        sessionId: "sess-1",
        sandboxId: "sbx-1",
        baseBranch: "main",
        maxFullDiffBytes: 10_000,
        truncatedFullDiffBytes: 10_000,
        getModifiedFiles: () => [],
        sendEvent,
        recordPushAttempt,
        recordPushAttemptResolved,
      },
      currentBranch: "feature/auth-403",
      messageId: "msg-auth",
      promptLog: createLogger(),
      recordTimeline: vi.fn(),
      commitSha: "abc123",
      fetchFreshCloneToken,
      delay: async () => undefined,
    });

    expect(pushed).toEqual({ ok: false, reason: "other" });
    // The live push_error is still the terminal outcome...
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "push_error", error: "clone_token_auth_failed", branchName: "feature/auth-403" }),
    );
    // ...and any older durable attempt is resolved so crash recovery does not synthesize a second one.
    expect(recordPushAttempt).not.toHaveBeenCalled();
    expect(recordPushAttemptResolved).toHaveBeenCalledWith({
      messageId: "msg-auth",
      reason: "clone_token_auth_failed",
    });
  });

  it("resolves the push attempt on the refresh abort (null token) while still emitting push_error", async () => {
    const sendEvent = vi.fn();
    const recordPushAttempt = vi.fn();
    const recordPushAttemptResolved = vi.fn();
    const fetchFreshCloneToken = vi.fn(async () => null);
    mocks.execFileSync.mockImplementation(() => "");

    const pushed = await pushSessionBranch({
      config: {
        cwd: "/repo",
        controlPlaneUrl: "https://control.example.com",
        getAuthToken: () => "token",
        sessionId: "sess-1",
        sandboxId: "sbx-1",
        baseBranch: "main",
        maxFullDiffBytes: 10_000,
        truncatedFullDiffBytes: 10_000,
        getModifiedFiles: () => [],
        sendEvent,
        recordPushAttempt,
        recordPushAttemptResolved,
      },
      currentBranch: "feature/no-token",
      messageId: "msg-refresh",
      promptLog: createLogger(),
      recordTimeline: vi.fn(),
      commitSha: "abc123",
      fetchFreshCloneToken,
      delay: async () => undefined,
    });

    expect(pushed).toEqual({ ok: false, reason: "other" });
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "push_error",
        error: "clone_token_refresh_failed",
        branchName: "feature/no-token",
      }),
    );
    expect(recordPushAttempt).not.toHaveBeenCalled();
    expect(recordPushAttemptResolved).toHaveBeenCalledWith({
      messageId: "msg-refresh",
      reason: "clone_token_refresh_failed",
    });
  });

  it("records both the attempt and the success checkpoint on a successful push", async () => {
    const sendEvent = vi.fn();
    const recordPushAttempt = vi.fn();
    const recordPushCheckpoint = vi.fn();
    mocks.execFileSync.mockImplementation(() => "");

    const pushed = await pushSessionBranch({
      config: {
        cwd: "/repo",
        controlPlaneUrl: "https://control.example.com",
        getAuthToken: () => "token",
        sessionId: "sess-1",
        sandboxId: "sbx-1",
        baseBranch: "main",
        maxFullDiffBytes: 10_000,
        truncatedFullDiffBytes: 10_000,
        getModifiedFiles: () => [],
        sendEvent,
        recordPushAttempt,
        recordPushCheckpoint,
      },
      currentBranch: "feature/ok",
      messageId: "msg-ok",
      promptLog: createLogger(),
      recordTimeline: vi.fn(),
      commitSha: "abc123",
      fetchFreshCloneToken: vi.fn(async () => "fresh-token"),
      delay: async () => undefined,
    });

    expect(pushed).toEqual({ ok: true });
    expect(recordPushAttempt).toHaveBeenCalledWith({
      messageId: "msg-ok",
      branch: "feature/ok",
      commitSha: "abc123",
    });
    expect(recordPushCheckpoint).toHaveBeenCalledWith({
      messageId: "msg-ok",
      branch: "feature/ok",
      commitSha: "abc123",
    });
  });

  it("aborts the push and emits push_error when the clone-token is rejected with 403", async () => {
    const sendEvent = vi.fn();
    const recordTimeline = vi.fn();
    const fetchFreshCloneToken = vi.fn(async () => {
      throw new CloneTokenError("clone-token request failed (403): forbidden", 403);
    });
    mocks.execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "push") throw new Error("push must not be attempted with a stale token");
      return "";
    });

    const pushed = await pushSessionBranch({
      config: {
        cwd: "/repo",
        controlPlaneUrl: "https://control.example.com",
        getAuthToken: () => "token",
        sessionId: "sess-1",
        sandboxId: "sbx-1",
        baseBranch: "main",
        maxFullDiffBytes: 10_000,
        truncatedFullDiffBytes: 10_000,
        getModifiedFiles: () => [],
        sendEvent,
      },
      currentBranch: "feature/auth-403",
      messageId: "msg-403",
      promptLog: createLogger(),
      recordTimeline,
      fetchFreshCloneToken,
      delay: async () => undefined,
    });

    expect(pushed).toEqual({ ok: false, reason: "other" });
    // Retries the token fetch (auth is retryable) before giving up.
    expect(fetchFreshCloneToken).toHaveBeenCalledTimes(6);
    // Never pushes with a stale URL.
    expect(
      mocks.execFileSync.mock.calls.filter(([cmd, args]: [string, string[]]) => cmd === "git" && args[0] === "push"),
    ).toHaveLength(0);
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "push_error",
        branchName: "feature/auth-403",
        error: "clone_token_auth_failed",
      }),
    );
    expect(recordTimeline).toHaveBeenCalledWith(
      "git.push",
      "failed",
      expect.any(String),
      expect.objectContaining({ reason: "clone_token_auth_failed" }),
    );
  });

  it("fails fast without push_error when the clone-token 403 carries sandbox_not_active", async () => {
    const sendEvent = vi.fn();
    const recordTimeline = vi.fn();
    const promptLog = createLogger();
    // Exercise the real fetchCloneToken default (no fetchFreshCloneToken
    // override) so the structured-code parse of the 403 body is covered.
    mocks.fetch.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ ok: false, error: "Sandbox not active", code: "sandbox_not_active" }),
    } as Response);
    mocks.execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "push") throw new Error("push must not be attempted after a lifecycle 403");
      return "";
    });

    const pushed = await pushSessionBranch({
      config: {
        cwd: "/repo",
        controlPlaneUrl: "https://control.example.com",
        getAuthToken: () => "token",
        sessionId: "sess-1",
        sandboxId: "sbx-1",
        baseBranch: "main",
        maxFullDiffBytes: 10_000,
        truncatedFullDiffBytes: 10_000,
        getModifiedFiles: () => [],
        sendEvent,
      },
      currentBranch: "feature/session-stopped",
      messageId: "msg-stopped",
      promptLog,
      recordTimeline,
      delay: async () => undefined,
    });

    expect(pushed).toEqual({ ok: false, reason: "other" });
    // A lifecycle 403 is permanent: no token retries, no push attempts.
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(
      mocks.execFileSync.mock.calls.filter(([cmd, args]: [string, string[]]) => cmd === "git" && args[0] === "push"),
    ).toHaveLength(0);
    // No push_error: the session DO treats it as a terminal publish failure
    // and would re-run the stop boundary on an already-stopped session.
    expect(sendEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "push_error" }));
    expect(recordTimeline).toHaveBeenCalledWith(
      "git.push",
      "failed",
      expect.any(String),
      expect.objectContaining({ reason: "session_not_active" }),
    );
    expect(promptLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "feature/session-stopped" }),
      "clone-token refresh rejected: session no longer active; skipping push",
    );
    expect(promptLog.error).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("clone-token auth persistently rejected"),
    );
  });

  it("treats a 403 with a non-JSON body as a real auth rejection", async () => {
    const sendEvent = vi.fn();
    const recordTimeline = vi.fn();
    mocks.fetch.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "<html>forbidden</html>",
    } as Response);
    mocks.execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "push") throw new Error("push must not be attempted with a stale token");
      return "";
    });

    const pushed = await pushSessionBranch({
      config: {
        cwd: "/repo",
        controlPlaneUrl: "https://control.example.com",
        getAuthToken: () => "token",
        sessionId: "sess-1",
        sandboxId: "sbx-1",
        baseBranch: "main",
        maxFullDiffBytes: 10_000,
        truncatedFullDiffBytes: 10_000,
        getModifiedFiles: () => [],
        sendEvent,
      },
      currentBranch: "feature/proxy-403",
      messageId: "msg-proxy-403",
      promptLog: createLogger(),
      recordTimeline,
      delay: async () => undefined,
    });

    expect(pushed).toEqual({ ok: false, reason: "other" });
    // The defensive body parse finds no code, so the existing auth-rejection
    // behavior applies: retried to the cap, then aborted with push_error.
    expect(mocks.fetch).toHaveBeenCalledTimes(6);
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "push_error",
        branchName: "feature/proxy-403",
        error: "clone_token_auth_failed",
      }),
    );
  });

  it("retries clone-token refresh on timeout and pushes once it succeeds", async () => {
    const sendEvent = vi.fn();
    const fetchFreshCloneToken = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("clone-token request timed out after 10000ms"))
      .mockResolvedValueOnce("fresh-token");
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "remote" || args[0] === "push") return "";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const pushed = await pushSessionBranch({
      config: {
        cwd: "/repo",
        controlPlaneUrl: "https://control.example.com",
        getAuthToken: () => "token",
        sessionId: "sess-1",
        sandboxId: "sbx-1",
        baseBranch: "main",
        maxFullDiffBytes: 10_000,
        truncatedFullDiffBytes: 10_000,
        getModifiedFiles: () => [],
        sendEvent,
      },
      currentBranch: "feature/net",
      messageId: "msg-net",
      promptLog: createLogger(),
      recordTimeline: vi.fn(),
      fetchFreshCloneToken,
      delay: async () => undefined,
    });

    expect(pushed).toEqual({ ok: true });
    expect(fetchFreshCloneToken).toHaveBeenCalledTimes(2);
    const remoteCalls = mocks.execFileSync.mock.calls.filter(
      ([cmd, args]: [string, string[]]) => cmd === "git" && args[0] === "remote",
    );
    // Push URL carries the fresh token, then the finally block re-scrubs origin.
    expect(remoteCalls[0]?.[1][3]).toContain("x-access-token:fresh-token");
    expect(remoteCalls[remoteCalls.length - 1]?.[1][3]).not.toContain("x-access-token");
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "push_complete", branchName: "feature/net" }),
    );
    expect(sendEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "push_error" }));
  });

  it("retries transient clone-token refresh failures through the sixth attempt", async () => {
    const sendEvent = vi.fn();
    const fetchFreshCloneToken = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new CloneTokenError("clone-token request failed (500): Internal server error", 500))
      .mockRejectedValueOnce(new CloneTokenError("clone-token request failed (500): Internal server error", 500))
      .mockRejectedValueOnce(new CloneTokenError("clone-token request failed (500): Internal server error", 500))
      .mockRejectedValueOnce(new CloneTokenError("clone-token request failed (500): Internal server error", 500))
      .mockRejectedValueOnce(new CloneTokenError("clone-token request failed (500): Internal server error", 500))
      .mockResolvedValueOnce("fresh-token");
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "remote" || args[0] === "push" || args[0] === "update-ref") return "";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const pushed = await pushSessionBranch({
      config: {
        cwd: "/repo",
        controlPlaneUrl: "https://control.example.com",
        getAuthToken: () => "token",
        sessionId: "sess-1",
        sandboxId: "sbx-1",
        baseBranch: "main",
        maxFullDiffBytes: 10_000,
        truncatedFullDiffBytes: 10_000,
        getModifiedFiles: () => [],
        sendEvent,
      },
      currentBranch: "feature/token-retry",
      messageId: "msg-token-retry",
      promptLog: createLogger(),
      recordTimeline: vi.fn(),
      fetchFreshCloneToken,
      delay: async () => undefined,
    });

    expect(pushed).toEqual({ ok: true });
    expect(fetchFreshCloneToken).toHaveBeenCalledTimes(6);
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "push_complete", branchName: "feature/token-retry" }),
    );
    expect(sendEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "push_error" }));
  });

  it("aborts with clone_token_refresh_failed when every refresh attempt times out", async () => {
    const sendEvent = vi.fn();
    const recordTimeline = vi.fn();
    const fetchFreshCloneToken = vi.fn(async () => {
      throw new Error("clone-token request timed out after 10000ms");
    });
    mocks.execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "push") throw new Error("push must not be attempted without a fresh token");
      return "";
    });

    const pushed = await pushSessionBranch({
      config: {
        cwd: "/repo",
        controlPlaneUrl: "https://control.example.com",
        getAuthToken: () => "token",
        sessionId: "sess-1",
        sandboxId: "sbx-1",
        baseBranch: "main",
        maxFullDiffBytes: 10_000,
        truncatedFullDiffBytes: 10_000,
        getModifiedFiles: () => [],
        sendEvent,
      },
      currentBranch: "feature/timeout",
      messageId: "msg-timeout",
      promptLog: createLogger(),
      recordTimeline,
      fetchFreshCloneToken,
      delay: async () => undefined,
    });

    expect(pushed).toEqual({ ok: false, reason: "other" });
    // Timeout is transient: retried up to the attempt cap.
    expect(fetchFreshCloneToken).toHaveBeenCalledTimes(6);
    expect(
      mocks.execFileSync.mock.calls.filter(([cmd, args]: [string, string[]]) => cmd === "git" && args[0] === "push"),
    ).toHaveLength(0);
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "push_error",
        branchName: "feature/timeout",
        error: "clone_token_refresh_failed",
      }),
    );
    expect(recordTimeline).toHaveBeenCalledWith(
      "git.push",
      "failed",
      expect.any(String),
      expect.objectContaining({ reason: "clone_token_refresh_failed" }),
    );
  });

  it("aborts with clone_token_refresh_failed after six transient 500 clone-token failures", async () => {
    const sendEvent = vi.fn();
    const recordTimeline = vi.fn();
    const fetchFreshCloneToken = vi.fn(async () => {
      throw new CloneTokenError("clone-token request failed (500): Internal server error", 500);
    });
    mocks.execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "push") throw new Error("push must not be attempted without a fresh token");
      return "";
    });

    const pushed = await pushSessionBranch({
      config: {
        cwd: "/repo",
        controlPlaneUrl: "https://control.example.com",
        getAuthToken: () => "token",
        sessionId: "sess-1",
        sandboxId: "sbx-1",
        baseBranch: "main",
        maxFullDiffBytes: 10_000,
        truncatedFullDiffBytes: 10_000,
        getModifiedFiles: () => [],
        sendEvent,
      },
      currentBranch: "feature/token-500",
      messageId: "msg-token-500",
      promptLog: createLogger(),
      recordTimeline,
      fetchFreshCloneToken,
      delay: async () => undefined,
    });

    expect(pushed).toEqual({ ok: false, reason: "other" });
    expect(fetchFreshCloneToken).toHaveBeenCalledTimes(6);
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "push_error",
        branchName: "feature/token-500",
        error: "clone_token_refresh_failed",
      }),
    );
    expect(recordTimeline).toHaveBeenCalledWith(
      "git.push",
      "failed",
      expect.any(String),
      expect.objectContaining({ reason: "clone_token_refresh_failed" }),
    );
  });

  it("keeps the auth-failure label when a transient error follows a 401/403 rejection", async () => {
    const sendEvent = vi.fn();
    const recordTimeline = vi.fn();
    const fetchFreshCloneToken = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new CloneTokenError("clone-token request failed (401): unauthorized", 401))
      .mockRejectedValue(new Error("clone-token request timed out after 10000ms"));
    mocks.execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "push") throw new Error("push must not be attempted without a fresh token");
      return "";
    });

    const pushed = await pushSessionBranch({
      config: {
        cwd: "/repo",
        controlPlaneUrl: "https://control.example.com",
        getAuthToken: () => "token",
        sessionId: "sess-1",
        sandboxId: "sbx-1",
        baseBranch: "main",
        maxFullDiffBytes: 10_000,
        truncatedFullDiffBytes: 10_000,
        getModifiedFiles: () => [],
        sendEvent,
      },
      currentBranch: "feature/auth-then-timeout",
      messageId: "msg-auth-timeout",
      promptLog: createLogger(),
      recordTimeline,
      fetchFreshCloneToken,
      delay: async () => undefined,
    });

    expect(pushed).toEqual({ ok: false, reason: "other" });
    expect(fetchFreshCloneToken).toHaveBeenCalledTimes(6);
    // The 401 on attempt 1 is the meaningful signal; later timeouts must not
    // relabel the abort as a generic refresh failure.
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "push_error",
        branchName: "feature/auth-then-timeout",
        error: "clone_token_auth_failed",
      }),
    );
  });

  it("does not retry a permanent non-auth 4xx clone-token failure", async () => {
    const sendEvent = vi.fn();
    const recordTimeline = vi.fn();
    const fetchFreshCloneToken = vi.fn(async () => {
      throw new CloneTokenError("clone-token request failed (400): No installation_id for session", 400);
    });
    mocks.execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "push") throw new Error("push must not be attempted without a fresh token");
      return "";
    });

    const pushed = await pushSessionBranch({
      config: {
        cwd: "/repo",
        controlPlaneUrl: "https://control.example.com",
        getAuthToken: () => "token",
        sessionId: "sess-1",
        sandboxId: "sbx-1",
        baseBranch: "main",
        maxFullDiffBytes: 10_000,
        truncatedFullDiffBytes: 10_000,
        getModifiedFiles: () => [],
        sendEvent,
      },
      currentBranch: "feature/400",
      messageId: "msg-400",
      promptLog: createLogger(),
      recordTimeline,
      fetchFreshCloneToken,
      delay: async () => undefined,
    });

    expect(pushed).toEqual({ ok: false, reason: "other" });
    // Permanent 4xx: fail fast, no retries.
    expect(fetchFreshCloneToken).toHaveBeenCalledTimes(1);
    expect(
      mocks.execFileSync.mock.calls.filter(([cmd, args]: [string, string[]]) => cmd === "git" && args[0] === "push"),
    ).toHaveLength(0);
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "push_error",
        branchName: "feature/400",
        error: "clone_token_refresh_failed",
      }),
    );
  });

  it("uses deterministic exponential backoff between clone-token retries", async () => {
    const delay = vi.fn(async () => undefined);
    const fetchFreshCloneToken = vi.fn(async () => {
      throw new CloneTokenError("clone-token request failed (500): Internal server error", 500);
    });
    mocks.execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "push") throw new Error("push must not be attempted without a fresh token");
      return "";
    });

    const pushed = await pushSessionBranch({
      config: {
        cwd: "/repo",
        controlPlaneUrl: "https://control.example.com",
        getAuthToken: () => "token",
        sessionId: "sess-1",
        sandboxId: "sbx-1",
        baseBranch: "main",
        maxFullDiffBytes: 10_000,
        truncatedFullDiffBytes: 10_000,
        getModifiedFiles: () => [],
        sendEvent: vi.fn(),
      },
      currentBranch: "feature/token-backoff",
      messageId: "msg-token-backoff",
      promptLog: createLogger(),
      recordTimeline: vi.fn(),
      fetchFreshCloneToken,
      delay,
    });

    expect(pushed).toEqual({ ok: false, reason: "other" });
    expect(fetchFreshCloneToken).toHaveBeenCalledTimes(6);
    expect(delay.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
  });

  it("re-scrubs the origin remote even when the push itself fails", async () => {
    const sendEvent = vi.fn();
    const fetchFreshCloneToken = vi.fn(async () => "fresh-token");
    mocks.execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "push") {
        throw Object.assign(new Error("spawnSync git ETIMEDOUT"), { stderr: "", stdout: "" });
      }
      return "";
    });

    const pushed = await pushSessionBranch({
      config: {
        cwd: "/repo",
        controlPlaneUrl: "https://control.example.com",
        getAuthToken: () => "token",
        sessionId: "sess-1",
        sandboxId: "sbx-1",
        baseBranch: "main",
        maxFullDiffBytes: 10_000,
        truncatedFullDiffBytes: 10_000,
        getModifiedFiles: () => [],
        sendEvent,
      },
      currentBranch: "feature/rescrub",
      messageId: "msg-rescrub",
      promptLog: createLogger(),
      recordTimeline: vi.fn(),
      fetchFreshCloneToken,
      delay: async () => undefined,
    });

    expect(pushed).toEqual({ ok: false, reason: "other" });
    const remoteCalls = mocks.execFileSync.mock.calls.filter(
      ([cmd, args]: [string, string[]]) => cmd === "git" && args[0] === "remote",
    );
    expect(remoteCalls.length).toBeGreaterThanOrEqual(2);
    expect(remoteCalls[0]?.[1][3]).toContain("x-access-token:fresh-token");
    // The last remote rewrite leaves no credential in git config.
    expect(remoteCalls[remoteCalls.length - 1]?.[1][3]).not.toContain("x-access-token");
  });

  it("retries transient push failures through the fifth attempt", async () => {
    const sendEvent = vi.fn();
    const delay = vi.fn(async () => undefined);
    const fetchFreshCloneToken = vi.fn(async () => "fresh-token");
    let pushCalls = 0;
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "remote" || args[0] === "update-ref") return "";
      if (args[0] === "push") {
        pushCalls += 1;
        if (pushCalls < 5) {
          throw Object.assign(new Error("spawnSync git ETIMEDOUT"), { stderr: "", stdout: "" });
        }
        return "";
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const pushed = await pushSessionBranch({
      config: {
        cwd: "/repo",
        controlPlaneUrl: "https://control.example.com",
        getAuthToken: () => "token",
        sessionId: "sess-1",
        sandboxId: "sbx-1",
        baseBranch: "main",
        maxFullDiffBytes: 10_000,
        truncatedFullDiffBytes: 10_000,
        getModifiedFiles: () => [],
        sendEvent,
      },
      currentBranch: "feature/push-retry",
      messageId: "msg-push-retry",
      promptLog: createLogger(),
      recordTimeline: vi.fn(),
      fetchFreshCloneToken,
      delay,
    });

    expect(pushed).toEqual({ ok: true });
    expect(pushCalls).toBe(5);
    expect(delay.mock.calls.map(([ms]) => ms)).toEqual([2_000, 4_000, 8_000, 16_000]);
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "push_complete", branchName: "feature/push-retry" }),
    );
  });

  it("does not rewrite non-timeout clone-token abort errors as timeouts", async () => {
    mocks.fetch.mockRejectedValue(new DOMException("manually aborted", "AbortError"));
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "feature/already-here\n";
      if (args[0] === "push") return "";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "mno345\n";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });
    const logger = createLogger();
    const { gitOps } = createGitOps();

    const result = await gitOps.commitAndPush(logger, "msg-7");

    // Refresh failure now aborts the push instead of pushing with a scrubbed remote.
    expect(result).toBeUndefined();
    const warnFields = logger.warn.mock.calls
      .map((call: unknown[]) => call[0] as { error?: string })
      .find((fields) => fields?.error?.includes("AbortError"));
    expect(warnFields?.error).toContain("AbortError");
    expect(warnFields?.error).not.toContain("timed out");
  });

  it("emits push_error with the actual branch after exhausting push retries", async () => {
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (_cmd === "sleep") return "";
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main\n";
      if (args[0] === "show-ref") throw new Error("missing local branch");
      if (args[0] === "ls-remote") throw makeMissingRemoteBranchError();
      if (args[0] === "checkout" && args[1] === "-b") return "";
      if (args[0] === "commit") return "";
      if (args[0] === "remote") return "";
      if (args[0] === "push") throw Object.assign(new Error("spawnSync git ETIMEDOUT"), { stderr: "", stdout: "" });
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const { gitOps, sendEvent } = createGitOps();

    const result = await gitOps.commitAndPush(createLogger(), "msg-5", "Commit from sandbox");

    expect(result).toBeUndefined();
    expect(
      mocks.execFileSync.mock.calls.filter(([cmd, args]: [string, string[]]) => cmd === "git" && args[0] === "push"),
    ).toHaveLength(5);
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "push_error",
        branchName: "session-work",
        messageId: "msg-5",
        error: expect.stringContaining("ETIMEDOUT"),
      }),
    );
  });

  it("primary commitAndPush surfaces workflow-permission push rejections without retrying", async () => {
    const delay = vi.fn(async () => undefined);
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main\n";
      if (args[0] === "show-ref") throw new Error("missing local branch");
      if (args[0] === "ls-remote") throw makeMissingRemoteBranchError();
      if (args[0] === "checkout" && args[1] === "-b") return "";
      if (args[0] === "commit") return "";
      if (args[0] === "rev-parse" && args[1] === "--verify") throw new Error("missing tracking ref");
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "def456\n";
      if (args[0] === "remote") return "";
      if (args[0] === "push") throw makeWorkflowsPermissionPushError();
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const { gitOps, sendEvent, recordPushAttemptResolved } = createGitOps({ pushDelay: delay });

    const result = await gitOps.commitAndPush(createLogger(), "msg-primary-workflows", "Commit from sandbox");

    expect(result).toBeUndefined();
    expect(
      mocks.execFileSync.mock.calls.filter(([cmd, args]: [string, string[]]) => cmd === "git" && args[0] === "push"),
    ).toHaveLength(1);
    expect(delay).not.toHaveBeenCalled();
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "push_error",
        branchName: "session-work",
        messageId: "msg-primary-workflows",
        error: expect.stringContaining("`.github/workflows/check-db-migration-sql.yaml` requires"),
      }),
    );
    expect(recordPushAttemptResolved).toHaveBeenCalledWith({
      messageId: "msg-primary-workflows",
      reason: "workflows_permission_required",
    });
  });

  it("verifier commitAndPushCurrentBranch surfaces workflow-permission push rejections without retrying", async () => {
    const delay = vi.fn(async () => undefined);
    mocks.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "feature/pr-head\n";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "def456\n";
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "refs/remotes/origin/feature/pr-head")
        return "base123\n";
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") return "";
      if (args[0] === "commit") return "";
      if (args[0] === "remote") return "";
      if (args[0] === "push") throw makeWorkflowsPermissionPushError();
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const { gitOps, sendEvent, recordPushAttemptResolved } = createGitOps({ pushDelay: delay });

    const result = await gitOps.commitAndPushCurrentBranch(createLogger(), "msg-verifier-workflows", {
      expectedBranch: "feature/pr-head",
      commitMessage: "Apply verifier fixes",
    });

    expect(result).toMatchObject({ ok: false, branch: "feature/pr-head", reason: "push_failed" });
    expect(
      mocks.execFileSync.mock.calls.filter(([cmd, args]: [string, string[]]) => cmd === "git" && args[0] === "push"),
    ).toHaveLength(1);
    expect(delay).not.toHaveBeenCalled();
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "push_error",
        branchName: "feature/pr-head",
        messageId: "msg-verifier-workflows",
        error: expect.stringContaining("`.github/workflows/check-db-migration-sql.yaml` requires"),
      }),
    );
    expect(recordPushAttemptResolved).toHaveBeenCalledWith({
      messageId: "msg-verifier-workflows",
      reason: "workflows_permission_required",
    });
  });
});
