-- The morning digest goes to the owner and managers across their shops, so like sign-in codes and lookup alerts it has no shop.
ALTER TABLE "notification_jobs" DROP CONSTRAINT "notification_jobs_shop_present";--> statement-breakpoint
ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_shop_present" CHECK ("shop_id" IS NOT NULL OR "kind" IN ('otp', 'privacy_alert', 'digest')) NOT VALID;
