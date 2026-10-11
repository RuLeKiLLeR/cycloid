-- Keep self-hosted E2B explicitly opt-in after the initial bootstrap migration.
UPDATE businesses
SET self_hosted_sandboxes_enabled = 0,
    updated_at = unixepoch() * 1000
WHERE id = 'biz-arcanist';
