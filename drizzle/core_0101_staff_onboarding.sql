-- Every employee re-registers for Stripe payouts under Ray'z (no Squire accounts carry over): who was invited to set up payouts and when, the reminders sent, why a tip payout is held (a manager, or waiting for the employee's Stripe setup), and the day Squire stops paying each shop's tips. Additive only.
CREATE TABLE IF NOT EXISTS "staff_onboarding_invites" (
  "staff_id" uuid PRIMARY KEY NOT NULL REFERENCES "staff"("id") ON DELETE cascade,
  "first_sent_at" timestamp with time zone NOT NULL,
  "first_sent_by" uuid REFERENCES "staff"("id") ON DELETE set null,
  "last_sent_at" timestamp with time zone NOT NULL,
  "last_sent_by" uuid REFERENCES "staff"("id") ON DELETE set null,
  "channels" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "invites" integer DEFAULT 1 NOT NULL,
  "reminders" integer DEFAULT 0 NOT NULL,
  "reminders_stopped_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "staff_onboarding_invites_channels" CHECK (jsonb_typeof("channels") = 'array' and "channels" <@ '["sms", "email"]'::jsonb),
  CONSTRAINT "staff_onboarding_invites_counts" CHECK ("invites" >= 1 and "reminders" >= 0)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_onboarding_invites_reminders" ON "staff_onboarding_invites" ("last_sent_at") WHERE "reminders_stopped_at" IS NULL;--> statement-breakpoint
ALTER TABLE "tip_payouts" ADD COLUMN IF NOT EXISTS "hold_kind" text;--> statement-breakpoint
UPDATE "tip_payouts" SET "hold_kind" = CASE WHEN "method" = 'stripe' AND "held_by" IS NULL AND "hold_reason" ILIKE '%stripe payout account%' THEN 'stripe_setup' ELSE 'manager' END
  WHERE "status" = 'held' AND "hold_kind" IS NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tip_payouts" ADD CONSTRAINT "tip_payouts_hold_kind" CHECK ("hold_kind" is null or "hold_kind" in ('manager', 'stripe_setup'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tip_payouts_stripe_setup" ON "tip_payouts" ("staff_id") WHERE "status" = 'held' AND "hold_kind" = 'stripe_setup';--> statement-breakpoint
ALTER TABLE "shop_cutovers" ADD COLUMN IF NOT EXISTS "squire_tips_end_on" date;
