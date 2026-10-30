-- ST-C0c: the email to a staff member about a sign-in on a new browser or phone has no shop.
ALTER TABLE "notification_jobs" DROP CONSTRAINT IF EXISTS "notification_jobs_shop_present";--> statement-breakpoint
ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_shop_present" CHECK ("shop_id" IS NOT NULL OR "kind" IN ('otp', 'privacy_alert', 'digest', 'saved_report', 'staff_invite', 'milestone', 'staff_app_invite', 'new_sign_in')) NOT VALID;
