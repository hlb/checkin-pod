-- Destructive reset for deployments that intentionally discard all event data.
-- Drop child tables first so the reset works with foreign keys enabled.
DROP TABLE IF EXISTS checkin_admin_audit;
DROP TABLE IF EXISTS checkin_activity;
DROP TABLE IF EXISTS checkin_scan_keys;
DROP TABLE IF EXISTS checkin_lanes;
DROP TABLE IF EXISTS checkin_attendees;
DROP TABLE IF EXISTS checkin_events;
DROP TABLE IF EXISTS live_event_state;
