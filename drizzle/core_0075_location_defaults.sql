-- Brand defaults every location inherits, and each location's own values ("this shop only").
ALTER TABLE "brand_settings" ADD COLUMN "location_defaults" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "brand_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
-- A shop already set away from the built-in value keeps it as its own.
UPDATE "shops" SET "brand_overrides" = jsonb_strip_nulls(jsonb_build_object(
  'cancelCutoffMinutes', CASE WHEN "cancel_cutoff_minutes" <> 30 THEN "cancel_cutoff_minutes" END,
  'minLeadMinutes', CASE WHEN "min_lead_minutes" <> 15 THEN "min_lead_minutes" END,
  'bookingWindowDays', CASE WHEN "booking_window_days" <> 60 THEN "booking_window_days" END,
  'bufferMinutes', CASE WHEN "buffer_minutes" <> 0 THEN "buffer_minutes" END,
  'drawerOpeningCents', CASE WHEN "drawer_opening_cents" <> 30000 THEN "drawer_opening_cents" END,
  'accentColor', lower("accent_color")
));
