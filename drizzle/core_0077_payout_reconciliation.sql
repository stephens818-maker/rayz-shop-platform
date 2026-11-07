-- Deposits matched to the bank statement: who matched each Stripe payout, when, and the bank's reference.
CREATE TABLE "payout_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payout_id" uuid NOT NULL REFERENCES "shop_payouts"("id") ON DELETE CASCADE,
	"bank_reference" text,
	"note" text,
	"reconciled_by" uuid REFERENCES "staff"("id") ON DELETE SET NULL,
	"reconciled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payout_reconciliations_payout_uq" UNIQUE ("payout_id"),
	CONSTRAINT "payout_reconciliations_ref_len" CHECK ("bank_reference" IS NULL OR length("bank_reference") <= 60)
);
--> statement-breakpoint
DROP TRIGGER IF EXISTS "payout_reconciliations_scrub_sensitive" ON "payout_reconciliations";--> statement-breakpoint
CREATE TRIGGER "payout_reconciliations_scrub_sensitive" BEFORE INSERT OR UPDATE OF "note", "bank_reference" ON "payout_reconciliations" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('note', 'bank_reference');
