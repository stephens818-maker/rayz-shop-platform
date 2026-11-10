-- Employees' Stripe tip payouts: every bank account and debit card on their Express account (Stripe's id, type, name and last 4 only), who pays Stripe's instant payout fee, and where each payout went. Additive only.
ALTER TABLE "staff_payout_accounts" ADD COLUMN IF NOT EXISTS "external_accounts" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "staff_payout_accounts" ADD CONSTRAINT "staff_payout_accounts_external_accounts" CHECK (jsonb_typeof("external_accounts") = 'array');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
UPDATE "staff_payout_accounts" SET "external_accounts" = jsonb_build_array(jsonb_build_object(
    'id', 'sim_' || "destination_type" || '_' || "destination_last4",
    'type', "destination_type",
    'name', "destination_name",
    'last4', "destination_last4",
    'default', true,
    'instant', "instant_eligible" AND "destination_type" = 'card'))
  WHERE "simulated" AND "destination_last4" IS NOT NULL AND "external_accounts" = '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "tip_payouts" ADD COLUMN IF NOT EXISTS "instant_fee_paid_by" text DEFAULT 'employee' NOT NULL;--> statement-breakpoint
ALTER TABLE "tip_payouts" ADD COLUMN IF NOT EXISTS "destination_type" text;--> statement-breakpoint
ALTER TABLE "tip_payouts" ADD COLUMN IF NOT EXISTS "destination_last4" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tip_payouts" ADD CONSTRAINT "tip_payouts_instant_fee_paid_by" CHECK ("instant_fee_paid_by" in ('employee', 'shop'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tip_payouts" ADD CONSTRAINT "tip_payouts_destination" CHECK (("destination_type" is null or "destination_type" in ('bank_account', 'card')) and ("destination_last4" is null or "destination_last4" ~ '^[0-9]{4}$'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
