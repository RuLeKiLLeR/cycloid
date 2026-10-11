CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  transport TEXT NOT NULL CHECK (transport IN ('stdio', 'http', 'sse')),
  command TEXT,
  url TEXT,
  args_json TEXT NOT NULL DEFAULT '[]',
  headers_json TEXT NOT NULL DEFAULT '{}',
  secret_refs_json TEXT NOT NULL DEFAULT '[]',
  scope_json TEXT NOT NULL DEFAULT '{"type":"business"}',
  enabled INTEGER NOT NULL DEFAULT 0,
  validation_status TEXT NOT NULL DEFAULT 'untested' CHECK (validation_status IN ('untested', 'validating', 'valid', 'invalid')),
  validation_error TEXT,
  discovered_tools_json TEXT NOT NULL DEFAULT '[]',
  last_validated_at INTEGER,
  created_by_user_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_servers_business_name_active
  ON mcp_servers(business_id, lower(name))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_mcp_servers_business_active
  ON mcp_servers(business_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS mcp_tool_usage_events (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  mcp_server_id TEXT NOT NULL,
  session_id TEXT,
  actor_user_id INTEGER,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed')),
  error TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, mcp_server_id) REFERENCES mcp_servers(business_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mcp_tool_usage_business_created
  ON mcp_tool_usage_events(business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mcp_tool_usage_server_created
  ON mcp_tool_usage_events(mcp_server_id, created_at DESC);
