-- Marketing / Engage: coupons (free items, targets, locations, minimum spend, limits per client, single-use codes, first visit only, stacking, auto-apply) with every redemption recorded; coupons held from online booking; automated and one-off campaigns with per-location switches; idempotent sends with tracked links; unsubscribes; unfinished online bookings; client tags; the brand's marketing rules; and the marketing permissions and report.
ALTER TABLE "promo_codes" ADD COLUMN "free_item_kind" text;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD COLUMN "free_item_id" uuid;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD COLUMN "service_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD COLUMN "product_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD COLUMN "shop_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD COLUMN "min_spend_cents" integer;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD COLUMN "max_per_customer" integer;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD COLUMN "code_mode" text DEFAULT 'shared' NOT NULL;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD COLUMN "valid_days" integer;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD COLUMN "first_visit_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD COLUMN "stackable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD COLUMN "auto_apply" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_type_chk" CHECK ("type" in ('percent', 'amount', 'free_item'));--> statement-breakpoint
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_code_mode_chk" CHECK ("code_mode" in ('shared', 'unique'));--> statement-breakpoint
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_free_item_chk" CHECK ("type" <> 'free_item' or ("free_item_id" is not null and "free_item_kind" in ('service', 'addon', 'product')));--> statement-breakpoint
ALTER TABLE "brand_settings" ADD COLUMN "marketing" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE TABLE "coupon_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"promo_id" uuid NOT NULL REFERENCES "promo_codes"("id") ON DELETE cascade,
	"code" text NOT NULL UNIQUE,
	"customer_id" uuid REFERENCES "customers"("id") ON DELETE cascade,
	"campaign_id" uuid,
	"expires_on" date,
	"redeemed_at" timestamp with time zone,
	"sale_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "coupon_codes_customer_idx" ON "coupon_codes" ("customer_id", "promo_id");--> statement-breakpoint
CREATE TABLE "coupon_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"promo_id" uuid NOT NULL REFERENCES "promo_codes"("id"),
	"coupon_code_id" uuid REFERENCES "coupon_codes"("id"),
	"sale_id" uuid NOT NULL REFERENCES "sales"("id") ON DELETE cascade,
	"customer_id" uuid REFERENCES "customers"("id") ON DELETE set null,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id"),
	"staff_id" uuid,
	"campaign_id" uuid,
	"discount_cents" integer NOT NULL,
	"via" text NOT NULL,
	"reversed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupon_redemptions_sale_promo_uq" UNIQUE ("sale_id", "promo_id"),
	CONSTRAINT "coupon_redemptions_via_chk" CHECK ("via" in ('code', 'booking', 'auto'))
);--> statement-breakpoint
CREATE INDEX "coupon_redemptions_customer_idx" ON "coupon_redemptions" ("customer_id", "promo_id");--> statement-breakpoint
CREATE INDEX "coupon_redemptions_campaign_idx" ON "coupon_redemptions" ("campaign_id");--> statement-breakpoint
CREATE TABLE "appointment_coupons" (
	"appointment_id" uuid PRIMARY KEY NOT NULL REFERENCES "appointments"("id") ON DELETE cascade,
	"promo_id" uuid NOT NULL REFERENCES "promo_codes"("id") ON DELETE cascade,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "marketing_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"trigger" text,
	"name" text NOT NULL,
	"channels" jsonb DEFAULT '["sms","email","push"]'::jsonb NOT NULL,
	"templates" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"segment" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"promo_id" uuid REFERENCES "promo_codes"("id") ON DELETE set null,
	"shop_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketing_campaigns_kind_chk" CHECK ("kind" in ('trigger', 'blast') and ("kind" = 'blast') = ("trigger" is null)),
	CONSTRAINT "marketing_campaigns_status_chk" CHECK ("status" in ('draft', 'scheduled', 'sending', 'sent', 'cancelled'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "marketing_campaigns_trigger_uq" ON "marketing_campaigns" ("trigger") WHERE "kind" = 'trigger';--> statement-breakpoint
CREATE INDEX "marketing_campaigns_due_idx" ON "marketing_campaigns" ("status", "scheduled_at");--> statement-breakpoint
CREATE TABLE "marketing_location_settings" (
	"campaign_id" uuid NOT NULL REFERENCES "marketing_campaigns"("id") ON DELETE cascade,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
	"enabled" boolean DEFAULT false NOT NULL,
	"templates" jsonb,
	"settings" jsonb,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketing_location_settings_pk" PRIMARY KEY ("campaign_id", "shop_id")
);--> statement-breakpoint
CREATE TABLE "marketing_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL REFERENCES "marketing_campaigns"("id") ON DELETE cascade,
	"customer_id" uuid REFERENCES "customers"("id") ON DELETE cascade,
	"shop_id" uuid REFERENCES "shops"("id") ON DELETE set null,
	"staff_id" uuid,
	"channel" text,
	"dedupe_key" text NOT NULL UNIQUE,
	"status" text NOT NULL,
	"skipped" text,
	"job_id" uuid REFERENCES "notification_jobs"("id") ON DELETE set null,
	"coupon_code_id" uuid REFERENCES "coupon_codes"("id") ON DELETE set null,
	"token" text NOT NULL UNIQUE,
	"clicks" integer DEFAULT 0 NOT NULL,
	"first_click_at" timestamp with time zone,
	"cost_cents" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketing_sends_status_chk" CHECK ("status" in ('queued', 'skipped', 'test')),
	CONSTRAINT "marketing_sends_channel_chk" CHECK ("channel" is null or "channel" in ('sms', 'email', 'push'))
);--> statement-breakpoint
CREATE INDEX "marketing_sends_campaign_idx" ON "marketing_sends" ("campaign_id", "created_at");--> statement-breakpoint
CREATE INDEX "marketing_sends_customer_idx" ON "marketing_sends" ("customer_id", "created_at");--> statement-breakpoint
CREATE TABLE "marketing_unsubscribes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"customer_id" uuid REFERENCES "customers"("id") ON DELETE cascade,
	"email" text,
	"phone" text,
	"source" text NOT NULL,
	"campaign_id" uuid REFERENCES "marketing_campaigns"("id") ON DELETE set null,
	"send_id" uuid REFERENCES "marketing_sends"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketing_unsubscribes_channel_chk" CHECK ("channel" in ('sms', 'email', 'push')),
	CONSTRAINT "marketing_unsubscribes_source_chk" CHECK ("source" in ('link', 'stop', 'staff'))
);--> statement-breakpoint
CREATE INDEX "marketing_unsubscribes_customer_idx" ON "marketing_unsubscribes" ("customer_id");--> statement-breakpoint
CREATE INDEX "marketing_unsubscribes_email_idx" ON "marketing_unsubscribes" ("email");--> statement-breakpoint
CREATE INDEX "marketing_unsubscribes_phone_idx" ON "marketing_unsubscribes" ("phone");--> statement-breakpoint
CREATE TABLE "booking_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL UNIQUE,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
	"customer_id" uuid REFERENCES "customers"("id") ON DELETE set null,
	"service_id" uuid,
	"staff_id" uuid,
	"starts_at" timestamp with time zone,
	"appointment_id" uuid REFERENCES "appointments"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "booking_drafts_open_idx" ON "booking_drafts" ("updated_at") WHERE "appointment_id" is null;--> statement-breakpoint
CREATE TABLE "customer_tags" (
	"customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE cascade,
	"tag" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_tags_pk" PRIMARY KEY ("customer_id", "tag")
);--> statement-breakpoint
CREATE INDEX "customer_tags_tag_idx" ON "customer_tags" ("tag");--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["marketing.view","marketing.location","marketing.manage","report.marketing.view","report.marketing.export"]'::jsonb WHERE "key" IN ('brand_admin') AND NOT ("permissions" ? 'marketing.view');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["marketing.view","marketing.location","report.marketing.view","report.marketing.export"]'::jsonb WHERE "key" IN ('regional_manager', 'shop_manager') AND NOT ("permissions" ? 'marketing.view');
