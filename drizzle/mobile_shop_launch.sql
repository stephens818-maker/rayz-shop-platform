-- Per-shop launch instant. Null follows brand_settings.launch_at / LAUNCH_AT.
-- Set it earlier than the brand to pilot one shop, or later to hold a shop back.
ALTER TABLE "shops" ADD COLUMN "launch_at" timestamp with time zone;
