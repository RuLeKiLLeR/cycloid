-- One-off recovery for sandbox layers left "current-but-stale" by the
-- base-propagation clobber that PR #7137 fixes (see ARC-1502). Before #7137,
-- a base_update rebuild could reuse E2B's cached FROM TEMPLATE base pull and
-- bake the OLD base while recording the layer at the new base_version. The
-- record then claims the layer is current, so no supported command rebuilds it:
-- the rebuild campaign marks it skipped_current, and createOrGetSandboxLayerBuild
-- returns the existing completed row for a same-key `sandbox build`.
--
-- Canceling the stale completed build row is the recovery lever: on the next
-- `sandbox build <repo> --ref main`, createOrGetSandboxLayerBuild resets a
-- canceled row and rebuilds it, and buildReason "manual" now skips the base
-- cache (post-#7137), pulling the fresh base bundle and promoting a new artifact.
--
-- Guarded to status='completed' so re-application is a no-op; a no-op in any
-- environment where these build ids do not exist (e.g. QA). The active artifact
-- keeps serving the (stale) layer until the operator-triggered rebuild promotes
-- the fresh one, so this does not interrupt spawns.
UPDATE sandbox_layer_builds
SET status = 'canceled'
WHERE status = 'completed'
  AND id IN (
    'd1e17597-10ad-45e8-8d71-717da157f3aa', -- tryarcanist/mia-copy-4
    '311fa520-d05b-40d7-81ce-ef2e147243d7'  -- mialabs/mia
  );
