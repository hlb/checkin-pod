CREATE TABLE `checkin_admin_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`event_id` text,
	`occurred_at` text NOT NULL,
	`request_id` text NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checkin_admin_audit_request_idx` ON `checkin_admin_audit` (`request_id`);--> statement-breakpoint
CREATE INDEX `checkin_admin_audit_event_idx` ON `checkin_admin_audit` (`event_id`,`occurred_at`);--> statement-breakpoint
ALTER TABLE `checkin_events` ADD `projection_privacy` text DEFAULT 'count' NOT NULL;--> statement-breakpoint
ALTER TABLE `checkin_events` ADD `expires_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `checkin_events`
SET `expires_at` = strftime('%Y-%m-%dT%H:%M:%fZ', `created_at`, '+30 days')
WHERE `expires_at` = '';--> statement-breakpoint
CREATE INDEX `checkin_events_expires_idx` ON `checkin_events` (`expires_at`);
