-- When the Google review link is shown: the brand's rules (from the client's Nth completed visit, and a pause after they tap a location's link), with per-location overrides in each shop's receipt settings. Review follow-ups not sent for those reasons are recorded as skipped 'few_visits' or 'snoozed'.
ALTER TABLE "brand_settings" ADD COLUMN "reviews" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "receipt_deliveries" DROP CONSTRAINT "receipt_deliveries_skipped";--> statement-breakpoint
ALTER TABLE "receipt_deliveries" ADD CONSTRAINT "receipt_deliveries_skipped" CHECK ("receipt_deliveries"."skipped" is null or "receipt_deliveries"."skipped" in ('opted_out', 'no_consent', 'recent', 'few_visits', 'snoozed'));
