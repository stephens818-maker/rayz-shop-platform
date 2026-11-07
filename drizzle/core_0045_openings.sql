-- "We have openings": a location texts or emails one barber's regulars and recent clients that the barber has open times today or tomorrow. Each send is a marketing_campaigns row of kind 'openings' (one per barber), which the brand can be asked to approve first; the live page's "join the waitlist" goes in openings_waitlist. Location roles keep only We have openings in the Campaign Center: coupons, automated campaigns, segments, blasts, exports, barbers' own outreach and the marketing reports become the brand's to grant. Additive only.
ALTER TABLE "marketing_campaigns" DROP CONSTRAINT "marketing_campaigns_kind_chk";--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_kind_chk" CHECK ("kind" in ('trigger', 'blast', 'sequence', 'openings') and ("kind" = 'trigger') = ("trigger" is not null));--> statement-breakpoint
ALTER TABLE "marketing_campaigns" DROP CONSTRAINT "marketing_campaigns_status_chk";--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_status_chk" CHECK ("status" in ('draft', 'scheduled', 'sending', 'sent', 'cancelled', 'pending_approval', 'rejected', 'expired'));--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD COLUMN "reviewed_by" uuid REFERENCES "staff"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD COLUMN "review_note" text;--> statement-breakpoint
CREATE TRIGGER "marketing_campaigns_scrub_sensitive" BEFORE INSERT OR UPDATE OF "review_note" ON "marketing_campaigns" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('review_note');--> statement-breakpoint
CREATE INDEX "marketing_campaigns_kind_idx" ON "marketing_campaigns" ("kind", "created_at");--> statement-breakpoint
CREATE TABLE "openings_waitlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL REFERENCES "marketing_campaigns"("id") ON DELETE cascade,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
	"staff_id" uuid REFERENCES "staff"("id") ON DELETE set null,
	"customer_id" uuid REFERENCES "customers"("id") ON DELETE set null,
	"first_name" text NOT NULL,
	"phone" text NOT NULL,
	"wants_date" date,
	"status" text DEFAULT 'waiting' NOT NULL,
	"texted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openings_waitlist_status_chk" CHECK ("status" in ('waiting', 'texted', 'removed'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "openings_waitlist_phone_uq" ON "openings_waitlist" ("campaign_id", "phone");--> statement-breakpoint
CREATE INDEX "openings_waitlist_shop_idx" ON "openings_waitlist" ("shop_id", "status", "created_at");--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["campaign_center.openings","report.openings.view","report.openings.export"]'::jsonb WHERE "key" = 'brand_admin' AND NOT ("permissions" ? 'campaign_center.openings');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["campaign_center.openings","report.openings.view"]'::jsonb WHERE "key" = 'front_desk' AND NOT ("permissions" ? 'campaign_center.openings');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" - 'promos.manage' WHERE "key" IN ('regional_manager', 'shop_manager');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" - 'campaign_center.view' WHERE "key" IN ('regional_manager', 'shop_manager');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" - 'campaign_center.create' WHERE "key" IN ('regional_manager', 'shop_manager');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" - 'campaign_center.send' WHERE "key" IN ('regional_manager', 'shop_manager');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" - 'campaign_center.export' WHERE "key" IN ('regional_manager', 'shop_manager');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" - 'campaign_center.own_clients' WHERE "key" IN ('regional_manager', 'shop_manager');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" - 'report.campaign_center.view' WHERE "key" IN ('regional_manager', 'shop_manager');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" - 'report.campaign_center.export' WHERE "key" IN ('regional_manager', 'shop_manager');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" - 'report.lapsed_clients.view' WHERE "key" IN ('regional_manager', 'shop_manager');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" - 'report.lapsed_clients.export' WHERE "key" IN ('regional_manager', 'shop_manager');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["campaign_center.openings","report.openings.view","report.openings.export"]'::jsonb WHERE "key" IN ('regional_manager', 'shop_manager') AND NOT ("permissions" ? 'campaign_center.openings');--> statement-breakpoint
UPDATE "roles" SET "description" = 'Manages several shops: front desk, POS, clients, staff and shop settings, the Campaign Center''s We have openings, with every report for those shops but the brand''s marketing reports.' WHERE "key" = 'regional_manager' AND "description" = 'Manages several shops: front desk, POS, clients, staff and shop settings, with every report for those shops.';--> statement-breakpoint
UPDATE "roles" SET "description" = 'Manages one shop: front desk, POS, clients, staff and shop settings, the Campaign Center''s We have openings, with that shop''s reports but the brand''s marketing reports.' WHERE "key" = 'shop_manager' AND "description" = 'Manages one shop: front desk, POS, clients, staff and shop settings, with that shop''s reports.';--> statement-breakpoint
UPDATE "roles" SET "description" = 'Books and checks out every barber''s clients, runs walk-ins and the drawer, and sends We have openings. Small discounts only.' WHERE "key" = 'front_desk' AND "description" = 'Books and checks out every barber''s clients, runs walk-ins and the drawer. Small discounts only.';
