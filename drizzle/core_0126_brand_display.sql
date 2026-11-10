-- How the brand shows times and payroll hours (DisplaySettings in src/domain/display.ts): 12-hour clock times by default.
ALTER TABLE "brand_settings" ADD COLUMN IF NOT EXISTS "display" jsonb DEFAULT '{}'::jsonb NOT NULL;
