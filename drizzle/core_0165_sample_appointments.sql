-- Seeded sample visits stay off the calendar. Rows are flagged, not deleted.
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "sample" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "appointments" AS a
SET "sample" = true
WHERE a."sample" = false
  AND NOT EXISTS (
    SELECT 1 FROM "customers" c
    WHERE c."id" = a."customer_id" AND lower(c."last_name") = 'zzcanary'
  )
  AND (
    a."code" LIKE 'DEMO%'
    OR (a."customer_id" IS NULL AND a."notes" = 'Walk-in')
    OR EXISTS (
      SELECT 1 FROM "customers" c
      WHERE c."id" = a."customer_id"
        AND (
          c."email" LIKE '%@example.test'
          OR (c."email" IS NULL AND c."phone" LIKE '%555%')
        )
    )
  );--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_visible_shop_time_idx" ON "appointments" ("shop_id", "starts_at") WHERE "sample" = false;
