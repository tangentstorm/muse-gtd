ALTER TABLE `projects` ADD `url` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `next_actions` ADD `url` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `ticklers` ADD `url` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `inbox_items` ADD `url` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `reference_items` ADD `url` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `someday_items` ADD `url` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `scheduled_items` ADD `url` text DEFAULT '' NOT NULL;
