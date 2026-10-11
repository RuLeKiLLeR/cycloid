-- selectReviewLoopReplyGithubIds (pull_request_review webhook self-reply guard) looks up rows by
-- github_id; index it so the lookup stays cheap as operations accumulate. Partial: github_id is
-- only set when an operation succeeds, so running/failed rows stay out of the index.
CREATE INDEX IF NOT EXISTS idx_pr_review_response_operations_github_id
  ON pr_review_response_operations(github_id)
  WHERE github_id IS NOT NULL;
