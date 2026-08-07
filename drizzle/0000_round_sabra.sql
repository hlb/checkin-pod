CREATE TABLE `live_event_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`snapshot_json` text NOT NULL,
	`updated_at` text NOT NULL
);
