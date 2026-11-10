ALTER TABLE "appointments" ADD COLUMN "buffer_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "busy_until" timestamp with time zone;--> statement-breakpoint
-- timestamptz + interval isn't immutable, so the padded end can't be computed inside the
-- exclusion constraint; a trigger keeps busy_until = ends_at + buffer instead.
CREATE OR REPLACE FUNCTION appointments_set_busy_until() RETURNS trigger AS $$
BEGIN
  NEW.busy_until := NEW.ends_at + make_interval(mins => NEW.buffer_minutes);
  RETURN NEW;
END
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER appointments_busy_until BEFORE INSERT OR UPDATE OF ends_at, buffer_minutes, busy_until ON "appointments"
  FOR EACH ROW EXECUTE FUNCTION appointments_set_busy_until();--> statement-breakpoint
UPDATE "appointments" SET "busy_until" = "ends_at" + make_interval(mins => "buffer_minutes");--> statement-breakpoint
ALTER TABLE "appointments" DROP CONSTRAINT "appointments_no_double_booking";--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_no_double_booking"
  EXCLUDE USING gist ("staff_id" WITH =, tstzrange("starts_at", coalesce("busy_until", "ends_at"), '[)') WITH &&)
  WHERE ("status" IN ('booked', 'confirmed', 'checked_in', 'in_service'));
