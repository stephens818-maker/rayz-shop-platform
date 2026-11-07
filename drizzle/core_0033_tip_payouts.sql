-- Tip payouts: a ledger of every tip per employee, shop and ticket (tips, refunds and voids that reverse them, manager adjustments), batches a manager approves, one payout per employee per batch (cash from the drawer, Stripe Connect to the employee's own account, or through payroll), and each employee's Stripe-hosted payout account. Tips already rung up are recorded as paid before tip payouts so nothing is paid twice.
ALTER TABLE "brand_settings" ADD COLUMN "tip_payouts" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "tip_payouts" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_drawers" ADD COLUMN "tip_payouts_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TABLE "tip_payout_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"cutoff_date" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "tip_payout_batches_kind" CHECK ("tip_payout_batches"."kind" in ('end_of_night', 'daily_delay', 'weekly', 'manual', 'payroll', 'opening')),
	CONSTRAINT "tip_payout_batches_status" CHECK ("tip_payout_batches"."status" in ('draft', 'approved', 'completed', 'cancelled'))
);--> statement-breakpoint
ALTER TABLE "tip_payout_batches" ADD CONSTRAINT "tip_payout_batches_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tip_payout_batches_one_draft" ON "tip_payout_batches" USING btree ("shop_id") WHERE "tip_payout_batches"."status" = 'draft';--> statement-breakpoint
CREATE INDEX "tip_payout_batches_shop_idx" ON "tip_payout_batches" USING btree ("shop_id","cutoff_date");--> statement-breakpoint
CREATE TABLE "tip_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"method" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"gross_cents" integer DEFAULT 0 NOT NULL,
	"fee_cents" integer DEFAULT 0 NOT NULL,
	"adjust_cents" integer DEFAULT 0 NOT NULL,
	"net_cents" integer DEFAULT 0 NOT NULL,
	"instant" boolean DEFAULT false NOT NULL,
	"instant_fee_cents" integer DEFAULT 0 NOT NULL,
	"stripe_account_id" text,
	"stripe_debit_id" text,
	"stripe_transfer_id" text,
	"stripe_payout_id" text,
	"failure_message" text,
	"drawer_date" date,
	"acknowledged_at" timestamp with time zone,
	"ack_method" text,
	"ack_name" text,
	"hold_reason" text,
	"held_by" uuid,
	"held_at" timestamp with time zone,
	"payroll_period_start" date,
	"sent_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tip_payouts_method" CHECK ("tip_payouts"."method" in ('cash', 'stripe', 'payroll', 'prior')),
	CONSTRAINT "tip_payouts_status" CHECK ("tip_payouts"."status" in ('pending', 'held', 'approved', 'processing', 'paid', 'failed', 'cancelled')),
	CONSTRAINT "tip_payouts_ack" CHECK ("tip_payouts"."ack_method" is null or "tip_payouts"."ack_method" in ('pin', 'name')),
	CONSTRAINT "tip_payouts_held" CHECK ("tip_payouts"."status" <> 'held' or "tip_payouts"."hold_reason" is not null)
);--> statement-breakpoint
ALTER TABLE "tip_payouts" ADD CONSTRAINT "tip_payouts_batch_id_tip_payout_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."tip_payout_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_payouts" ADD CONSTRAINT "tip_payouts_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_payouts" ADD CONSTRAINT "tip_payouts_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tip_payouts_batch_staff_uq" ON "tip_payouts" USING btree ("batch_id","staff_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tip_payouts_transfer_uq" ON "tip_payouts" USING btree ("stripe_transfer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tip_payouts_payout_uq" ON "tip_payouts" USING btree ("stripe_payout_id");--> statement-breakpoint
CREATE INDEX "tip_payouts_staff_idx" ON "tip_payouts" USING btree ("staff_id","created_at");--> statement-breakpoint
CREATE INDEX "tip_payouts_drawer_idx" ON "tip_payouts" USING btree ("shop_id","drawer_date") WHERE "tip_payouts"."method" = 'cash';--> statement-breakpoint
CREATE TABLE "tip_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"sale_id" uuid,
	"payment_id" uuid,
	"refund_id" uuid,
	"kind" text NOT NULL,
	"method" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"fee_cents" integer DEFAULT 0 NOT NULL,
	"business_date" date NOT NULL,
	"payout_id" uuid,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tip_ledger_kind" CHECK ("tip_ledger"."kind" in ('tip', 'refund', 'adjust')),
	CONSTRAINT "tip_ledger_method" CHECK ("tip_ledger"."method" in ('card', 'cash', 'gift_card', 'adjust')),
	CONSTRAINT "tip_ledger_source" CHECK (("tip_ledger"."kind" = 'tip' and "tip_ledger"."payment_id" is not null) or ("tip_ledger"."kind" = 'refund' and "tip_ledger"."refund_id" is not null) or ("tip_ledger"."kind" = 'adjust' and "tip_ledger"."reason" is not null))
);--> statement-breakpoint
ALTER TABLE "tip_ledger" ADD CONSTRAINT "tip_ledger_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_ledger" ADD CONSTRAINT "tip_ledger_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_ledger" ADD CONSTRAINT "tip_ledger_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_ledger" ADD CONSTRAINT "tip_ledger_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_ledger" ADD CONSTRAINT "tip_ledger_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_ledger" ADD CONSTRAINT "tip_ledger_payout_id_tip_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."tip_payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tip_ledger_payment_uq" ON "tip_ledger" USING btree ("payment_id") WHERE "tip_ledger"."kind" = 'tip';--> statement-breakpoint
CREATE UNIQUE INDEX "tip_ledger_refund_uq" ON "tip_ledger" USING btree ("refund_id") WHERE "tip_ledger"."kind" = 'refund';--> statement-breakpoint
CREATE INDEX "tip_ledger_staff_date_idx" ON "tip_ledger" USING btree ("staff_id","business_date");--> statement-breakpoint
CREATE INDEX "tip_ledger_shop_date_idx" ON "tip_ledger" USING btree ("shop_id","business_date");--> statement-breakpoint
CREATE INDEX "tip_ledger_payout_idx" ON "tip_ledger" USING btree ("payout_id");--> statement-breakpoint
CREATE INDEX "tip_ledger_unpaid_idx" ON "tip_ledger" USING btree ("shop_id","staff_id") WHERE "tip_ledger"."payout_id" is null;--> statement-breakpoint
CREATE TABLE "staff_payout_accounts" (
	"staff_id" uuid PRIMARY KEY NOT NULL,
	"method" text,
	"instant" boolean DEFAULT false NOT NULL,
	"stripe_account_id" text,
	"simulated" boolean DEFAULT false NOT NULL,
	"payouts_enabled" boolean DEFAULT false NOT NULL,
	"details_submitted" boolean DEFAULT false NOT NULL,
	"instant_eligible" boolean DEFAULT false NOT NULL,
	"requirements_due" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"disabled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_payout_accounts_stripe_account_id_unique" UNIQUE("stripe_account_id"),
	CONSTRAINT "staff_payout_accounts_method" CHECK ("staff_payout_accounts"."method" is null or "staff_payout_accounts"."method" in ('cash', 'stripe', 'payroll'))
);--> statement-breakpoint
ALTER TABLE "staff_payout_accounts" ADD CONSTRAINT "staff_payout_accounts_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "tip_ledger" ("shop_id", "staff_id", "sale_id", "payment_id", "kind", "method", "amount_cents", "fee_cents", "business_date")
SELECT p."shop_id", s."staff_id", s."id", p."id", 'tip', p."method"::text, p."tip_cents",
	CASE WHEN p."method" = 'card' AND p."amount_cents" > 0 THEN round(coalesce(nullif(p."processor_fee_cents", 0), p."application_fee_cents", 0)::numeric * p."tip_cents" / p."amount_cents")::int ELSE 0 END,
	s."business_date"
FROM "payments" p JOIN "sales" s ON s."id" = p."sale_id"
WHERE p."tip_cents" <> 0 AND s."staff_id" IS NOT NULL AND NOT s."is_imported" AND s."status" <> 'open';--> statement-breakpoint
INSERT INTO "tip_ledger" ("shop_id", "staff_id", "sale_id", "payment_id", "refund_id", "kind", "method", "amount_cents", "fee_cents", "business_date")
SELECT r."shop_id", s."staff_id", s."id", r."payment_id", r."id", 'refund', r."method"::text, -r."tip_cents",
	-coalesce(CASE WHEN t."amount_cents" > 0 THEN round(t."fee_cents"::numeric * r."tip_cents" / t."amount_cents")::int END, 0),
	r."business_date"
FROM "refunds" r JOIN "sales" s ON s."id" = r."sale_id"
LEFT JOIN "tip_ledger" t ON t."payment_id" = r."payment_id" AND t."kind" = 'tip'
WHERE r."tip_cents" <> 0 AND s."staff_id" IS NOT NULL AND NOT s."is_imported";--> statement-breakpoint
INSERT INTO "tip_payout_batches" ("shop_id", "kind", "cutoff_date", "status", "notes", "approved_at", "completed_at")
SELECT "shop_id", 'opening', max("business_date"), 'completed', 'Tips rung up before tip payouts, already paid outside the platform', now(), now()
FROM "tip_ledger" GROUP BY "shop_id";--> statement-breakpoint
INSERT INTO "tip_payouts" ("batch_id", "shop_id", "staff_id", "method", "status", "gross_cents", "net_cents", "paid_at")
SELECT b."id", l."shop_id", l."staff_id", 'prior', 'paid', sum(l."amount_cents")::int, sum(l."amount_cents")::int, now()
FROM "tip_ledger" l JOIN "tip_payout_batches" b ON b."shop_id" = l."shop_id" AND b."kind" = 'opening'
GROUP BY b."id", l."shop_id", l."staff_id";--> statement-breakpoint
UPDATE "tip_ledger" l SET "payout_id" = p."id"
FROM "tip_payouts" p JOIN "tip_payout_batches" b ON b."id" = p."batch_id" AND b."kind" = 'opening'
WHERE p."shop_id" = l."shop_id" AND p."staff_id" = l."staff_id";--> statement-breakpoint
CREATE OR REPLACE FUNCTION "tip_ledger_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF OLD."payout_id" IS NOT NULL THEN
			RAISE EXCEPTION 'tip_ledger %: a tip in a payout can''t be deleted', OLD."id";
		END IF;
		RETURN OLD;
	END IF;
	IF NEW."amount_cents" IS DISTINCT FROM OLD."amount_cents" OR NEW."fee_cents" IS DISTINCT FROM OLD."fee_cents" OR NEW."staff_id" IS DISTINCT FROM OLD."staff_id"
		OR NEW."shop_id" IS DISTINCT FROM OLD."shop_id" OR NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."business_date" IS DISTINCT FROM OLD."business_date" THEN
		RAISE EXCEPTION 'tip_ledger %: entries can''t be changed; add an adjustment instead', OLD."id";
	END IF;
	IF OLD."payout_id" IS NOT NULL AND NEW."payout_id" IS DISTINCT FROM OLD."payout_id" THEN
		IF NEW."payout_id" IS NOT NULL THEN
			RAISE EXCEPTION 'tip_ledger %: already in payout %', OLD."id", OLD."payout_id";
		END IF;
		IF EXISTS (SELECT 1 FROM "tip_payouts" WHERE "id" = OLD."payout_id" AND "status" IN ('approved', 'processing', 'paid')) THEN
			RAISE EXCEPTION 'tip_ledger %: payout % is approved, sent or paid, so its tips stay with it', OLD."id", OLD."payout_id";
		END IF;
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "tip_ledger_guard" BEFORE UPDATE OR DELETE ON "tip_ledger" FOR EACH ROW EXECUTE FUNCTION "tip_ledger_guard"();--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["tips.own","tips.approve","tips.settings","report.tip_payouts.view","report.tip_payouts.export"]'::jsonb WHERE "key" = 'brand_admin' AND NOT ("permissions" ? 'tips.own');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["tips.own","tips.approve","report.tip_payouts.view","report.tip_payouts.export"]'::jsonb WHERE "key" IN ('regional_manager', 'shop_manager') AND NOT ("permissions" ? 'tips.own');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["tips.own"]'::jsonb WHERE "key" IN ('front_desk', 'barber') AND NOT ("permissions" ? 'tips.own');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["tips.own"]'::jsonb WHERE "key" IS NULL AND "permissions" ? 'timeclock.punch' AND NOT ("permissions" ? 'tips.own');
