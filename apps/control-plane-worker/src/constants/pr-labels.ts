export const CYCLOID_PR_LABEL = "cycloid";
export const ARCANIST_SCHEDULED_LABEL = "cycloid:scheduled";
export const CYCLOID_MEMORY_LABEL = "cycloid:memory";
// Provenance labels are mutually exclusive: a PR carries exactly one, the most
// specialized that applies. New `cycloid:*` provenance labels go ahead of the base label.
export const CYCLOID_PROVENANCE_LABELS = [ARCANIST_SCHEDULED_LABEL, CYCLOID_MEMORY_LABEL, CYCLOID_PR_LABEL] as const;

// Sticky write-once label applied on a CONCLUSIVE QA verdict and never removed. Deliberately excluded
// from both FSM_MANAGED_LABEL_META and CYCLOID_PROVENANCE_LABELS so neither reconciler strips it.
export const E2E_TESTED_LABEL = "E2E-Tested";

// PR-E1: the `review-loop:*` and `verification-*` PR-label constants were SCRAPPED — QA no longer
// gates the review loop (it runs in parallel, spawned at publish; the verdict arrives as a PR comment,
// never as a gating label), so `labelsOf` emits none of them. The legacy label strings survive ONLY as
// inline literals in `label-projection.ts`'s managed (strip) set so the reconcile tears them off
// in-flight PRs. The `NEEDS_YOU` terminal labels below are the only managed labels `labelsOf` still emits.

// `ci-fix-exhausted` is the `NEEDS_YOU{ci_fix_exhausted}` blocked_reason label (design §12 total map),
// shared by `ci_fix_exhausted`/`ci_flapping` — both terminal red-CI degradations needing a human.
export const CI_FIX_EXHAUSTED_LABEL = "ci-fix-exhausted";

// The remaining `NEEDS_YOU` blocked_reason labels: a human-action approval block, a stalled review, and
// the loud internal catch-all.
export const OWNER_APPROVAL_LABEL = "owner-approval";
export const REVIEW_STUCK_LABEL = "review-stuck";
export const INTERNAL_ERROR_LABEL = "internal-error";
