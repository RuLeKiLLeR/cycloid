-- Unify session status: replace "closed" with "archived" as the single canonical
-- terminal status. The DO historically wrote "closed" while the UI expected
-- "archived"; deriveSessionStatus papered over the gap. This migration makes D1
-- match the new canonical value so the translation layer can be removed.
UPDATE session_index SET status = 'archived' WHERE status = 'closed';
