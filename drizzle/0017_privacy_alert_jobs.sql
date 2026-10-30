-- Unusual-lookup alerts go to brand admins, not to a shop, so like sign-in codes they have no shop.
ALTER TABLE "notification_jobs" DROP CONSTRAINT "notification_jobs_shop_present";--> statement-breakpoint
ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_shop_present" CHECK ("shop_id" IS NOT NULL OR "kind" IN ('otp', 'privacy_alert')) NOT VALID;
