ALTER TABLE "staff" ADD COLUMN "kind" text DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "last_sign_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_kind_known" CHECK ("kind" IN ('person', 'shop'));--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_shop_login_not_bookable" CHECK ("kind" = 'person' OR NOT "is_bookable");--> statement-breakpoint
-- Every message belongs to the shop it's from, so the outbox and the queue can be scoped by shop.
UPDATE "notification_jobs" j SET "shop_id" = a."shop_id" FROM "appointments" a WHERE j."shop_id" IS NULL AND j."appointment_id" = a."id";--> statement-breakpoint
UPDATE "notification_jobs" j SET "shop_id" = w."shop_id"
FROM (SELECT DISTINCT ON ("phone") "phone", "shop_id" FROM "waitlist_entries" WHERE "phone" IS NOT NULL ORDER BY "phone", "joined_at" DESC) w
WHERE j."shop_id" IS NULL AND j."kind" = 'waitlist_ready' AND j."to" = w."phone";--> statement-breakpoint
-- Older rows that can't be traced stay without a shop and are visible only brand-wide; new rows must have one.
ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_shop_present" CHECK ("shop_id" IS NOT NULL OR "kind" = 'otp') NOT VALID;--> statement-breakpoint
-- Shop logins can be managed per shop. Vendors and client merges touch records every shop shares, so
-- they only work with access to all shops; the templates for scoped roles no longer list them.
UPDATE "roles" SET "permissions" = "permissions" || '["logins.manage"]'::jsonb WHERE "key" IN ('brand_admin', 'regional_manager') AND NOT ("permissions" ? 'logins.manage');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" - 'vendors.manage' WHERE "key" = 'regional_manager';--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" - 'clients.merge' WHERE "key" IN ('regional_manager', 'shop_manager');
