-- Staff app invites (ST-C10) are brand messages like portal invites: sent to a person, not from a shop, so they carry no shop_id.
ALTER TABLE "notification_jobs" DROP CONSTRAINT IF EXISTS "notification_jobs_shop_present";--> statement-breakpoint
ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_shop_present" CHECK ("shop_id" IS NOT NULL OR "kind" IN ('otp', 'privacy_alert', 'digest', 'saved_report', 'staff_invite', 'milestone', 'staff_app_invite')) NOT VALID;
