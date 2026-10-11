import type { OnboardingStep } from "../../../../shared/constants/onboarding";
import { requestJson } from "./client";

export async function fetchOnboardingStatus(options?: {
  owner?: string | null;
  repo?: string | null;
  setup?: "complete" | null;
}): Promise<OnboardingStep[]> {
  const searchParams = new URLSearchParams();
  if (options?.owner) searchParams.set("owner", options.owner);
  if (options?.repo) searchParams.set("repo", options.repo);
  if (options?.setup === "complete") searchParams.set("setup", "complete");

  const query = searchParams.toString();
  // NOTE: route-coverage test parses this fetch path statically -- keep string literals in requestJson calls
  const data = await requestJson<{ ok: boolean; steps: OnboardingStep[] }>(
    query.length > 0 ? `/api/onboarding/status?${query}` : "/api/onboarding/status",
    undefined,
    "Failed to fetch onboarding status",
  );
  return data.steps;
}
