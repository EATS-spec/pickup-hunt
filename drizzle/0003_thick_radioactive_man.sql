CREATE TABLE `hunt_push_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`endpoint_hash` text NOT NULL,
	`job_key` text,
	`store_number` text,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`receipt_hash` text NOT NULL,
	`state` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`not_before` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`locked_until` integer,
	`accepted_at` integer,
	`displayed_at` integer,
	`last_error` text
);
--> statement-breakpoint
CREATE INDEX `hunt_push_outbox_due_idx` ON `hunt_push_outbox` (`state`,`not_before`);--> statement-breakpoint
CREATE INDEX `hunt_push_outbox_session_idx` ON `hunt_push_outbox` (`session_id`);--> statement-breakpoint
CREATE TABLE `hunt_push_subscriptions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`subscription_json` text NOT NULL,
	`endpoint_hash` text NOT NULL,
	`public_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_test_at` integer,
	`last_sent_at` integer,
	`last_displayed_at` integer,
	`last_error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hunt_push_subscriptions_endpoint_hash_unique` ON `hunt_push_subscriptions` (`endpoint_hash`);