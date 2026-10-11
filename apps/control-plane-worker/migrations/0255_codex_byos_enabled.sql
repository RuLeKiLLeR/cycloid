-- ARC-1517: Bring-your-own-subscription (BYOS) for Codex, alongside BYOK.
--
-- Per-business opt-in capability for connecting and using a personal ChatGPT/Codex
-- subscription (`auth.json`) as the OpenAI model-provider credential. Default off so
-- rollout is deliberate and per-business, mirroring `self_hosted_sandboxes_enabled`
-- (migration 0101). Enum/boolean columns are code-validated; no CHECK constraint.
--
-- Seed the prod Arcanist business so the prior internal-only behavior (previously
-- gated inline by `SEEDED_BUSINESS_IDS.arcanist`) is preserved exactly on deploy.
-- Business ids were migrated to UUIDs in 0105, so seed the current prod Arcanist
-- UUID (`SEEDED_BUSINESS_IDS.arcanist`), NOT the pre-0105 'biz-arcanist' slug. Only
-- the prod Arcanist business is seeded, matching the previous prod-only gate; QA and
-- customer businesses stay off until explicitly enabled.
ALTER TABLE businesses ADD COLUMN codex_byos_enabled INTEGER NOT NULL DEFAULT 0;

UPDATE businesses
SET codex_byos_enabled = 1,
    updated_at = unixepoch() * 1000
WHERE id = '295d2abc-d10b-4662-b84d-7bfa66242882';
