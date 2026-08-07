import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const liveEventState = sqliteTable("live_event_state", {
  id: integer("id").primaryKey(),
  snapshotJson: text("snapshot_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});
