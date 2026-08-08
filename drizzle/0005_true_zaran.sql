CREATE UNIQUE INDEX `checkin_lanes_event_lane_idx` ON `checkin_lanes` (`event_id`,`lane_id`);--> statement-breakpoint
DELETE FROM `checkin_scan_keys` WHERE `attendee_id` = '__CONFLICT__';--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_checkin_activity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`attendee_id` text,
	`lane_id` text,
	`outcome` text NOT NULL,
	`checked_in_at` text,
	`occurred_at` text NOT NULL,
	`request_id` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `checkin_events`(`event_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`,`attendee_id`) REFERENCES `checkin_attendees`(`event_id`,`attendee_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`event_id`,`lane_id`) REFERENCES `checkin_lanes`(`event_id`,`lane_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_checkin_activity`("id", "event_id", "attendee_id", "lane_id", "outcome", "checked_in_at", "occurred_at", "request_id") SELECT "id", "event_id", "attendee_id", "lane_id", "outcome", "checked_in_at", "occurred_at", "request_id" FROM `checkin_activity`;--> statement-breakpoint
DROP TABLE `checkin_activity`;--> statement-breakpoint
ALTER TABLE `__new_checkin_activity` RENAME TO `checkin_activity`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `checkin_activity_request_idx` ON `checkin_activity` (`event_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `checkin_activity_event_cursor_idx` ON `checkin_activity` (`event_id`,`id`);--> statement-breakpoint
CREATE TABLE `__new_checkin_scan_keys` (
	`event_id` text NOT NULL,
	`key_hash` text NOT NULL,
	`attendee_id` text NOT NULL,
	PRIMARY KEY(`event_id`, `key_hash`),
	FOREIGN KEY (`event_id`) REFERENCES `checkin_events`(`event_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`,`attendee_id`) REFERENCES `checkin_attendees`(`event_id`,`attendee_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_checkin_scan_keys`("event_id", "key_hash", "attendee_id") SELECT "event_id", "key_hash", "attendee_id" FROM `checkin_scan_keys`;--> statement-breakpoint
DROP TABLE `checkin_scan_keys`;--> statement-breakpoint
ALTER TABLE `__new_checkin_scan_keys` RENAME TO `checkin_scan_keys`;--> statement-breakpoint
CREATE INDEX `checkin_scan_keys_lookup_idx` ON `checkin_scan_keys` (`event_id`,`key_hash`);
