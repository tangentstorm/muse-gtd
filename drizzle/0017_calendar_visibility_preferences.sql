CREATE TABLE `calendar_visibility_preferences` (
  `id` integer PRIMARY KEY NOT NULL,
  `primary_visible` integer NOT NULL DEFAULT 1,
  `intent_visible` integer NOT NULL DEFAULT 1,
  `tangentcode_visible` integer NOT NULL DEFAULT 1,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `calendar_visibility_preferences` (`id`, `primary_visible`, `intent_visible`, `tangentcode_visible`, `updated_at`) VALUES (1, 1, 1, 1, CURRENT_TIMESTAMP);
