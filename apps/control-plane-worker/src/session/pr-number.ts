import { parseGithubPullRequestUrl } from "../github/verification-pr-context";

export function resolveAttachedPrNumber(storedPrNumber: number | null | undefined, prUrl: string | null | undefined) {
  if (typeof storedPrNumber === "number" && Number.isSafeInteger(storedPrNumber) && storedPrNumber > 0) {
    return storedPrNumber;
  }
  return prUrl ? parseGithubPullRequestUrl(prUrl)?.number : undefined;
}
