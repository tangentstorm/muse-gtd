ALTER TABLE `next_actions` ADD `priority` text NOT NULL DEFAULT 'unprioritized';
--> statement-breakpoint
ALTER TABLE `inbox_items` ADD `priority` text NOT NULL DEFAULT 'unprioritized';
