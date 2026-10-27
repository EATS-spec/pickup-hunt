CREATE TABLE `hunt_catalog` (
	`id` text PRIMARY KEY NOT NULL,
	`payload_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hunt_engine` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`request_times_json` text DEFAULT '[]' NOT NULL,
	`backoff_until` integer DEFAULT 0 NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`locked_until` integer DEFAULT 0 NOT NULL,
	`lock_token` text,
	`next_allowed_at` integer DEFAULT 0 NOT NULL,
	`last_tick_at` integer,
	`last_tick_json` text
);
--> statement-breakpoint
CREATE TABLE `hunt_jobs` (
	`key` text PRIMARY KEY NOT NULL,
	`zip` text NOT NULL,
	`variant_json` text NOT NULL,
	`state_json` text DEFAULT '{}' NOT NULL,
	`checked_at` integer,
	`requested_at` integer,
	`last_attempt_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `hunt_jobs_checked_idx` ON `hunt_jobs` (`checked_at`);--> statement-breakpoint
CREATE INDEX `hunt_jobs_zip_idx` ON `hunt_jobs` (`zip`);--> statement-breakpoint
CREATE TABLE `hunt_watches` (
	`id` text PRIMARY KEY NOT NULL,
	`settings_json` text NOT NULL,
	`job_key` text NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`expires_at` integer,
	`requested_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `hunt_watches_job_idx` ON `hunt_watches` (`job_key`);--> statement-breakpoint
CREATE INDEX `hunt_watches_expiry_idx` ON `hunt_watches` (`enabled`,`expires_at`);