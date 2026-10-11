import { getValidGithubToken } from "../auth/db";
import { ARCANIST_SCHEDULED_LABEL, CYCLOID_PR_LABEL, CYCLOID_PROVENANCE_LABELS } from "../constants/pr-labels";
import { createInstallationToken } from "../github/octokit";
import {
  addLabels,
  closePullRequest,
  createIssueComment,
  createPullRequest,
  deleteIssueComment,
  ensureRepoLabel,
  findOpenPrByHead,
  getBranchHeadSha,
  getDefaultBranch,
  getPrDraftState,
  getPrMergeStatus,
  getPrOverview,
  getPrReviewComments,
  getPullRequestTitle,
  listLabels,
  listPrIssueCommentsDetailed,
  listPrReviews,
  markPullRequestReadyForReview,
  type PrIssueComment,
  type PrOverview,
  type PrResult,
  type PrReview,
  removeLabel,
  reopenPullRequest,
  updateIssueComment,
  updatePullRequest,
} from "../github/pr";
import { parseGithubPullRequestUrl } from "../github/verification-pr-context";
import type { Logger } from "../logger";
import type { Env } from "../types";
import * as doDb from "./do-db.js";
import { resolveAttachedPrNumber } from "./pr-number";

export type SessionPrWorkflowExt = NonNullable<ReturnType<typeof doDb.getSessionExtended>>;

export type ResolvedPrUpdateContext = {
  sessionId: string;
  token: string;
  tokenSource: "user" | "installation";
  installationId?: number;
  installationToken: string | null;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
  ext: SessionPrWorkflowExt | null;
};

export type ResolvePrTargetResult =
  | { ok: true; context: ResolvedPrUpdateContext }
  | { ok: false; reason: "invalid" | "no_pr" | "forbidden" | "error"; message: string };

// Caps keep the aggregated read_pr payload within a sane tool-result budget; truncation is surfaced
// in the payload so the agent knows the thread continued beyond what was returned.
const READ_PR_MAX_ISSUE_COMMENTS = 100;
const READ_PR_MAX_REVIEW_COMMENTS = 100;
const READ_PR_MAX_REVIEWS = 50;

export type PrReviewCommentSummary = {
  id: number | null;
  author: string;
  path: string;
  line: number | null;
  body: string;
  reviewId: number | null;
  inReplyToId: number | null;
};

export type ReadPrContents = {
  overview: PrOverview;
  issueComments: PrIssueComment[];
  reviewComments: PrReviewCommentSummary[];
  reviews: PrReview[];
  truncated: {
    issueComments: boolean;
    reviewComments: boolean;
    reviews: boolean;
  };
};

export type ReconciledPrDraftState = {
  actualDraft: boolean;
  changed: boolean;
  confirmed: boolean;
};

type CreatedPrResult = PrResult & {
  repoOwner: string;
  repoName: string;
  baseBranch: string;
};

type ResolvedGithubAuth = {
  sessionId: string;
  token: string;
  tokenSource: "user" | "installation";
  installationId?: number;
  installationToken: string | null;
  repoOwner: string;
  repoName: string;
  ext: SessionPrWorkflowExt | null;
};

export type ResolvedPrRepoAuth = ResolvedGithubAuth;

type PrLabelMetadata = {
  color: string;
  description: string;
  unavailableEvent: string;
  unavailableMessage: string;
  context?: Record<string, unknown>;
};

function isGithubAuthError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\(401\)/.test(error.message) || /bad credentials/i.test(error.message);
}

function labelOperationKey(label: string): string {
  return (
    label
      .replace(/[^a-z0-9]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase() || "label"
  );
}

const CYCLOID_PROVENANCE_LABEL_SET = new Set<string>(CYCLOID_PROVENANCE_LABELS);

export class GithubPrOperations {
  constructor(
    private readonly sql: SqlStorage,
    private readonly env: Env,
    private readonly log: Logger,
  ) {}

  async createPr(
    sessionId: string,
    branch: string,
    title: string,
    body: string,
    options: { draft?: boolean } = {},
  ): Promise<CreatedPrResult> {
    const auth = await this.resolveRepoAuth(sessionId);
    if (!auth) throw new Error("GitHub auth is unavailable for PR creation");

    let baseBranch = auth.ext?.baseBranch ?? undefined;
    if (!baseBranch) {
      const branchLookupToken = auth.installationToken ?? auth.token;
      baseBranch = await getDefaultBranch(branchLookupToken, auth.repoOwner, auth.repoName);
    }

    if (branch === baseBranch) {
      throw new Error(`Head branch matches base branch (${baseBranch}) — no changes to create a PR from`);
    }

    const result = await this.runWithInstallationFallback(auth, "create_pr", (token) =>
      createPullRequest({
        token,
        owner: auth.repoOwner,
        repo: auth.repoName,
        head: branch,
        base: baseBranch,
        title,
        body,
        draft: options.draft === true,
      }),
    );
    if (result.created === false) {
      this.log.info(
        {
          sessionId,
          repo: `${auth.repoOwner}/${auth.repoName}`,
          prNumber: result.prNumber,
          branch,
        },
        "Existing branch PR found during creation; returning adopted PR for publish reconciliation",
      );
    }
    return { ...result, repoOwner: auth.repoOwner, repoName: auth.repoName, baseBranch };
  }

  async resolvePrUpdateContext(sessionId: string): Promise<ResolvedPrUpdateContext | null> {
    const auth = await this.resolveRepoAuth(sessionId);
    if (!auth) return null;

    const prUrl = auth.ext?.prUrl;
    const prNumber = resolveAttachedPrNumber(auth.ext?.prNumber, prUrl);
    if (!prNumber || !prUrl) return null;

    return {
      sessionId,
      token: auth.token,
      tokenSource: auth.tokenSource,
      installationId: auth.installationId,
      installationToken: auth.installationToken,
      repoOwner: auth.repoOwner,
      repoName: auth.repoName,
      prNumber,
      prUrl,
      ext: auth.ext,
    };
  }

  async resolvePrTargetContext(sessionId: string, requestedPrUrl?: string | null): Promise<ResolvePrTargetResult> {
    if (!requestedPrUrl) {
      const context = await this.resolvePrUpdateContext(sessionId);
      return context
        ? { ok: true, context }
        : { ok: false, reason: "no_pr", message: "No pull request is attached to this session." };
    }

    const parsed = parseGithubPullRequestUrl(requestedPrUrl);
    if (!parsed) return { ok: false, reason: "invalid", message: "Expected a valid GitHub pull request URL." };

    const auth = await this.resolveRepoAuth(sessionId);
    if (!auth) return { ok: false, reason: "error", message: "GitHub auth is unavailable for this session." };

    if (
      parsed.owner.toLowerCase() !== auth.repoOwner.toLowerCase() ||
      parsed.repo.toLowerCase() !== auth.repoName.toLowerCase()
    ) {
      return {
        ok: false,
        reason: "forbidden",
        message: "PR close is limited to pull requests in the current session repository.",
      };
    }

    return {
      ok: true,
      context: {
        sessionId,
        token: auth.token,
        tokenSource: auth.tokenSource,
        installationId: auth.installationId,
        installationToken: auth.installationToken,
        repoOwner: auth.repoOwner,
        repoName: auth.repoName,
        prNumber: parsed.number,
        prUrl: parsed.prUrl,
        ext: auth.ext,
      },
    };
  }

  /**
   * Promotes an existing draft PR to ready-for-review. Cycloid no longer opens
   * or converts PRs to draft, but an adopted or historical PR may still be draft.
   */
  async ensurePrReadyForReview(context: ResolvedPrUpdateContext): Promise<ReconciledPrDraftState> {
    const state = await this.getPrDraftState(context);
    if (!state) {
      return { actualDraft: false, changed: false, confirmed: false };
    }
    if (!state.isDraft) {
      return { actualDraft: false, changed: false, confirmed: true };
    }
    await this.runWithInstallationFallback(context, "mark_pr_ready_for_review", (token) =>
      markPullRequestReadyForReview(token, state.nodeId),
    );
    return { actualDraft: false, changed: true, confirmed: true };
  }

  async getPrDraftState(context: ResolvedPrUpdateContext): Promise<{ nodeId: string; isDraft: boolean } | null> {
    return await this.runWithInstallationFallback(context, "get_pr_draft_state", (token) =>
      getPrDraftState(token, context.repoOwner, context.repoName, context.prNumber),
    );
  }

  async updatePrBody(context: ResolvedPrUpdateContext, body: string): Promise<void> {
    await this.runWithInstallationFallback(context, "update_pr_body", (token) =>
      updatePullRequest(token, context.repoOwner, context.repoName, context.prNumber, { body }),
    );
  }

  async updatePrTitle(context: ResolvedPrUpdateContext, title: string): Promise<void> {
    await this.runWithInstallationFallback(context, "update_pr_title", (token) =>
      updatePullRequest(token, context.repoOwner, context.repoName, context.prNumber, { title }),
    );
  }

  async closePr(context: ResolvedPrUpdateContext): Promise<void> {
    await this.runWithInstallationFallback(context, "close_pr", (token) =>
      closePullRequest(token, context.repoOwner, context.repoName, context.prNumber),
    );
  }

  async reopenPr(context: ResolvedPrUpdateContext): Promise<void> {
    await this.runWithInstallationFallback(context, "reopen_pr", (token) =>
      reopenPullRequest(token, context.repoOwner, context.repoName, context.prNumber),
    );
  }

  async getPrState(context: ResolvedPrUpdateContext): Promise<"open" | "closed" | "merged" | null> {
    const status = await this.runWithInstallationFallback(context, "get_pr_state_for_close", (token) =>
      getPrMergeStatus(token, context.repoOwner, context.repoName, context.prNumber),
    );
    return status.state;
  }

  // Read-only aggregation for the `cycloid.read_pr` tool: PR metadata + body, issue comments,
  // review comments, and reviews (each with author), shaped like `gh pr view --comments`. Each read
  // goes through the installation-token fallback so a rejected user token still resolves.
  async readPrContents(context: ResolvedPrUpdateContext): Promise<ReadPrContents> {
    const [overview, issueComments, reviewComments, reviews] = await Promise.all([
      this.runWithInstallationFallback(context, "read_pr_overview", (token) =>
        getPrOverview(token, context.repoOwner, context.repoName, context.prNumber),
      ),
      this.runWithInstallationFallback(context, "read_pr_issue_comments", (token) =>
        listPrIssueCommentsDetailed(
          token,
          context.repoOwner,
          context.repoName,
          context.prNumber,
          READ_PR_MAX_ISSUE_COMMENTS,
        ),
      ),
      this.runWithInstallationFallback(context, "read_pr_review_comments", (token) =>
        getPrReviewComments(token, context.repoOwner, context.repoName, context.prNumber, READ_PR_MAX_REVIEW_COMMENTS),
      ),
      this.runWithInstallationFallback(context, "read_pr_reviews", (token) =>
        listPrReviews(token, context.repoOwner, context.repoName, context.prNumber, READ_PR_MAX_REVIEWS),
      ),
    ]);

    const reviewCommentsTruncated = reviewComments.length > READ_PR_MAX_REVIEW_COMMENTS;
    const boundedReviewComments: PrReviewCommentSummary[] = reviewComments
      .slice(0, READ_PR_MAX_REVIEW_COMMENTS)
      .map((comment) => ({
        id: comment.id,
        author: comment.author,
        path: comment.path,
        line: comment.line,
        body: comment.body,
        reviewId: comment.reviewId,
        inReplyToId: comment.inReplyToId,
      }));

    return {
      overview,
      issueComments: issueComments.comments,
      reviewComments: boundedReviewComments,
      reviews: reviews.reviews,
      truncated: {
        issueComments: issueComments.truncated,
        reviewComments: reviewCommentsTruncated,
        reviews: reviews.truncated,
      },
    };
  }

  async getPrTitle(context: ResolvedPrUpdateContext): Promise<string> {
    return this.runWithInstallationFallback(context, "get_pr_title", (token) =>
      getPullRequestTitle(token, context.repoOwner, context.repoName, context.prNumber),
    );
  }

  async createPrEvidenceComment(context: ResolvedPrUpdateContext, body: string): Promise<number> {
    return this.runWithInstallationFallback(context, "create_pr_evidence_comment", (token) =>
      createIssueComment(token, context.repoOwner, context.repoName, context.prNumber, body),
    );
  }

  async updatePrEvidenceComment(context: ResolvedPrUpdateContext, commentId: number, body: string): Promise<void> {
    await this.runWithInstallationFallback(context, "update_pr_evidence_comment", (token) =>
      updateIssueComment(token, context.repoOwner, context.repoName, commentId, body),
    );
  }

  async deletePrEvidenceComment(context: ResolvedPrUpdateContext, commentId: number): Promise<void> {
    await this.runWithInstallationFallback(context, "delete_pr_evidence_comment", (token) =>
      deleteIssueComment(token, context.repoOwner, context.repoName, commentId),
    );
  }

  async applyProvenanceLabel(
    sessionId: string,
    auth: Pick<
      ResolvedGithubAuth,
      "sessionId" | "token" | "tokenSource" | "installationId" | "installationToken" | "repoOwner" | "repoName"
    >,
    prNumber: number,
    opts: { scheduled: boolean; scheduledRuleId: string | null },
  ): Promise<void> {
    const desired = opts.scheduled ? ARCANIST_SCHEDULED_LABEL : CYCLOID_PR_LABEL;
    const metadata: PrLabelMetadata = opts.scheduled
      ? {
          color: "5319e7",
          description: "Created by a Cycloid scheduled run",
          unavailableEvent: "automation_label_unavailable",
          unavailableMessage: "Could not apply cycloid:scheduled label",
          context: { scheduledRuleId: opts.scheduledRuleId },
        }
      : {
          color: "5319e7",
          description: "Created by Cycloid",
          unavailableEvent: "cycloid_label_unavailable",
          unavailableMessage: "Could not apply cycloid label",
        };
    const operationKey = labelOperationKey(desired);

    try {
      const ensured = await this.runWithInstallationFallbackResult(
        auth,
        `ensure_pr_label_${operationKey}`,
        (token) => ensureRepoLabel(token, auth.repoOwner, auth.repoName, desired, metadata.color, metadata.description),
        (result) => !result.ok && result.reason === "permission_denied",
      );
      if (!ensured.ok) {
        this.log.warn(
          {
            event: metadata.unavailableEvent,
            sessionId,
            prNumber,
            reason: ensured.reason,
            status: ensured.status,
            ...metadata.context,
          },
          metadata.unavailableMessage,
        );
        return;
      }

      const current = await this.runWithInstallationFallback(auth, "list_pr_labels", (token) =>
        listLabels(token, auth.repoOwner, auth.repoName, prNumber),
      );

      if (!current.includes(desired)) {
        await this.runWithInstallationFallback(auth, `add_pr_label_${operationKey}`, (token) =>
          addLabels(token, auth.repoOwner, auth.repoName, prNumber, [desired]),
        );
      }

      const staleProvenanceLabels = current.filter(
        (label) => label !== desired && CYCLOID_PROVENANCE_LABEL_SET.has(label),
      );
      await Promise.all(
        staleProvenanceLabels.map((label) =>
          this.runWithInstallationFallback(auth, `remove_pr_label_${labelOperationKey(label)}`, (token) =>
            removeLabel(token, auth.repoOwner, auth.repoName, prNumber, label),
          ),
        ),
      );
    } catch (error) {
      this.log.warn(
        {
          event: metadata.unavailableEvent,
          sessionId,
          prNumber,
          reason: "exception",
          error: String(error),
          ...metadata.context,
        },
        metadata.unavailableMessage,
      );
    }
  }

  async resolveRepoAuthForPublish(sessionId: string): Promise<ResolvedPrRepoAuth | null> {
    return this.resolveRepoAuth(sessionId);
  }

  async getRemoteBranchHeadSha(auth: ResolvedPrRepoAuth, branch: string): Promise<string | null> {
    return this.runWithInstallationFallback(auth, "get_remote_branch_head_sha", (token) =>
      getBranchHeadSha(token, auth.repoOwner, auth.repoName, branch),
    );
  }

  async findOpenPr(
    auth: ResolvedPrRepoAuth,
    branch: string,
    // ARC-1014: deterministic dedup marker. A marker match is treated as a
    // definitive "this attempt already created the PR" recovery hit.
    dedupMarker: string,
  ): Promise<(PrResult & { matchedMarker: boolean }) | null> {
    const result = await this.runWithInstallationFallback(auth, "find_open_pr", (token) =>
      findOpenPrByHead(token, auth.repoOwner, auth.repoName, branch, dedupMarker),
    );
    return result ? { ...result, created: false, matchedMarker: result.matchedMarker ?? false } : null;
  }

  private async resolveRepoAuth(sessionId: string): Promise<ResolvedGithubAuth | null> {
    if (!this.env.DB) return null;

    const session = doDb.getSession(this.sql, sessionId);
    if (!session) return null;

    const ext = doDb.getSessionExtended(this.sql, sessionId);
    const repoOwner = ext?.repoOwner ?? undefined;
    const repoName = ext?.repoName ?? undefined;
    if (!repoOwner || !repoName) return null;

    const userToken = await getValidGithubToken(this.env.DB, session.ownerUserId, this.env);
    const installationId = ext?.installationId as number | undefined;

    if (userToken) {
      this.log.info({ sessionId }, "Using user OAuth token for GitHub session operations");
      return {
        sessionId,
        token: userToken,
        tokenSource: "user",
        installationId,
        installationToken: null,
        repoOwner,
        repoName,
        ext,
      };
    }

    const installationToken = await this.getInstallationToken(sessionId, installationId);
    if (installationToken) {
      this.log.info({ sessionId, installationId }, "Using installation token fallback for GitHub session operations");
      return {
        sessionId,
        token: installationToken,
        tokenSource: "installation",
        installationId,
        installationToken,
        repoOwner,
        repoName,
        ext,
      };
    }

    return null;
  }

  private async getInstallationToken(sessionId: string, installationId?: number): Promise<string | null> {
    if (!installationId) return null;
    try {
      return await createInstallationToken(this.env, installationId);
    } catch (error) {
      this.log.warn(
        { sessionId, installationId, error: String(error) },
        "Failed to generate installation token for GitHub session operations",
      );
      return null;
    }
  }

  private async runWithInstallationFallback<T>(
    auth: Pick<
      ResolvedGithubAuth,
      "sessionId" | "token" | "tokenSource" | "installationId" | "installationToken" | "repoOwner" | "repoName"
    >,
    operation: string,
    run: (token: string) => Promise<T>,
  ): Promise<T> {
    try {
      return await run(auth.token);
    } catch (error) {
      if (auth.tokenSource !== "user" || !isGithubAuthError(error)) {
        throw error;
      }

      const installationToken = await this.resolveInstallationToken(auth);
      if (!installationToken) throw error;

      this.log.warn(
        {
          operation,
          repo: `${auth.repoOwner}/${auth.repoName}`,
          error: String(error),
        },
        "User GitHub token was rejected; retrying with installation token",
      );
      return run(installationToken);
    }
  }

  private async runWithInstallationFallbackResult<T>(
    auth: Pick<
      ResolvedGithubAuth,
      "sessionId" | "token" | "tokenSource" | "installationId" | "installationToken" | "repoOwner" | "repoName"
    >,
    operation: string,
    run: (token: string) => Promise<T>,
    shouldFallback: (result: T) => boolean,
  ): Promise<T> {
    try {
      const result = await run(auth.token);
      if (auth.tokenSource !== "user" || !shouldFallback(result)) return result;

      const installationToken = await this.resolveInstallationToken(auth);
      if (!installationToken) return result;

      this.log.warn(
        {
          operation,
          repo: `${auth.repoOwner}/${auth.repoName}`,
        },
        "User GitHub token was rejected; retrying with installation token",
      );
      return run(installationToken);
    } catch (error) {
      if (auth.tokenSource !== "user" || !isGithubAuthError(error)) {
        throw error;
      }

      const installationToken = await this.resolveInstallationToken(auth);
      if (!installationToken) throw error;

      this.log.warn(
        {
          operation,
          repo: `${auth.repoOwner}/${auth.repoName}`,
          error: String(error),
        },
        "User GitHub token was rejected; retrying with installation token",
      );
      return run(installationToken);
    }
  }

  private async resolveInstallationToken(
    auth: Pick<ResolvedGithubAuth, "sessionId" | "installationId" | "installationToken">,
  ): Promise<string | null> {
    if (auth.installationToken) return auth.installationToken;
    const installationToken = await this.getInstallationToken(auth.sessionId, auth.installationId);
    auth.installationToken = installationToken;
    return installationToken;
  }
}
