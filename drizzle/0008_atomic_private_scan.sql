PRAGMA foreign_keys = OFF;--> statement-breakpoint
PRAGMA legacy_alter_table = OFF;--> statement-breakpoint
CREATE TABLE `checkin_attendee_id_map` (
	`event_id` text NOT NULL,
	`old_attendee_id` text NOT NULL,
	`new_attendee_id` text NOT NULL,
	PRIMARY KEY(`event_id`, `old_attendee_id`),
	UNIQUE(`event_id`, `new_attendee_id`)
);--> statement-breakpoint
INSERT INTO `checkin_attendee_id_map` (`event_id`, `old_attendee_id`, `new_attendee_id`)
SELECT `event_id`, `attendee_id`,
	'guest-' || ROW_NUMBER() OVER (PARTITION BY `event_id` ORDER BY `position`, `attendee_id`)
FROM `checkin_attendees`;--> statement-breakpoint
CREATE TABLE `checkin_attendees_new` (
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
	`checked_in_request_id` text,
	`original_json` text NOT NULL,
	PRIMARY KEY(`event_id`, `attendee_id`),
	FOREIGN KEY (`event_id`) REFERENCES `checkin_events`(`event_id`) ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `checkin_attendees_new` (
	`event_id`, `attendee_id`, `position`, `name`, `email`, `phone`, `ticket`,
	`approval_status`, `checked_in_at`, `checked_in_lane_id`, `checked_in_request_id`, `original_json`
)
SELECT a.`event_id`, m.`new_attendee_id`, a.`position`, a.`name`,
	CASE WHEN EXISTS (
		SELECT 1 FROM json_each(e.`selected_fields_json`) AS selected
		WHERE lower(replace(replace(replace(replace(replace(trim(selected.value), ' ', '_'), '-', '_'), '/', '_'), '(', ''), ')', ''))
			IN ('email', 'email_address', 'guest_email', '電子郵件', '信箱', '聯絡人_email')
	) THEN a.`email` ELSE '' END,
	CASE WHEN EXISTS (
		SELECT 1 FROM json_each(e.`selected_fields_json`) AS selected
		WHERE lower(replace(replace(replace(replace(replace(trim(selected.value), ' ', '_'), '-', '_'), '/', '_'), '(', ''), ')', ''))
			IN ('phone', 'phone_number', 'mobile', 'mobile_phone', '電話', '手機', '聯絡人_手機')
	) THEN a.`phone` ELSE '' END,
	CASE WHEN EXISTS (
		SELECT 1 FROM json_each(e.`selected_fields_json`) AS selected
		WHERE lower(replace(replace(replace(replace(replace(trim(selected.value), ' ', '_'), '-', '_'), '/', '_'), '(', ''), ')', ''))
			IN ('ticket_name', 'ticket_type', 'ticket', '票種', '票券')
	) THEN a.`ticket` ELSE '' END,
	CASE WHEN EXISTS (
		SELECT 1 FROM json_each(e.`selected_fields_json`) AS selected
		WHERE lower(replace(replace(replace(replace(replace(trim(selected.value), ' ', '_'), '-', '_'), '/', '_'), '(', ''), ')', ''))
			IN ('approval_status', 'status', 'guest_status', '報名狀態', '票券付款狀態')
	) THEN a.`approval_status` ELSE '' END,
	a.`checked_in_at`, a.`checked_in_lane_id`, NULL,
	CASE WHEN json_valid(a.`original_json`) AND json_valid(e.`selected_fields_json`) THEN (
		SELECT json_group_object(source.key, source.value)
		FROM json_each(a.`original_json`) AS source
		WHERE EXISTS (
			SELECT 1 FROM json_each(e.`selected_fields_json`) AS selected
			WHERE selected.value = source.key
		)
		AND lower(replace(replace(replace(replace(replace(trim(source.key), ' ', '_'), '-', '_'), '/', '_'), '(', ''), ')', '')) NOT IN (
			'qr_code_url', 'qrcode_url', 'qr_url', 'qr_code', 'qrcode', 'check_in_url',
			'checkin_url', 'ticket_key', 'qr', '報到碼', 'qr_code_序號', 'ticket_api_id',
			'ticket_id', 'guest_api_id', 'guest_id', 'id', '訂單編號', '報名序號', '檢查碼'
		)
	) ELSE '{}' END
FROM `checkin_attendees` AS a
JOIN `checkin_attendee_id_map` AS m
	ON m.`event_id` = a.`event_id` AND m.`old_attendee_id` = a.`attendee_id`
JOIN `checkin_events` AS e ON e.`event_id` = a.`event_id`;--> statement-breakpoint
CREATE TABLE `checkin_scan_keys_new` (
	`event_id` text NOT NULL,
	`key_hash` text NOT NULL,
	`attendee_id` text NOT NULL,
	PRIMARY KEY(`event_id`, `key_hash`),
	FOREIGN KEY (`event_id`) REFERENCES `checkin_events`(`event_id`) ON DELETE cascade,
	FOREIGN KEY (`event_id`,`attendee_id`) REFERENCES `checkin_attendees_new`(`event_id`,`attendee_id`) ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `checkin_scan_keys_new` (`event_id`, `key_hash`, `attendee_id`)
SELECT k.`event_id`, k.`key_hash`, m.`new_attendee_id`
FROM `checkin_scan_keys` AS k
JOIN `checkin_attendee_id_map` AS m
	ON m.`event_id` = k.`event_id` AND m.`old_attendee_id` = k.`attendee_id`;--> statement-breakpoint
CREATE TABLE `checkin_activity_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`attendee_id` text,
	`lane_id` text,
	`outcome` text NOT NULL CHECK(`outcome` IN ('success', 'duplicate', 'unknown', 'undo')),
	`checked_in_at` text,
	`occurred_at` text NOT NULL,
	`request_id` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `checkin_events`(`event_id`) ON DELETE cascade,
	FOREIGN KEY (`event_id`,`attendee_id`) REFERENCES `checkin_attendees_new`(`event_id`,`attendee_id`),
	FOREIGN KEY (`event_id`,`lane_id`) REFERENCES `checkin_lanes`(`event_id`,`lane_id`)
);--> statement-breakpoint
INSERT INTO `checkin_activity_new` (
	`id`, `event_id`, `attendee_id`, `lane_id`, `outcome`, `checked_in_at`, `occurred_at`, `request_id`
)
SELECT activity.`id`, activity.`event_id`, mapping.`new_attendee_id`, activity.`lane_id`,
	activity.`outcome`, activity.`checked_in_at`, activity.`occurred_at`, activity.`request_id`
FROM `checkin_activity` AS activity
LEFT JOIN `checkin_attendee_id_map` AS mapping
	ON mapping.`event_id` = activity.`event_id` AND mapping.`old_attendee_id` = activity.`attendee_id`;--> statement-breakpoint
DROP TABLE `checkin_activity`;--> statement-breakpoint
DROP TABLE `checkin_scan_keys`;--> statement-breakpoint
DROP TABLE `checkin_attendees`;--> statement-breakpoint
ALTER TABLE `checkin_attendees_new` RENAME TO `checkin_attendees`;--> statement-breakpoint
ALTER TABLE `checkin_scan_keys_new` RENAME TO `checkin_scan_keys`;--> statement-breakpoint
ALTER TABLE `checkin_activity_new` RENAME TO `checkin_activity`;--> statement-breakpoint
CREATE INDEX `checkin_attendees_event_position_idx` ON `checkin_attendees` (`event_id`,`position`);--> statement-breakpoint
CREATE INDEX `checkin_attendees_event_checked_idx` ON `checkin_attendees` (`event_id`,`checked_in_at`);--> statement-breakpoint
CREATE INDEX `checkin_attendees_event_name_idx` ON `checkin_attendees` (`event_id`,`name`);--> statement-breakpoint
CREATE INDEX `checkin_scan_keys_lookup_idx` ON `checkin_scan_keys` (`event_id`,`key_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `checkin_activity_request_idx` ON `checkin_activity` (`event_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `checkin_activity_event_cursor_idx` ON `checkin_activity` (`event_id`,`id`);--> statement-breakpoint
DROP TABLE `checkin_attendee_id_map`;--> statement-breakpoint
PRAGMA foreign_keys = ON;
