ALTER TABLE session_index ADD COLUMN arcanist_done_state TEXT NOT NULL DEFAULT 'working';
ALTER TABLE session_index ADD COLUMN arcanist_done_outcome TEXT;
ALTER TABLE session_index ADD COLUMN arcanist_done_reasons_json TEXT NOT NULL DEFAULT '[]';
