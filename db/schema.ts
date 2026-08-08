import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const liveEventState = sqliteTable("live_event_state", {
  id: integer("id").primaryKey(),
  snapshotJson: text("snapshot_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const checkinEvents = sqliteTable("checkin_events", {
  eventId: text("event_id").primaryKey(),
  fileName: text("file_name").notNull(),
  headersJson: text("headers_json").notNull(),
  selectedFieldsJson: text("selected_fields_json").notNull(),
  backgroundColor: text("background_color").notNull().default("#0E0F12"),
  syncMode: text("sync_mode").notNull().default("multi"),
  total: integer("total").notNull().default(0),
  status: text("status").notNull().default("importing"),
  active: integer("active", { mode: "boolean" }).notNull().default(false),
  cueId: text("cue_id"),
  cueType: text("cue_type"),
  cueAt: text("cue_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("checkin_events_active_idx").on(table.active, table.status),
]);

export const checkinAttendees = sqliteTable("checkin_attendees", {
  eventId: text("event_id").notNull().references(() => checkinEvents.eventId, { onDelete: "cascade" }),
  attendeeId: text("attendee_id").notNull(),
  position: integer("position").notNull(),
  name: text("name").notNull(),
  email: text("email").notNull().default(""),
  phone: text("phone").notNull().default(""),
  ticket: text("ticket").notNull().default(""),
  approvalStatus: text("approval_status").notNull().default(""),
  checkedInAt: text("checked_in_at"),
  checkedInLaneId: text("checked_in_lane_id"),
  originalJson: text("original_json").notNull(),
}, (table) => [
  primaryKey({ columns: [table.eventId, table.attendeeId] }),
  index("checkin_attendees_event_position_idx").on(table.eventId, table.position),
  index("checkin_attendees_event_checked_idx").on(table.eventId, table.checkedInAt),
  index("checkin_attendees_event_name_idx").on(table.eventId, table.name),
]);

export const checkinScanKeys = sqliteTable("checkin_scan_keys", {
  eventId: text("event_id").notNull().references(() => checkinEvents.eventId, { onDelete: "cascade" }),
  keyHash: text("key_hash").notNull(),
  attendeeId: text("attendee_id").notNull(),
}, (table) => [
  primaryKey({ columns: [table.eventId, table.keyHash] }),
  index("checkin_scan_keys_lookup_idx").on(table.eventId, table.keyHash),
]);

export const checkinLanes = sqliteTable("checkin_lanes", {
  laneId: text("lane_id").primaryKey(),
  eventId: text("event_id").notNull().references(() => checkinEvents.eventId, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(),
  createdAt: text("created_at").notNull(),
  lastSeenAt: text("last_seen_at"),
  revokedAt: text("revoked_at"),
}, (table) => [
  uniqueIndex("checkin_lanes_token_hash_idx").on(table.tokenHash),
  index("checkin_lanes_event_idx").on(table.eventId, table.revokedAt),
]);

export const checkinActivity = sqliteTable("checkin_activity", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventId: text("event_id").notNull().references(() => checkinEvents.eventId, { onDelete: "cascade" }),
  attendeeId: text("attendee_id"),
  laneId: text("lane_id"),
  outcome: text("outcome").notNull(),
  checkedInAt: text("checked_in_at"),
  occurredAt: text("occurred_at").notNull(),
  requestId: text("request_id").notNull(),
}, (table) => [
  uniqueIndex("checkin_activity_request_idx").on(table.eventId, table.requestId),
  index("checkin_activity_event_cursor_idx").on(table.eventId, table.id),
]);
