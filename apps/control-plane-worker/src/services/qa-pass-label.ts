import { E2E_TESTED_LABEL } from "../constants/pr-labels";
import { getInstallationByOwner } from "../github/installations-db";
import { createInstallationToken } from "../github/octokit";
import { addLabels, ensureRepoLabel } from "../github/pr";
import { parseGithubPullRequestUrl } from "../github/verification-pr-context";
import type { Logger } from "../logger";
import type { Env } from "../types";

const E2E_TESTED_LABEL_COLOR = "0e8a16";
const E2E_TESTED_LABEL_DESCRIPTION = "End-to-end tested";

export interface ApplyQaPassLabelOptions {
  prUrl: string;
  sessionId: string;
  installationId: number | null;
  repoOwner: string | null;
  repoName: string | null;
  logger: Logger;
}

async function resolveInstallationId(env: Env, options: ApplyQaPassLabelOptions): Promise<number | null> {
  const parsed = parseGithubPullRequestUrl(options.prUrl);
  if (!parsed) return null;
  const hintMatches =
    options.repoOwner?.toLowerCase() === parsed.owner.toLowerCase() &&
    options.repoName?.toLowerCase() === parsed.repo.toLowerCase();
  if (hintMatches && typeof options.installationId === "number" && options.installationId > 0) {
    return options.installationId;
  }
  const installation = await getInstallationByOwner(env.DB, parsed.owner);
  return installation && installation.suspended_at === null ? installation.installation_id : null;
}

/** Best-effort sticky QA-pass signal. Never throws and never rewrites customer-owned label metadata. */
export async function applyQaPassLabel(env: Env, options: ApplyQaPassLabelOptions): Promise<void> {
  try {
    const parsed = parseGithubPullRequestUrl(options.prUrl);
    if (!parsed) {
      options.logger.warn(
        { prUrl: options.prUrl, sessionId: options.sessionId },
        "QA pass label skipped invalid PR URL",
      );
      return;
    }

    const installationId = await resolveInstallationId(env, options);
    if (!installationId) {
      options.logger.warn({ prUrl: options.prUrl, sessionId: options.sessionId }, "QA pass label skipped installation");
      return;
    }

    const token = await createInstallationToken(env, installationId);
    const ensured = await ensureRepoLabel(
      token,
      parsed.owner,
      parsed.repo,
      E2E_TESTED_LABEL,
      E2E_TESTED_LABEL_COLOR,
      E2E_TESTED_LABEL_DESCRIPTION,
      { updateOnDrift: false },
    );
    if (!ensured.ok) {
      options.logger.warn(
        {
          prUrl: options.prUrl,
          sessionId: options.sessionId,
          reason: ensured.reason,
          status: ensured.status,
        },
        "QA pass label ensure failed",
      );
      return;
    }

    await addLabels(token, parsed.owner, parsed.repo, parsed.number, [E2E_TESTED_LABEL]);
  } catch (error) {
    options.logger.warn(
      { prUrl: options.prUrl, sessionId: options.sessionId, error: String(error) },
      "QA pass label apply failed",
    );
  }
}
