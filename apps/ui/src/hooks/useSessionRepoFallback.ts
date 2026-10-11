import { useRef, useState } from "react";

import type { SsoOrg } from "../../../../shared/types/bootstrap";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { fetchRepos } from "../api/repos";
import type { Repo, SessionDetail } from "../types";
import { useMountEffect, useSyncEffect } from "./useEffects";

type UseSessionRepoFallbackOptions = {
  authenticated: boolean | undefined;
  repos: Repo[];
  reposError: string | null;
  reposLoaded: boolean;
  session: SessionDetail | null;
};

export function useSessionRepoFallback({
  authenticated,
  repos,
  reposError,
  reposLoaded,
  session,
}: UseSessionRepoFallbackOptions) {
  const [fallbackRepos, setFallbackRepos] = useState<Repo[]>([]);
  const [fallbackSsoOrgs, setFallbackSsoOrgs] = useState<SsoOrg[]>([]);
  const [fallbackReposError, setFallbackReposError] = useState<string | null>(null);
  const [retryingRepos, setRetryingRepos] = useState(false);
  const repoFallbackAttemptedRef = useRef(false);

  useMountEffect(() => {
    setFallbackRepos([]);
    setFallbackSsoOrgs([]);
    setFallbackReposError(null);
    setRetryingRepos(false);
    repoFallbackAttemptedRef.current = false;
  });

  useSyncEffect(() => {
    // Once the layout's own repo state recovers (e.g. the user authorizes SSO
    // in another tab and clicks "Refresh repositories"), drop any stale
    // fallback diagnosis and re-arm so a later failure can retry.
    if (reposLoaded && !reposError) {
      setFallbackRepos([]);
      setFallbackSsoOrgs([]);
      setFallbackReposError(null);
      repoFallbackAttemptedRef.current = false;
    }
  }, [reposLoaded, reposError]);

  useSyncEffect(() => {
    if (
      authenticated !== true ||
      !session ||
      !!session.repoUrl ||
      !reposLoaded ||
      !reposError ||
      repos.length > 0 ||
      repoFallbackAttemptedRef.current
    ) {
      return;
    }

    repoFallbackAttemptedRef.current = true;
    setRetryingRepos(true);
    fetchRepos()
      .then(({ repos: nextRepos, ssoOrgs: nextSsoOrgs }) => {
        setFallbackRepos(nextRepos);
        setFallbackSsoOrgs(nextSsoOrgs ?? []);
        setFallbackReposError(null);
      })
      .catch((error) => {
        setFallbackReposError(stringifyError(error));
        console.error("[SessionDetail] Failed to retry repo fetch", error);
      })
      .finally(() => {
        setRetryingRepos(false);
      });
  }, [authenticated, repos, reposError, reposLoaded, session]);

  return {
    effectiveRepos: repos.length > 0 ? repos : fallbackRepos,
    effectiveReposError:
      (repos.length > 0 ? repos : fallbackRepos).length > 0 || fallbackSsoOrgs.length > 0
        ? null
        : (fallbackReposError ?? (retryingRepos ? null : reposError)),
    effectiveReposLoaded: reposLoaded && !retryingRepos,
    fallbackSsoOrgs,
  };
}
