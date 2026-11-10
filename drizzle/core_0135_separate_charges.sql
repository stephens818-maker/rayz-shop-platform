-- I10, approved by Charles (2026-10-28): separate charges and transfers. Every card sale is charged on the platform with a transfer_group; afterwards the shop's portion (service, product, tax and the card surcharge, less the processing fee) is transferred to the shop's connected account, and, behind FEATURE_TIP_TO_BARBER, each barber's tip to their Stripe Express account, both with source_transaction so they wait for the charge's funds. Refunds and disputes reverse the shop's transfer only; a tip transfer is never reversed. Payments from before this keep their destination charges. Additive only.
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "charge_type" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "transfer_group" text;--> statement-breakpoint
UPDATE "payments" SET "charge_type" = 'destination' WHERE "charge_type" IS NULL AND "settlement" = 'connected';--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "payments" ADD CONSTRAINT "payments_charge_type" CHECK ("charge_type" IS NULL OR "charge_type" IN ('destination', 'separate'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL REFERENCES "payments"("id"),
	"sale_id" uuid NOT NULL REFERENCES "sales"("id"),
	"shop_id" uuid NOT NULL REFERENCES "shops"("id"),
	"kind" text NOT NULL,
	"staff_id" uuid REFERENCES "staff"("id"),
	"destination_account" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"transfer_group" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"stripe_transfer_id" text,
	"reversed_cents" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_transfers_kind" CHECK ("kind" IN ('shop', 'tip')),
	CONSTRAINT "payment_transfers_staff" CHECK (("kind" = 'tip') = ("staff_id" IS NOT NULL)),
	CONSTRAINT "payment_transfers_status" CHECK ("status" IN ('pending', 'sent', 'failed', 'cancelled')),
	CONSTRAINT "payment_transfers_amount" CHECK ("amount_cents" >= 0 AND ("amount_cents" > 0 OR "status" = 'cancelled')),
	CONSTRAINT "payment_transfers_sent" CHECK (("status" = 'sent') = ("stripe_transfer_id" IS NOT NULL)),
	CONSTRAINT "payment_transfers_reversed" CHECK ("reversed_cents" >= 0 AND "reversed_cents" <= "amount_cents"),
	CONSTRAINT "payment_transfers_tips_kept" CHECK ("kind" = 'shop' OR "reversed_cents" = 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_transfers_shop_uq" ON "payment_transfers" USING btree ("payment_id") WHERE "kind" = 'shop';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_transfers_tip_uq" ON "payment_transfers" USING btree ("payment_id", "staff_id") WHERE "kind" = 'tip';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_transfers_stripe_uq" ON "payment_transfers" USING btree ("stripe_transfer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_transfers_sale_idx" ON "payment_transfers" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_transfers_pending_idx" ON "payment_transfers" USING btree ("created_at") WHERE "status" = 'pending';--> statement-breakpoint
-- What a refund or dispute took back from a shop's transfer (the shop portion only), and what a won dispute sent back to the shop. uncovered_cents is the part of a refund or dispute the shop's transfer couldn't cover (a tip already with the barber); the platform carries it.
CREATE TABLE IF NOT EXISTS "payment_transfer_reversals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transfer_id" uuid NOT NULL REFERENCES "payment_transfers"("id"),
	"payment_id" uuid NOT NULL REFERENCES "payments"("id"),
	"kind" text NOT NULL,
	"refund_id" uuid REFERENCES "refunds"("id"),
	"stripe_dispute_id" text,
	"amount_cents" integer NOT NULL,
	"uncovered_cents" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"stripe_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_transfer_reversals_kind" CHECK ("kind" IN ('refund', 'dispute', 'dispute_won')),
	CONSTRAINT "payment_transfer_reversals_source" CHECK (("kind" = 'refund') = ("refund_id" IS NOT NULL) AND ("kind" = 'refund') = ("stripe_dispute_id" IS NULL)),
	CONSTRAINT "payment_transfer_reversals_dispute_id" CHECK ("stripe_dispute_id" IS NULL OR "stripe_dispute_id" ~ '^(dp|du|sim)_[A-Za-z0-9_]{1,80}$'),
	CONSTRAINT "payment_transfer_reversals_status" CHECK ("status" IN ('pending', 'sent', 'netted', 'failed', 'none')),
	CONSTRAINT "payment_transfer_reversals_amounts" CHECK ("amount_cents" >= 0 AND "uncovered_cents" >= 0),
	CONSTRAINT "payment_transfer_reversals_sent" CHECK (("status" = 'sent') = ("stripe_id" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_transfer_reversals_refund_uq" ON "payment_transfer_reversals" USING btree ("refund_id") WHERE "refund_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_transfer_reversals_dispute_uq" ON "payment_transfer_reversals" USING btree ("stripe_dispute_id", "kind") WHERE "stripe_dispute_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_transfer_reversals_transfer_idx" ON "payment_transfer_reversals" USING btree ("transfer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_transfer_reversals_pending_idx" ON "payment_transfer_reversals" USING btree ("created_at") WHERE "status" = 'pending';--> statement-breakpoint
-- Never claw back tips: a reversal can only ever point at a shop's transfer.
CREATE OR REPLACE FUNCTION "payment_transfer_reversals_shop_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF (SELECT "kind" FROM "payment_transfers" WHERE "id" = NEW."transfer_id") IS DISTINCT FROM 'shop' THEN
		RAISE EXCEPTION 'A tip transfer is never reversed: refunds and disputes come out of the shop''s transfer only' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "payment_transfer_reversals_shop_only" ON "payment_transfer_reversals";--> statement-breakpoint
CREATE TRIGGER "payment_transfer_reversals_shop_only" BEFORE INSERT OR UPDATE OF "transfer_id" ON "payment_transfer_reversals" FOR EACH ROW EXECUTE FUNCTION "payment_transfer_reversals_shop_only"();--> statement-breakpoint
-- A tip transfer's amount, barber and destination never change once it exists.
CREATE OR REPLACE FUNCTION "payment_transfers_tip_fixed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF OLD."kind" = 'tip' AND (NEW."amount_cents" IS DISTINCT FROM OLD."amount_cents" OR NEW."staff_id" IS DISTINCT FROM OLD."staff_id" OR NEW."destination_account" IS DISTINCT FROM OLD."destination_account" OR NEW."kind" IS DISTINCT FROM OLD."kind") THEN
		RAISE EXCEPTION 'A tip transfer can''t be changed' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "payment_transfers_tip_fixed" ON "payment_transfers";--> statement-breakpoint
CREATE TRIGGER "payment_transfers_tip_fixed" BEFORE UPDATE ON "payment_transfers" FOR EACH ROW EXECUTE FUNCTION "payment_transfers_tip_fixed"();
