CREATE TABLE "staff_service_durations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"shop_id" uuid,
	"duration_min" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_service_durations_uq" UNIQUE NULLS NOT DISTINCT("staff_id","service_id","shop_id")
);
--> statement-breakpoint
ALTER TABLE "shops" ALTER COLUMN "slot_interval_minutes" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "shops" ALTER COLUMN "slot_interval_minutes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "buffer_before_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "busy_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "squeezed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_settings" ADD COLUMN "slot_interval_minutes" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "duration_step_min" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "booking_increment_min" integer;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "buffer_before_min" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "buffer_after_min" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "slot_interval_minutes" integer;--> statement-breakpoint
ALTER TABLE "staff_shops" ADD COLUMN "slot_interval_minutes" integer;--> statement-breakpoint
ALTER TABLE "staff_service_durations" ADD CONSTRAINT "staff_service_durations_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_service_durations" ADD CONSTRAINT "staff_service_durations_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_service_durations" ADD CONSTRAINT "staff_service_durations_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_service_durations_staff_idx" ON "staff_service_durations" USING btree ("staff_id");--> statement-breakpoint
-- Shops on the old 15-minute default now follow the brand default (also 15), so changing it in the brand portal reaches them.
UPDATE "shops" SET "slot_interval_minutes" = NULL WHERE "slot_interval_minutes" = 15;--> statement-breakpoint
ALTER TABLE "brand_settings" ADD CONSTRAINT "brand_settings_slot_interval_valid" CHECK ("slot_interval_minutes" BETWEEN 5 AND 120 AND "slot_interval_minutes" % 5 = 0);--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_slot_interval_valid" CHECK ("slot_interval_minutes" BETWEEN 5 AND 120 AND "slot_interval_minutes" % 5 = 0);--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_slot_interval_valid" CHECK ("slot_interval_minutes" BETWEEN 5 AND 120 AND "slot_interval_minutes" % 5 = 0);--> statement-breakpoint
ALTER TABLE "staff_shops" ADD CONSTRAINT "staff_shops_slot_interval_valid" CHECK ("slot_interval_minutes" BETWEEN 5 AND 120 AND "slot_interval_minutes" % 5 = 0);--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_timing_valid" CHECK (
  "duration_step_min" IN (5, 10, 15, 20, 30)
  AND ("booking_increment_min" IS NULL OR ("booking_increment_min" BETWEEN 5 AND 120 AND "booking_increment_min" % 5 = 0))
  AND "buffer_before_min" BETWEEN 0 AND 120 AND "buffer_after_min" BETWEEN 0 AND 120
);--> statement-breakpoint
ALTER TABLE "staff_service_durations" ADD CONSTRAINT "staff_service_durations_valid" CHECK ("duration_min" BETWEEN 5 AND 480);--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_buffers_valid" CHECK ("buffer_minutes" >= 0 AND "buffer_before_minutes" >= 0);--> statement-breakpoint
-- The chair is held from busy_from (prep) to busy_until (cleanup and the shop's gap).
CREATE OR REPLACE FUNCTION appointments_set_busy_until() RETURNS trigger AS $$
BEGIN
  NEW.busy_from := NEW.starts_at - make_interval(mins => NEW.buffer_before_minutes);
  NEW.busy_until := NEW.ends_at + make_interval(mins => NEW.buffer_minutes);
  RETURN NEW;
END
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER appointments_busy_until ON "appointments";--> statement-breakpoint
CREATE TRIGGER appointments_busy_until BEFORE INSERT OR UPDATE OF starts_at, ends_at, buffer_minutes, buffer_before_minutes, busy_from, busy_until ON "appointments"
  FOR EACH ROW EXECUTE FUNCTION appointments_set_busy_until();--> statement-breakpoint
UPDATE "appointments" SET "busy_from" = "starts_at" - make_interval(mins => "buffer_before_minutes");--> statement-breakpoint
-- Two constraints: service times never overlap, and buffers don't either unless staff squeezed the booking in.
ALTER TABLE "appointments" DROP CONSTRAINT "appointments_no_double_booking";--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_no_double_booking"
  EXCLUDE USING gist ("staff_id" WITH =, tstzrange("starts_at", "ends_at", '[)') WITH &&)
  WHERE ("status" IN ('booked', 'confirmed', 'checked_in', 'in_service'));--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_no_buffer_overlap"
  EXCLUDE USING gist ("staff_id" WITH =, tstzrange(coalesce("busy_from", "starts_at"), coalesce("busy_until", "ends_at"), '[)') WITH &&)
  WHERE ("status" IN ('booked', 'confirmed', 'checked_in', 'in_service') AND NOT "squeezed");--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["scheduling.timing","calendar.squeeze_in"]'::jsonb WHERE "key" IN ('brand_admin', 'regional_manager', 'shop_manager') AND NOT ("permissions" ? 'scheduling.timing');
