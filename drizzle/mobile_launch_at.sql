-- One launch instant for the website, the customer apps, and customer-facing payments and push.
-- Null (and no LAUNCH_AT env) means not launched. Additive. Core migrations use the core_ prefix.
ALTER TABLE "brand_settings" ADD COLUMN "launch_at" timestamp with time zone;
