CREATE TABLE IF NOT EXISTS `weekly_items` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `name` text NOT NULL,
  `position` integer NOT NULL DEFAULT 0,
  `archived_at` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `weekly_results` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `item_id` integer NOT NULL REFERENCES `weekly_items`(`id`) ON DELETE CASCADE,
  `result_week` text NOT NULL,
  `passed` integer NOT NULL,
  `recorded_by` text NOT NULL DEFAULT ''
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `weekly_results_item_week_unique` ON `weekly_results` (`item_id`, `result_week`);
--> statement-breakpoint
INSERT INTO `weekly_items` (`name`, `position`)
SELECT 'Example weekly activity', 0
WHERE NOT EXISTS (
  SELECT 1 FROM `weekly_items`
  WHERE `name` = 'Example weekly activity'
);
