-- My Earnings, the staff app's payouts screen (2026-10-28): each Stripe tip payout's own status and expected arrival date as Stripe reports them (payout.created, payout.updated, payout.paid, payout.failed, payout.canceled), when a payout already paid came back from the bank, and when Stripe itself reversed a tip transferred at the sale. The platform never reverses a tip, so that column is set only from Stripe's transfer.reversed. Additive only.
ALTER TABLE "tip_payouts" ADD COLUMN IF NOT EXISTS "stripe_status" text;--> statement-breakpoint
ALTER TABLE "tip_payouts" ADD COLUMN IF NOT EXISTS "arrival_date" date;--> statement-breakpoint
ALTER TABLE "tip_payouts" ADD COLUMN IF NOT EXISTS "returned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_transfers" ADD COLUMN IF NOT EXISTS "stripe_reversed_at" timestamp with time zone;
