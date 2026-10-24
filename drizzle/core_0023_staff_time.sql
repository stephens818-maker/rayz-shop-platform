CREATE TABLE "time_block_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"shop_id" uuid,
	"category" text NOT NULL,
	"reason" text NOT NULL,
	"weekdays" smallint[] NOT NULL,
	"start_min" integer NOT NULL,
	"end_min" integer NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"materialized_through" date NOT NULL,
	"ended_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_block_series_order" CHECK ("time_block_series"."start_min" < "time_block_series"."end_min")
);
--> statement-breakpoint
CREATE TABLE "time_off_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"shop_id" uuid,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"start_min" integer,
	"end_min" integer,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_via" text,
	"requested_by" uuid,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_off_requests_order" CHECK ("time_off_requests"."starts_at" < "time_off_requests"."ends_at" AND "time_off_requests"."from_date" <= "time_off_requests"."to_date"),
	CONSTRAINT "time_off_requests_partial" CHECK (("time_off_requests"."start_min" IS NULL) = ("time_off_requests"."end_min" IS NULL) AND ("time_off_requests"."start_min" IS NULL OR "time_off_requests"."from_date" = "time_off_requests"."to_date"))
);
--> statement-breakpoint
ALTER TABLE "brand_settings" ADD COLUMN "staff_time" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "staff_time" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "time_blocks" ADD COLUMN "category" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "time_blocks" ADD COLUMN "series_id" uuid;--> statement-breakpoint
ALTER TABLE "time_blocks" ADD COLUMN "request_id" uuid;--> statement-breakpoint
ALTER TABLE "time_block_series" ADD CONSTRAINT "time_block_series_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_block_series" ADD CONSTRAINT "time_block_series_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off_requests" ADD CONSTRAINT "time_off_requests_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off_requests" ADD CONSTRAINT "time_off_requests_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "time_block_series_staff_idx" ON "time_block_series" USING btree ("staff_id");--> statement-breakpoint
CREATE INDEX "time_off_requests_staff_idx" ON "time_off_requests" USING btree ("staff_id","starts_at");--> statement-breakpoint
CREATE INDEX "time_off_requests_status_idx" ON "time_off_requests" USING btree ("status","starts_at");--> statement-breakpoint
ALTER TABLE "time_blocks" ADD CONSTRAINT "time_blocks_series_id_time_block_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."time_block_series"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_blocks" ADD CONSTRAINT "time_blocks_request_id_time_off_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."time_off_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "time_blocks_series_start_unique" ON "time_blocks" USING btree ("series_id","starts_at");--> statement-breakpoint
CREATE INDEX "time_blocks_request_idx" ON "time_blocks" USING btree ("request_id");--> statement-breakpoint
UPDATE "time_blocks" SET "category" = 'time_off' WHERE "kind" = 'day_off';--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["blocks.own"]'::jsonb WHERE "key" IN ('brand_admin', 'regional_manager', 'shop_manager', 'front_desk', 'barber') AND NOT ("permissions" ? 'blocks.own');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["blocks.others"]'::jsonb WHERE "key" IN ('brand_admin', 'regional_manager', 'shop_manager', 'front_desk') AND NOT ("permissions" ? 'blocks.others');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["blocks.own"]'::jsonb WHERE "key" IS NULL AND NOT ("permissions" ? 'blocks.own');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["blocks.others"]'::jsonb WHERE "key" IS NULL AND ("permissions" ? 'calendar.manage' OR "permissions" ? 'schedules.edit') AND NOT ("permissions" ? 'blocks.others');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["timeoff.request"]'::jsonb WHERE "key" IN ('brand_admin', 'regional_manager', 'shop_manager', 'front_desk', 'barber') AND NOT ("permissions" ? 'timeoff.request');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["timeoff.approve"]'::jsonb WHERE "key" IN ('brand_admin', 'regional_manager', 'shop_manager') AND NOT ("permissions" ? 'timeoff.approve');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["report.staffing.view","report.staffing.export"]'::jsonb WHERE "key" IN ('brand_admin', 'regional_manager', 'shop_manager') AND NOT ("permissions" ? 'report.staffing.view');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["report.staffing.view"]'::jsonb WHERE "key" = 'front_desk' AND NOT ("permissions" ? 'report.staffing.view');
