-- Family booking groups: a parent and up to the brand's limit of children booked together in one go. The appointments link to one group (appointments.group_id) with its own unguessable code for the one cancel/reschedule link, one confirmation and one set of reminders. The group carries the one deposit and no-show rule for everyone in it; a deposit taken is held as a credit (a gift card with source 'deposit') applied at the group's checkout. Additive only.
CREATE TABLE IF NOT EXISTS "booking_groups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" text NOT NULL,
  "shop_id" uuid NOT NULL REFERENCES "shops"("id"),
  "guardian_id" uuid NOT NULL REFERENCES "customers"("id"),
  "plan" text NOT NULL,
  "source" "appointment_source" NOT NULL,
  "deposit_cents" integer DEFAULT 0 NOT NULL,
  "deposit_status" text DEFAULT 'none' NOT NULL,
  "deposit_sale_id" uuid REFERENCES "sales"("id") ON DELETE set null,
  "deposit_gift_card_id" uuid REFERENCES "gift_cards"("id") ON DELETE set null,
  "idempotency_key" text,
  "created_by" uuid,
  "cancelled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "booking_groups_code_unique" UNIQUE("code"),
  CONSTRAINT "booking_groups_idempotency_key_unique" UNIQUE("idempotency_key"),
  CONSTRAINT "booking_groups_plan" CHECK ("plan" IN ('same_barber', 'together', 'earliest_finish', 'custom', 'walk_in')),
  CONSTRAINT "booking_groups_deposit_status" CHECK ("deposit_status" IN ('none', 'due', 'held', 'applied', 'forfeited', 'refund_due', 'refunded', 'waived')),
  CONSTRAINT "booking_groups_deposit_cents" CHECK ("deposit_cents" >= 0)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "booking_groups_guardian_idx" ON "booking_groups" USING btree ("guardian_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "booking_groups_deposit_sale_idx" ON "booking_groups" USING btree ("deposit_sale_id") WHERE "deposit_sale_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "group_id" uuid REFERENCES "booking_groups"("id") ON DELETE set null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_group_idx" ON "appointments" USING btree ("group_id") WHERE "group_id" IS NOT NULL;
