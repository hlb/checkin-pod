export const SHARED_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS checkin_events (
    event_id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    headers_json TEXT NOT NULL,
    selected_fields_json TEXT NOT NULL,
    background_color TEXT NOT NULL DEFAULT '#0E0F12',
    sync_mode TEXT NOT NULL DEFAULT 'multi' CHECK(sync_mode IN ('single', 'multi')),
    total INTEGER NOT NULL DEFAULT 0 CHECK(total >= 0 AND total <= 10000),
    status TEXT NOT NULL DEFAULT 'importing' CHECK(status IN ('importing', 'active')),
    active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0, 1)),
    cue_id TEXT,
    cue_type TEXT,
    cue_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS checkin_events_active_idx
    ON checkin_events(active, status)`,
  `CREATE TABLE IF NOT EXISTS checkin_attendees (
    event_id TEXT NOT NULL,
    attendee_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    ticket TEXT NOT NULL DEFAULT '',
    approval_status TEXT NOT NULL DEFAULT '',
    checked_in_at TEXT,
    checked_in_lane_id TEXT,
    original_json TEXT NOT NULL,
    PRIMARY KEY(event_id, attendee_id),
    FOREIGN KEY(event_id) REFERENCES checkin_events(event_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS checkin_attendees_event_position_idx
    ON checkin_attendees(event_id, position)`,
  `CREATE INDEX IF NOT EXISTS checkin_attendees_event_checked_idx
    ON checkin_attendees(event_id, checked_in_at)`,
  `CREATE INDEX IF NOT EXISTS checkin_attendees_event_name_idx
    ON checkin_attendees(event_id, name)`,
  `CREATE TABLE IF NOT EXISTS checkin_scan_keys (
    event_id TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    attendee_id TEXT NOT NULL,
    PRIMARY KEY(event_id, key_hash),
    FOREIGN KEY(event_id) REFERENCES checkin_events(event_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS checkin_scan_keys_lookup_idx
    ON checkin_scan_keys(event_id, key_hash)`,
  `CREATE TABLE IF NOT EXISTS checkin_lanes (
    lane_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    revoked_at TEXT,
    FOREIGN KEY(event_id) REFERENCES checkin_events(event_id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS checkin_lanes_token_hash_idx
    ON checkin_lanes(token_hash)`,
  `CREATE INDEX IF NOT EXISTS checkin_lanes_event_idx
    ON checkin_lanes(event_id, revoked_at)`,
  `CREATE TABLE IF NOT EXISTS checkin_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    attendee_id TEXT,
    lane_id TEXT,
    outcome TEXT NOT NULL CHECK(outcome IN ('success', 'duplicate', 'unknown', 'undo')),
    checked_in_at TEXT,
    occurred_at TEXT NOT NULL,
    request_id TEXT NOT NULL,
    FOREIGN KEY(event_id) REFERENCES checkin_events(event_id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS checkin_activity_request_idx
    ON checkin_activity(event_id, request_id)`,
  `CREATE INDEX IF NOT EXISTS checkin_activity_event_cursor_idx
    ON checkin_activity(event_id, id)`,
] as const;

export const ATOMIC_CHECK_IN_SQL = `UPDATE checkin_attendees
  SET checked_in_at = ?, checked_in_lane_id = ?
  WHERE event_id = ? AND attendee_id = ? AND checked_in_at IS NULL
  RETURNING event_id, attendee_id, position, name, email, phone, ticket,
    approval_status, checked_in_at, checked_in_lane_id, original_json`;
