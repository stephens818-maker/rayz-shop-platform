-- Per-staff settings from the Squire brand admin review. Booking options per barber for all shops (staff.booking_options) and "this shop only" (staff_shops.booking_options); notification channels and client reminder timings (staff.notification_prefs); days on outside the weekly schedule, kept with who added or removed them (staff_days_on); the tip a client chose while booking (appointments.booking_tip_cents); and drawer opens with no sale (cash_drawer_moves kind no_sale, amount 0). Additive only: empty options follow the shop, as before.
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "booking_options" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "notification_prefs" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_shops" ADD COLUMN IF NOT EXISTS "booking_options" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "booking_tip_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_days_on" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "staff_id" uuid NOT NULL REFERENCES "staff"("id") ON DELETE cascade,
  "shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
  "date" date NOT NULL,
  "start_min" integer NOT NULL,
  "end_min" integer NOT NULL,
  "note" text,
  "created_by" uuid REFERENCES "staff"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "removed_at" timestamp with time zone,
  "removed_by" uuid REFERENCES "staff"("id") ON DELETE set null,
  CONSTRAINT "staff_days_on_span" CHECK ("start_min" >= 0 and "end_min" <= 1440 and "end_min" > "start_min")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_days_on_staff_date_idx" ON "staff_days_on" ("staff_id", "date");--> statement-breakpoint
ALTER TABLE "cash_drawer_moves" DROP CONSTRAINT IF EXISTS "cash_drawer_moves_kind";--> statement-breakpoint
ALTER TABLE "cash_drawer_moves" ADD CONSTRAINT "cash_drawer_moves_kind" CHECK ("kind" in ('paid_in', 'paid_out', 'no_sale'));--> statement-breakpoint
ALTER TABLE "cash_drawer_moves" DROP CONSTRAINT IF EXISTS "cash_drawer_moves_amount";--> statement-breakpoint
ALTER TABLE "cash_drawer_moves" ADD CONSTRAINT "cash_drawer_moves_amount" CHECK (("kind" = 'no_sale' and "amount_cents" = 0) or ("kind" <> 'no_sale' and "amount_cents" > 0));--> statement-breakpoint
DROP TRIGGER IF EXISTS "staff_days_on_scrub_sensitive" ON "staff_days_on";--> statement-breakpoint
CREATE TRIGGER "staff_days_on_scrub_sensitive" BEFORE INSERT OR UPDATE OF "note" ON "staff_days_on" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('note');
