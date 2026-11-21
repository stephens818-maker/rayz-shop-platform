-- A flagged sample visit does not hold the chair. Real bookings can use that time. Rows are not deleted.
ALTER TABLE "appointments" DROP CONSTRAINT "appointments_no_double_booking";--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_no_double_booking"
  EXCLUDE USING gist ("staff_id" WITH =, tstzrange("starts_at", "ends_at", '[)') WITH &&)
  WHERE ("status" IN ('booked', 'confirmed', 'checked_in', 'in_service') AND NOT "sample");--> statement-breakpoint
ALTER TABLE "appointments" DROP CONSTRAINT "appointments_no_buffer_overlap";--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_no_buffer_overlap"
  EXCLUDE USING gist ("staff_id" WITH =, tstzrange(coalesce("busy_from", "starts_at"), coalesce("busy_until", "ends_at"), '[)') WITH &&)
  WHERE ("status" IN ('booked', 'confirmed', 'checked_in', 'in_service') AND NOT "squeezed" AND NOT "sample");
