UPDATE offboarding_jobs
SET phase = 'failed',
    error_json = COALESCE(
      error_json,
      '{"message":"Superseded by active offboarding job unique-index migration"}'
    )
WHERE phase NOT IN ('completed', 'failed')
  AND job_id IN (
    SELECT job_id
    FROM (
      SELECT
        job_id,
        ROW_NUMBER() OVER (
          PARTITION BY business_id
          ORDER BY created_at DESC, job_id DESC
        ) AS active_rank
      FROM offboarding_jobs
      WHERE phase NOT IN ('completed', 'failed')
    )
    WHERE active_rank > 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_offboarding_jobs_active_business
  ON offboarding_jobs (business_id)
  WHERE phase NOT IN ('completed', 'failed');
