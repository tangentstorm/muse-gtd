CREATE TABLE `daily_items` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `name` text NOT NULL,
  `position` integer NOT NULL DEFAULT 0,
  `archived_at` text
);
--> statement-breakpoint
CREATE TABLE `daily_results` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `item_id` integer NOT NULL REFERENCES `daily_items`(`id`) ON DELETE CASCADE,
  `result_date` text NOT NULL,
  `passed` integer NOT NULL,
  `recorded_by` text NOT NULL DEFAULT ''
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_results_item_date_unique` ON `daily_results` (`item_id`, `result_date`);
