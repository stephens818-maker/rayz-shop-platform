CREATE TABLE "alert_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_key" text NOT NULL,
	"shop_id" uuid,
	"until" timestamp with time zone NOT NULL,
	"staff_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_dismissals_alert_key_unique" UNIQUE("alert_key")
);
--> statement-breakpoint
CREATE TABLE "client_nudges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"shop_id" uuid,
	"appointment_id" uuid,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"staff_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "digest_sends" (
	"date" date NOT NULL,
	"staff_id" uuid NOT NULL,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "digest_sends_date_staff_id_pk" PRIMARY KEY("date","staff_id")
);
--> statement-breakpoint
CREATE TABLE "shop_vendors" (
	"shop_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"account_number" text,
	CONSTRAINT "shop_vendors_shop_id_vendor_id_pk" PRIMARY KEY("shop_id","vendor_id")
);
--> statement-breakpoint
CREATE TABLE "terminal_readers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"label" text NOT NULL,
	"serial_number" text,
	"stripe_reader_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "terminal_readers_stripe_reader_id_unique" UNIQUE("stripe_reader_id")
);
--> statement-breakpoint
ALTER TABLE "brand_settings" ADD COLUMN "message_templates" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_settings" ADD COLUMN "lookups" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_settings" ADD COLUMN "digest" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "status" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "closed_until" date;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "closed_note" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "went_live_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "accent_color" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "logo_url" text;--> statement-breakpoint
ALTER TABLE "alert_dismissals" ADD CONSTRAINT "alert_dismissals_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_nudges" ADD CONSTRAINT "client_nudges_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_nudges" ADD CONSTRAINT "client_nudges_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_nudges" ADD CONSTRAINT "client_nudges_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_sends" ADD CONSTRAINT "digest_sends_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_vendors" ADD CONSTRAINT "shop_vendors_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_vendors" ADD CONSTRAINT "shop_vendors_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_readers" ADD CONSTRAINT "terminal_readers_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_dismissals_until_idx" ON "alert_dismissals" USING btree ("until");--> statement-breakpoint
CREATE INDEX "client_nudges_customer_idx" ON "client_nudges" USING btree ("customer_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "client_nudges_appt_idx" ON "client_nudges" USING btree ("appointment_id","kind");--> statement-breakpoint
CREATE INDEX "terminal_readers_shop_idx" ON "terminal_readers" USING btree ("shop_id");--> statement-breakpoint
UPDATE "shops" SET "status" = 'archived', "archived_at" = now(), "booking_enabled" = false WHERE NOT "active";--> statement-breakpoint
UPDATE "shops" SET "went_live_at" = "created_at" WHERE "active";--> statement-breakpoint
INSERT INTO "pay_groups" ("shop_id", "label", "export_tab", "anchor_start", "anchor_number", "period_days", "check_offset_days", "number_resets_yearly")
  SELECT "id", "name", "name", '2026-10-04', 1, 14, 6, true FROM "shops" WHERE "slug" = 'dubuque' ON CONFLICT ("shop_id") DO NOTHING;--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["locations.setup","settings.lists","clients.campaigns"]'::jsonb WHERE "key" = 'brand_admin' AND NOT ("permissions" ? 'locations.setup');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["clients.campaigns"]'::jsonb WHERE "key" IN ('regional_manager', 'shop_manager') AND NOT ("permissions" ? 'clients.campaigns');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["clients.campaigns"]'::jsonb WHERE "key" IS NULL AND "permissions" ? 'timeoff.approve' AND NOT ("permissions" ? 'clients.campaigns');--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_status" CHECK ("shops"."status" in ('setup', 'live', 'closed', 'archived') AND "shops"."active" = ("shops"."status" <> 'archived'));