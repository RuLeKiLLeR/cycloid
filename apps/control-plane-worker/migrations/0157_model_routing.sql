ALTER TABLE user_settings ADD COLUMN model_routing_mode TEXT NOT NULL DEFAULT 'frontier_only';
ALTER TABLE session_index ADD COLUMN model_routing_mode TEXT;
ALTER TABLE session_index ADD COLUMN model_routing_tier TEXT;
ALTER TABLE session_index ADD COLUMN model_routing_model TEXT;
ALTER TABLE session_index ADD COLUMN model_routing_router_version TEXT;
ALTER TABLE session_index ADD COLUMN model_routing_reasons_json TEXT;
ALTER TABLE session_index ADD COLUMN model_routing_bypassed_reason TEXT;
