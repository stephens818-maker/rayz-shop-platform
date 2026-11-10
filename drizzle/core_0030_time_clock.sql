-- Time clock: punches (in, out, breaks) per shop, verified by a registered device, GPS or the shop's network; timesheets with employee and manager approval; period locks; full-time/part-time changes.
ALTER TABLE "brand_settings" ADD COLUMN "time_clock" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "latitude" double precision;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "longitude" double precision;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "time_clock" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "clock_pin_hash" text;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "clock_pin_failures" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "clock_pin_locked_until" timestamp with time zone;--> statement-breakpoint
CREATE TABLE "clock_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"label" text NOT NULL,
	"token_hash" text NOT NULL,
	"registered_by" uuid,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clock_devices_token_hash_unique" UNIQUE("token_hash")
);--> statement-breakpoint
ALTER TABLE "clock_devices" ADD CONSTRAINT "clock_devices_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clock_devices" ADD CONSTRAINT "clock_devices_registered_by_staff_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "time_punches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"type" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"method" text NOT NULL,
	"device_id" uuid,
	"latitude" double precision,
	"longitude" double precision,
	"accuracy_m" double precision,
	"distance_m" double precision,
	"ip" text,
	"has_photo" boolean DEFAULT false NOT NULL,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"off_schedule_min" integer,
	"forgot_flagged_at" timestamp with time zone,
	"original_at" timestamp with time zone NOT NULL,
	"edited_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_punches_type" CHECK ("type" in ('in', 'out', 'break_start', 'break_end')),
	CONSTRAINT "time_punches_source" CHECK ("source" in ('self', 'kiosk', 'manager')),
	CONSTRAINT "time_punches_method" CHECK ("method" in ('device', 'gps', 'network', 'none', 'manager'))
);--> statement-breakpoint
ALTER TABLE "time_punches" ADD CONSTRAINT "time_punches_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_punches" ADD CONSTRAINT "time_punches_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_punches" ADD CONSTRAINT "time_punches_device_id_clock_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."clock_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_punches" ADD CONSTRAINT "time_punches_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "time_punches_staff_at_idx" ON "time_punches" USING btree ("staff_id","at");--> statement-breakpoint
CREATE INDEX "time_punches_shop_at_idx" ON "time_punches" USING btree ("shop_id","at");--> statement-breakpoint
CREATE TABLE "time_punch_photos" (
	"punch_id" uuid PRIMARY KEY NOT NULL,
	"data_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "time_punch_photos" ADD CONSTRAINT "time_punch_photos_punch_id_time_punches_id_fk" FOREIGN KEY ("punch_id") REFERENCES "public"."time_punches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "time_punch_edits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"punch_id" uuid NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"reason" text NOT NULL,
	"edited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_punch_edits_reason" CHECK (length(trim("reason")) > 0)
);--> statement-breakpoint
ALTER TABLE "time_punch_edits" ADD CONSTRAINT "time_punch_edits_punch_id_time_punches_id_fk" FOREIGN KEY ("punch_id") REFERENCES "public"."time_punches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_punch_edits" ADD CONSTRAINT "time_punch_edits_edited_by_staff_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "time_punch_edits_punch_idx" ON "time_punch_edits" USING btree ("punch_id");--> statement-breakpoint
CREATE TRIGGER "time_punch_edits_append_only" BEFORE UPDATE OR DELETE ON "time_punch_edits" FOR EACH ROW EXECUTE FUNCTION "refuse_change_append_only"();--> statement-breakpoint
CREATE TABLE "timesheets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"employee_approved_at" timestamp with time zone,
	"manager_approved_at" timestamp with time zone,
	"manager_approved_by" uuid,
	"manager_note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timesheets_uq" UNIQUE("staff_id","shop_id","period_start")
);--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_manager_approved_by_staff_id_fk" FOREIGN KEY ("manager_approved_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "timesheet_locks" (
	"shop_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"locked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" uuid,
	CONSTRAINT "timesheet_locks_shop_id_period_start_pk" PRIMARY KEY("shop_id","period_start")
);--> statement-breakpoint
ALTER TABLE "timesheet_locks" ADD CONSTRAINT "timesheet_locks_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_locks" ADD CONSTRAINT "timesheet_locks_locked_by_staff_id_fk" FOREIGN KEY ("locked_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "ft_status_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"average_hours" double precision NOT NULL,
	"window_weeks" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ft_status_changes_uq" UNIQUE("staff_id","week_start")
);--> statement-breakpoint
ALTER TABLE "ft_status_changes" ADD CONSTRAINT "ft_status_changes_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "punch_in_id" uuid;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_punch_in_id_time_punches_id_fk" FOREIGN KEY ("punch_in_id") REFERENCES "public"."time_punches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "time_entries_punch_idx" ON "time_entries" USING btree ("punch_in_id");--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["timeclock.punch","timeclock.kiosk","timesheet.own","timesheet.edit","timesheet.approve","payroll.rates","payroll.export","report.labor.view","report.labor.export","report.attendance.view","report.attendance.export"]'::jsonb WHERE "key" = 'brand_admin' AND NOT ("permissions" ? 'timeclock.punch');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["timeclock.punch","timeclock.kiosk","timesheet.own","timesheet.edit","timesheet.approve","report.labor.view","report.labor.export","report.attendance.view","report.attendance.export"]'::jsonb WHERE "key" IN ('regional_manager', 'shop_manager') AND NOT ("permissions" ? 'timeclock.punch');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["timeclock.punch","timeclock.kiosk","timesheet.own"]'::jsonb WHERE "key" = 'front_desk' AND NOT ("permissions" ? 'timeclock.punch');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["timeclock.punch","timesheet.own"]'::jsonb WHERE "key" = 'barber' AND NOT ("permissions" ? 'timeclock.punch');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["timeclock.punch","timesheet.own"]'::jsonb WHERE "key" IS NULL AND "permissions" ? 'blocks.own' AND NOT ("permissions" ? 'timeclock.punch');
