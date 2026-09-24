CREATE TABLE `calendar_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `google_event_id` text NOT NULL UNIQUE,
  `calendar_name` text NOT NULL DEFAULT 'primary',
  `title` text NOT NULL,
  `start_time` text NOT NULL,
  `end_time` text,
  `location` text,
  `is_all_day` integer NOT NULL DEFAULT 0,
  `synced_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `calendar_sync_state` (
  `id` integer PRIMARY KEY NOT NULL,
  `last_sync_at` text,
  `status` text NOT NULL DEFAULT 'unknown',
  `error_detail` text
);
--> statement-breakpoint
INSERT INTO `calendar_sync_state` (`id`, `status`) VALUES (1, 'unknown');
