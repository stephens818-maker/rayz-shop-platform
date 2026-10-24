-- "We have openings": a location texts or emails one barber's regulars and recent clients that the barber has open times today or tomorrow. Each send is a marketing_campaigns row of kind 'openings' (one per barber), which the brand can be asked to approve first; the live page's "join the waitlist" goes in openings_waitlist. Location roles keep only We have openings in the Campaign Center: coupons, automated campaigns, segments, blasts, exports, barbers' own outreach and the marketing reports become the brand's to grant. Additive only.
ALTER TABLE "marketing_campaigns" ADD COLUMN "reviewed_by" uuid REFERENCES "staff"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD COLUMN "review_note" text;--> statement-breakpoint
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
UPDATE "roles" SET "permissions" = (
	SELECT coalesce(jsonb_agg(p), '[]'::jsonb) FROM jsonb_array_elements_text("permissions") p
	WHERE p NOT IN ('promos.manage', 'campaign_center.view', 'campaign_center.create', 'campaign_center.send', 'campaign_center.export', 'campaign_center.own_clients',
		'report.campaign_center.view', 'report.campaign_center.export', 'report.lapsed_clients.view', 'report.lapsed_clients.export',
		'campaign_center.openings', 'report.openings.view', 'report.openings.export')
) || '["campaign_center.openings","report.openings.view","report.openings.export"]'::jsonb WHERE "key" IN ('regional_manager', 'shop_manager');
