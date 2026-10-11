-- No-op: columns now created in 0006. This migration existed to patch prod
-- where 0006 had been deployed as a no-op, but that environment no longer exists.
SELECT 1;
