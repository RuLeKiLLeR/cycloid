ALTER TABLE slack_repo_disambiguations ADD COLUMN attachment_file_ids_json TEXT;
ALTER TABLE slack_repo_disambiguations ADD COLUMN attachment_omitted_count INTEGER NOT NULL DEFAULT 0;
