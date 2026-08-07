CREATE TABLE `checkin_activity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`attendee_id` text,
	`lane_id` text,
	`outcome` text NOT NULL,
	`checked_in_at` text,
	`occurred_at` text NOT NULL,
	`request_id` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `checkin_events`(`event_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checkin_activity_request_idx` ON `checkin_activity` (`event_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `checkin_activity_event_cursor_idx` ON `checkin_activity` (`event_id`,`id`);--> statement-breakpoint
CREATE TABLE `checkin_attendees` (
	`event_id` text NOT NULL,
	`attendee_id` text NOT NULL,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`ticket` text DEFAULT '' NOT NULL,
	`approval_status` text DEFAULT '' NOT NULL,
	`checked_in_at` text,
	`checked_in_lane_id` text,
	`original_json` text NOT NULL,
	PRIMARY KEY(`event_id`, `attendee_id`),
	FOREIGN KEY (`event_id`) REFERENCES `checkin_events`(`event_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `checkin_attendees_event_position_idx` ON `checkin_attendees` (`event_id`,`position`);--> statement-breakpoint
CREATE INDEX `checkin_attendees_event_checked_idx` ON `checkin_attendees` (`event_id`,`checked_in_at`);--> statement-breakpoint
CREATE INDEX `checkin_attendees_event_name_idx` ON `checkin_attendees` (`event_id`,`name`);--> statement-breakpoint
CREATE TABLE `checkin_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`file_name` text NOT NULL,
	`headers_json` text NOT NULL,
	`selected_fields_json` text NOT NULL,
	`background_color` text DEFAULT '#0E0F12' NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'importing' NOT NULL,
	`active` integer DEFAULT false NOT NULL,
	`cue_id` text,
	`cue_type` text,
	`cue_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `checkin_events_active_idx` ON `checkin_events` (`active`,`status`);--> statement-breakpoint
CREATE TABLE `checkin_lanes` (
	`lane_id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text,
	`revoked_at` text,
	FOREIGN KEY (`event_id`) REFERENCES `checkin_events`(`event_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checkin_lanes_token_hash_idx` ON `checkin_lanes` (`token_hash`);--> statement-breakpoint
CREATE INDEX `checkin_lanes_event_idx` ON `checkin_lanes` (`event_id`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `checkin_scan_keys` (
	`event_id` text NOT NULL,
	`key_hash` text NOT NULL,
	`attendee_id` text NOT NULL,
	PRIMARY KEY(`event_id`, `key_hash`),
	FOREIGN KEY (`event_id`) REFERENCES `checkin_events`(`event_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `checkin_scan_keys_lookup_idx` ON `checkin_scan_keys` (`event_id`,`key_hash`);
--> statement-breakpoint
PRAGMA optimize;
