-- The brand setting `time_format` ('12h' | '24h', default '12h'), its own column as the customer API reads it (mobile's migration adds the same column and check). Carries over a 24-hour choice saved in display.clockFormat (core_0126), which then holds payroll hours only. Additive only.
ALTER TABLE "brand_settings" ADD COLUMN IF NOT EXISTS "time_format" text DEFAULT '12h' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "brand_settings" ADD CONSTRAINT "brand_settings_time_format_chk" CHECK ("time_format" IN ('12h', '24h'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
UPDATE "brand_settings" SET "time_format" = '24h' WHERE "display"->>'clockFormat' = '24h';--> statement-breakpoint
UPDATE "brand_settings" SET "display" = "display" - 'clockFormat' WHERE "display" ? 'clockFormat';
