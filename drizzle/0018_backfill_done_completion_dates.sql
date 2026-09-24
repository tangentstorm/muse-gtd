CREATE TABLE `_completion_backfill_anchor` (
  `earliest_completed_at` integer
);
--> statement-breakpoint
INSERT INTO `_completion_backfill_anchor` (`earliest_completed_at`)
SELECT MIN(`completed_at`)
FROM (
  SELECT `completed_at` FROM `next_actions` WHERE `status` <> 'active' AND `completed_at` IS NOT NULL
  UNION ALL
  SELECT `completed_at` FROM `projects` WHERE `status` <> 'active' AND `completed_at` IS NOT NULL
  UNION ALL
  SELECT `completed_at` FROM `ticklers` WHERE `status` <> 'pending' AND `completed_at` IS NOT NULL
);
--> statement-breakpoint
UPDATE `next_actions`
SET `completed_at` = COALESCE(
  CASE
    WHEN `created_at` IS NULL THEN NULL
    WHEN `created_at` < 100000000000 THEN `created_at` * 1000
    ELSE `created_at`
  END,
  (SELECT `earliest_completed_at` FROM `_completion_backfill_anchor` LIMIT 1)
)
WHERE `status` <> 'active' AND `completed_at` IS NULL;
--> statement-breakpoint
UPDATE `projects`
SET `completed_at` = COALESCE(
  CASE
    WHEN `created_at` IS NULL THEN NULL
    WHEN `created_at` < 100000000000 THEN `created_at` * 1000
    ELSE `created_at`
  END,
  (SELECT `earliest_completed_at` FROM `_completion_backfill_anchor` LIMIT 1)
)
WHERE `status` <> 'active' AND `completed_at` IS NULL;
--> statement-breakpoint
UPDATE `ticklers`
SET `completed_at` = COALESCE(
  CASE
    WHEN `created_at` IS NULL THEN NULL
    WHEN `created_at` < 100000000000 THEN `created_at` * 1000
    ELSE `created_at`
  END,
  (SELECT `earliest_completed_at` FROM `_completion_backfill_anchor` LIMIT 1)
)
WHERE `status` <> 'pending' AND `completed_at` IS NULL;
--> statement-breakpoint
DROP TABLE `_completion_backfill_anchor`;
