-- My banking: what Stripe returns about each employee's payout destination (its type, last 4 digits and bank or card name, never the full number), the requirements Stripe is still verifying, and the deadline for anything it needs.
ALTER TABLE "staff_payout_accounts" ADD COLUMN "destination_type" text;--> statement-breakpoint
ALTER TABLE "staff_payout_accounts" ADD COLUMN "destination_last4" text;--> statement-breakpoint
ALTER TABLE "staff_payout_accounts" ADD COLUMN "destination_name" text;--> statement-breakpoint
ALTER TABLE "staff_payout_accounts" ADD COLUMN "requirements_pending" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_payout_accounts" ADD COLUMN "requirements_deadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff_payout_accounts" ADD CONSTRAINT "staff_payout_accounts_destination_type" CHECK ("staff_payout_accounts"."destination_type" is null or "staff_payout_accounts"."destination_type" in ('bank_account', 'card'));--> statement-breakpoint
ALTER TABLE "staff_payout_accounts" ADD CONSTRAINT "staff_payout_accounts_last4" CHECK ("staff_payout_accounts"."destination_last4" is null or "staff_payout_accounts"."destination_last4" ~ '^[0-9]{4}$');
