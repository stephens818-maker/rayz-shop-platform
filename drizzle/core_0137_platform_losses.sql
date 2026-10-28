-- Tip payouts (2026-10-28). Tips are never clawed back, so a refund or lost dispute bigger than what's left of the shop's portion is a platform loss, booked here: the tip part (already with the barber), and the processing fee part. The brand's tipRefundOverflow setting says who carries the tip part: the platform (the default), or the shop, recovered from its next transfers (platform_loss_recoveries; a refund of that later sale reopens what it recovered). Each sale transfer also keeps its Stripe idempotency key ({saleId}:shop, {saleId}:tip); rows from before keep the key they were sent with. Additive only.
ALTER TABLE "payment_transfers" ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint
UPDATE "payment_transfers" SET "idempotency_key" = 'sale-transfer-' || "id" WHERE "idempotency_key" IS NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "payment_transfers" ADD CONSTRAINT "payment_transfers_idempotency_key" CHECK ("idempotency_key" IS NULL OR char_length("idempotency_key") BETWEEN 1 AND 255);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_transfers_idempotency_uq" ON "payment_transfers" USING btree ("idempotency_key") WHERE "idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_losses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL REFERENCES "payments"("id"),
	"sale_id" uuid NOT NULL REFERENCES "sales"("id"),
	"shop_id" uuid NOT NULL REFERENCES "shops"("id"),
	"kind" text NOT NULL,
	"refund_id" uuid REFERENCES "refunds"("id"),
	"stripe_dispute_id" text,
	"cents" integer NOT NULL,
	"tip_cents" integer DEFAULT 0 NOT NULL,
	"bearer" text DEFAULT 'platform' NOT NULL,
	"recovered_cents" integer DEFAULT 0 NOT NULL,
	"business_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_losses_kind" CHECK ("kind" IN ('refund', 'dispute_lost')),
	CONSTRAINT "platform_losses_source" CHECK (("kind" = 'refund') = ("refund_id" IS NOT NULL) AND ("kind" = 'refund') = ("stripe_dispute_id" IS NULL)),
	CONSTRAINT "platform_losses_bearer" CHECK ("bearer" IN ('platform', 'shop')),
	CONSTRAINT "platform_losses_amounts" CHECK ("cents" > 0 AND "tip_cents" >= 0 AND "tip_cents" <= "cents"),
	CONSTRAINT "platform_losses_recovered" CHECK ("recovered_cents" >= 0 AND "recovered_cents" <= "tip_cents" AND ("bearer" = 'shop' OR "recovered_cents" = 0))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_losses_refund_uq" ON "platform_losses" USING btree ("refund_id") WHERE "refund_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_losses_dispute_uq" ON "platform_losses" USING btree ("stripe_dispute_id") WHERE "stripe_dispute_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_losses_payment_idx" ON "platform_losses" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_losses_open_idx" ON "platform_losses" USING btree ("shop_id", "created_at") WHERE "bearer" = 'shop' AND "recovered_cents" < "tip_cents";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_losses_date_idx" ON "platform_losses" USING btree ("business_date");--> statement-breakpoint
-- What a shop-borne loss took from one of the shop's later transfers; negative when a refund of that sale reopened it.
CREATE TABLE IF NOT EXISTS "platform_loss_recoveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loss_id" uuid NOT NULL REFERENCES "platform_losses"("id"),
	"transfer_id" uuid NOT NULL REFERENCES "payment_transfers"("id"),
	"cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_loss_recoveries_cents" CHECK ("cents" <> 0)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_loss_recoveries_loss_idx" ON "platform_loss_recoveries" USING btree ("loss_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_loss_recoveries_transfer_idx" ON "platform_loss_recoveries" USING btree ("transfer_id");--> statement-breakpoint
-- A recovery only ever comes out of a shop's transfer, never a tip.
CREATE OR REPLACE FUNCTION "platform_loss_recoveries_shop_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF (SELECT "kind" FROM "payment_transfers" WHERE "id" = NEW."transfer_id") IS DISTINCT FROM 'shop' THEN
		RAISE EXCEPTION 'A tip transfer is never taken back: a loss is recovered from the shop''s transfer only' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "platform_loss_recoveries_shop_only" ON "platform_loss_recoveries";--> statement-breakpoint
CREATE TRIGGER "platform_loss_recoveries_shop_only" BEFORE INSERT OR UPDATE OF "transfer_id" ON "platform_loss_recoveries" FOR EACH ROW EXECUTE FUNCTION "platform_loss_recoveries_shop_only"();
