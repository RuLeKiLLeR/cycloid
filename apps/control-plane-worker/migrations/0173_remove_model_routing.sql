-- Remove the model-routing subsystem (routeSessionModel + per-user routing mode).
-- Model selection is now explicit selection (UI picker / default_model) else the
-- backend default; the router and its persisted metadata are gone. Forward DROP
-- migration (one column per line so the runner skips already-applied drops safely).
ALTER TABLE user_settings DROP COLUMN model_routing_mode;
ALTER TABLE session_index DROP COLUMN model_routing_mode;
ALTER TABLE session_index DROP COLUMN model_routing_tier;
ALTER TABLE session_index DROP COLUMN model_routing_model;
ALTER TABLE session_index DROP COLUMN model_routing_router_version;
ALTER TABLE session_index DROP COLUMN model_routing_reasons_json;
ALTER TABLE session_index DROP COLUMN model_routing_bypassed_reason;
