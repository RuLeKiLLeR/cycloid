CREATE TABLE IF NOT EXISTS prompt_tool_rollup (
  session_id TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  business_id TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL,
  agent TEXT,
  tool_name TEXT NOT NULL,
  mcp_server TEXT,
  ok_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  total_duration_ms INTEGER NOT NULL DEFAULT 0,
  duration_sample_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, prompt_id, tool_name)
);

CREATE INDEX IF NOT EXISTS idx_prompt_tool_rollup_biz_tool ON prompt_tool_rollup (business_id, created_at, tool_name);
CREATE INDEX IF NOT EXISTS idx_prompt_tool_rollup_biz_mcp ON prompt_tool_rollup (business_id, mcp_server, created_at);
