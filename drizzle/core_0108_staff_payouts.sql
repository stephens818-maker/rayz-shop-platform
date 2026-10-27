-- Staff payouts (Rayz App builder, ST-I9 to ST-I15, ST-C12 to ST-C15): the staff_payouts brand setting; each barber's Stripe account as a recipient account with a seven-state status; every tip tagged with its employer; refunded tips the shop absorbs; the yearly tax form check; and the payout tracker's permissions. Money movement stays abstract until ST-C11 (separate charges and transfers) is signed off.
ALTER TABLE "brand_settings" ADD COLUMN "staff_payouts" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_payout_accounts" ADD COLUMN "dashboard" text;--> statement-breakpoint
ALTER TABLE "staff_payout_accounts" ADD COLUMN "service_agreement" text;--> statement-breakpoint
ALTER TABLE "staff_payout_accounts" ADD COLUMN "state" text DEFAULT 'not_started' NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_payout_accounts" ADD COLUMN "state_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff_payout_accounts" ADD COLUMN "transfers_capability" text;--> statement-breakpoint
ALTER TABLE "staff_payout_accounts" ADD COLUMN "requirements_past_due" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_payout_accounts" ADD COLUMN "deauthorized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff_payout_accounts" ADD COLUMN "tax_forms" text DEFAULT 'will_not_file' NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_payout_accounts" ADD COLUMN "instant_fee_terms" text;--> statement-breakpoint
ALTER TABLE "staff_payout_accounts" ADD COLUMN "instant_fee_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff_payout_accounts" ADD CONSTRAINT "staff_payout_accounts_state" CHECK ("staff_payout_accounts"."state" in ('not_started', 'in_progress', 'pending_verification', 'requirements_due', 'restricted', 'active', 'rejected'));--> statement-breakpoint
ALTER TABLE "staff_payout_accounts" ADD CONSTRAINT "staff_payout_accounts_dashboard" CHECK ("staff_payout_accounts"."dashboard" is null or "staff_payout_accounts"."dashboard" in ('none', 'express'));--> statement-breakpoint
ALTER TABLE "staff_payout_accounts" ADD CONSTRAINT "staff_payout_accounts_service_agreement" CHECK ("staff_payout_accounts"."service_agreement" is null or "staff_payout_accounts"."service_agreement" in ('recipient', 'full'));--> statement-breakpoint
ALTER TABLE "staff_payout_accounts" ADD CONSTRAINT "staff_payout_accounts_tax_forms" CHECK ("staff_payout_accounts"."tax_forms" in ('will_not_file'));--> statement-breakpoint
-- Accounts made before: Express with the full service agreement, and their state from what Stripe last reported (accountState in src/domain/staff-payouts.ts, reading transfers from payouts_enabled).
UPDATE "staff_payout_accounts" SET "dashboard" = 'express', "service_agreement" = 'full' WHERE "stripe_account_id" IS NOT NULL;--> statement-breakpoint
UPDATE "staff_payout_accounts" SET "state_changed_at" = "updated_at", "state" = CASE
	WHEN "stripe_account_id" IS NULL THEN 'not_started'
	WHEN "disabled_reason" LIKE 'rejected%' THEN 'rejected'
	WHEN NOT "details_submitted" THEN 'in_progress'
	WHEN "payouts_enabled" AND jsonb_array_length("requirements_due") > 0 THEN 'requirements_due'
	WHEN "payouts_enabled" THEN 'active'
	WHEN "disabled_reason" IS NOT NULL AND "disabled_reason" <> 'requirements.pending_verification' THEN 'restricted'
	WHEN jsonb_array_length("requirements_due") > 0 THEN 'restricted'
	ELSE 'pending_verification' END;--> statement-breakpoint
-- A Stripe payout with no transfer path yet (ST-C11 pending) is held as owed, like one waiting for the employee's setup.
ALTER TABLE "tip_payouts" DROP CONSTRAINT "tip_payouts_hold_kind";--> statement-breakpoint
ALTER TABLE "tip_payouts" ADD CONSTRAINT "tip_payouts_hold_kind" CHECK ("tip_payouts"."hold_kind" is null or "tip_payouts"."hold_kind" in ('manager', 'stripe_setup', 'transfers_pending'));--> statement-breakpoint
-- The employer (one FEIN) each pay group belongs to. Only the last four digits of its EIN are kept; the full number stays in iSolved and Stripe.
CREATE TABLE "payroll_employers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legal_name" text NOT NULL,
	"isolved_company_code" text,
	"tax_id_last4" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_employers_legal_name_unique" UNIQUE("legal_name"),
	CONSTRAINT "payroll_employers_tax_id_last4" CHECK ("payroll_employers"."tax_id_last4" is null or "payroll_employers"."tax_id_last4" ~ '^[0-9]{4}$')
);--> statement-breakpoint
INSERT INTO "payroll_employers" ("legal_name") SELECT DISTINCT "legal_entity" FROM "pay_groups" ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "pay_groups" ADD COLUMN "employer_id" uuid;--> statement-breakpoint
ALTER TABLE "pay_groups" ADD CONSTRAINT "pay_groups_employer_id_payroll_employers_id_fk" FOREIGN KEY ("employer_id") REFERENCES "public"."payroll_employers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
UPDATE "pay_groups" g SET "employer_id" = e."id" FROM "payroll_employers" e WHERE e."legal_name" = g."legal_entity";--> statement-breakpoint
-- A pay group's employer follows its legal entity, whichever path writes it.
CREATE OR REPLACE FUNCTION "pay_groups_employer"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	INSERT INTO "payroll_employers" ("legal_name") VALUES (NEW."legal_entity") ON CONFLICT ("legal_name") DO NOTHING;
	SELECT "id" INTO NEW."employer_id" FROM "payroll_employers" WHERE "legal_name" = NEW."legal_entity";
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "pay_groups_employer" BEFORE INSERT OR UPDATE OF "legal_entity" ON "pay_groups" FOR EACH ROW EXECUTE FUNCTION "pay_groups_employer"();--> statement-breakpoint
ALTER TABLE "tip_ledger" ADD COLUMN "employer_id" uuid;--> statement-breakpoint
ALTER TABLE "tip_ledger" ADD CONSTRAINT "tip_ledger_employer_id_payroll_employers_id_fk" FOREIGN KEY ("employer_id") REFERENCES "public"."payroll_employers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tip_ledger_employer_idx" ON "tip_ledger" USING btree ("employer_id","business_date");--> statement-breakpoint
UPDATE "tip_ledger" l SET "employer_id" = g."employer_id" FROM "pay_groups" g WHERE g."shop_id" = l."shop_id" AND l."employer_id" IS NULL;--> statement-breakpoint
-- Every tip is tagged with its shop and that shop's employer when it's written; the tag never changes after.
CREATE OR REPLACE FUNCTION "tip_employer"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."employer_id" IS NULL THEN
		SELECT "employer_id" INTO NEW."employer_id" FROM "pay_groups" WHERE "shop_id" = NEW."shop_id";
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "tip_ledger_employer" BEFORE INSERT ON "tip_ledger" FOR EACH ROW EXECUTE FUNCTION "tip_employer"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "tip_ledger_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF OLD."payout_id" IS NOT NULL THEN
			RAISE EXCEPTION 'tip_ledger %: a tip in a payout can''t be deleted', OLD."id";
		END IF;
		RETURN OLD;
	END IF;
	IF NEW."amount_cents" IS DISTINCT FROM OLD."amount_cents" OR NEW."fee_cents" IS DISTINCT FROM OLD."fee_cents" OR NEW."staff_id" IS DISTINCT FROM OLD."staff_id"
		OR NEW."shop_id" IS DISTINCT FROM OLD."shop_id" OR NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."business_date" IS DISTINCT FROM OLD."business_date"
		OR (OLD."employer_id" IS NOT NULL AND NEW."employer_id" IS DISTINCT FROM OLD."employer_id") THEN
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
-- A refunded or disputed tip the barber keeps: the shop absorbs it (a partial refund, a refund after the reversal window, or a card dispute). Never changed after.
CREATE TABLE "tip_absorptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"employer_id" uuid,
	"sale_id" uuid,
	"payment_id" uuid,
	"refund_id" uuid,
	"stripe_dispute_id" text,
	"kind" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"business_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tip_absorptions_kind" CHECK ("tip_absorptions"."kind" in ('partial_refund', 'outside_window', 'rule', 'dispute')),
	CONSTRAINT "tip_absorptions_source" CHECK (("tip_absorptions"."kind" = 'dispute' and "tip_absorptions"."stripe_dispute_id" is not null) or ("tip_absorptions"."kind" <> 'dispute' and "tip_absorptions"."refund_id" is not null)),
	CONSTRAINT "tip_absorptions_dispute_id" CHECK ("tip_absorptions"."stripe_dispute_id" is null or "tip_absorptions"."stripe_dispute_id" ~ '^(dp|du|sim)_[A-Za-z0-9_]{1,80}$')
);--> statement-breakpoint
ALTER TABLE "tip_absorptions" ADD CONSTRAINT "tip_absorptions_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_absorptions" ADD CONSTRAINT "tip_absorptions_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_absorptions" ADD CONSTRAINT "tip_absorptions_employer_id_payroll_employers_id_fk" FOREIGN KEY ("employer_id") REFERENCES "public"."payroll_employers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_absorptions" ADD CONSTRAINT "tip_absorptions_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_absorptions" ADD CONSTRAINT "tip_absorptions_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_absorptions" ADD CONSTRAINT "tip_absorptions_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tip_absorptions_refund_uq" ON "tip_absorptions" USING btree ("refund_id","staff_id") WHERE "tip_absorptions"."refund_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tip_absorptions_dispute_uq" ON "tip_absorptions" USING btree ("stripe_dispute_id","staff_id") WHERE "tip_absorptions"."stripe_dispute_id" is not null;--> statement-breakpoint
CREATE INDEX "tip_absorptions_shop_date_idx" ON "tip_absorptions" USING btree ("shop_id","business_date");--> statement-breakpoint
CREATE TRIGGER "tip_absorptions_employer" BEFORE INSERT ON "tip_absorptions" FOR EACH ROW EXECUTE FUNCTION "tip_employer"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "tip_absorptions_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'tip_absorptions %: absorbed tips are never changed or removed', OLD."id";
END $$;--> statement-breakpoint
CREATE TRIGGER "tip_absorptions_append_only" BEFORE UPDATE OR DELETE ON "tip_absorptions" FOR EACH ROW EXECUTE FUNCTION "tip_absorptions_append_only"();--> statement-breakpoint
-- The yearly check that Stripe won't file 1099s for the barbers' accounts (their tips are W-2 wages): one row per tax year, with what was found.
CREATE TABLE "tax_form_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tax_year" integer NOT NULL,
	"accounts" integer NOT NULL,
	"untagged" integer NOT NULL,
	"fees_on_account" integer NOT NULL,
	"checked_by" uuid,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_form_checks_tax_year_unique" UNIQUE("tax_year"),
	CONSTRAINT "tax_form_checks_year" CHECK ("tax_form_checks"."tax_year" between 2020 and 2100)
);--> statement-breakpoint
ALTER TABLE "tax_form_checks" ADD CONSTRAINT "tax_form_checks_checked_by_staff_id_fk" FOREIGN KEY ("checked_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The payout tracker: managers see and act on their shops' payouts; the Bookkeeper sees every shop's, read-only; the brand admin has all three. The tips-paid export is a payroll report: brand roles and the Bookkeeper.
UPDATE "roles" SET "permissions" = "permissions" || '["payouts.view","payouts.manage","payouts.chain","report.payroll_tips_paid.view","report.payroll_tips_paid.export"]'::jsonb WHERE "key" = 'brand_admin' AND NOT ("permissions" ? 'payouts.view');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["payouts.view","payouts.manage"]'::jsonb WHERE "key" IN ('regional_manager', 'shop_manager', 'franchisee_owner', 'franchisee_manager') AND NOT ("permissions" ? 'payouts.view');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["payouts.view","payouts.chain","report.payroll_tips_paid.view","report.payroll_tips_paid.export"]'::jsonb WHERE "key" = 'bookkeeper' AND NOT ("permissions" ? 'payouts.view');
