-- Compensation fields for each employee, off by default (brand_settings.compensation.enabled): effective-dated versions of their pay plan (hourly rate, per shop if they work several, service commission with per-service and per-category overrides and monthly sales tiers, product commission, booth rent, a guaranteed minimum, how their tips are paid and whether the card fee comes out of them), and the brand's own employee fields. A version is never changed once saved: a change is a new version from a date after the last locked pay period, so past payroll is never rewritten; only versions that haven't started yet can be deleted. No bank, card, SSN or tax ID data is kept here: that stays with Stripe and iSolved. Additive only.
ALTER TABLE "brand_settings" ADD COLUMN IF NOT EXISTS "compensation" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_compensation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL REFERENCES "staff"("id") ON DELETE cascade,
	"effective_from" date NOT NULL,
	"hourly_rate_cents" integer,
	"shop_hourly_rates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"service_pct" double precision,
	"service_overrides" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"service_tiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tier_mode" text DEFAULT 'step' NOT NULL,
	"product_pct" double precision,
	"booth_rent_cents" integer,
	"booth_rent_frequency" text,
	"guarantee_cents" integer,
	"guarantee_per" text,
	"tip_method" text,
	"tip_card_fee_netting" boolean,
	"note" text,
	"created_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "staff_compensation_tier_mode" CHECK ("tier_mode" IN ('step', 'marginal')),
	CONSTRAINT "staff_compensation_rent_frequency" CHECK ("booth_rent_frequency" IS NULL OR "booth_rent_frequency" IN ('weekly', 'biweekly', 'monthly')),
	CONSTRAINT "staff_compensation_rent_pair" CHECK (("booth_rent_cents" IS NULL) = ("booth_rent_frequency" IS NULL)),
	CONSTRAINT "staff_compensation_guarantee_per" CHECK ("guarantee_per" IS NULL OR "guarantee_per" IN ('pay_period', 'week', 'month', 'year')),
	CONSTRAINT "staff_compensation_guarantee_pair" CHECK (("guarantee_cents" IS NULL) = ("guarantee_per" IS NULL)),
	CONSTRAINT "staff_compensation_tip_method" CHECK ("tip_method" IS NULL OR "tip_method" IN ('cash', 'stripe', 'payroll')),
	CONSTRAINT "staff_compensation_pcts" CHECK (("service_pct" IS NULL OR "service_pct" BETWEEN 0 AND 1) AND ("product_pct" IS NULL OR "product_pct" BETWEEN 0 AND 1)),
	CONSTRAINT "staff_compensation_amounts" CHECK (coalesce("hourly_rate_cents", 0) >= 0 AND coalesce("booth_rent_cents", 0) >= 0 AND coalesce("guarantee_cents", 0) >= 0),
	CONSTRAINT "staff_compensation_note" CHECK ("note" IS NULL OR char_length("note") <= 500)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_compensation_staff_idx" ON "staff_compensation" USING btree ("staff_id", "effective_from" DESC, "created_at" DESC);--> statement-breakpoint
-- Versions are history: never edited. One that hasn't started yet can be withdrawn; a removed employee's go with them.
CREATE OR REPLACE FUNCTION "staff_compensation_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	locked date;
BEGIN
	IF TG_OP = 'UPDATE' THEN
		RAISE EXCEPTION 'A compensation version can''t be changed once saved; add a new version instead' USING ERRCODE = 'check_violation';
	END IF;
	IF TG_OP = 'DELETE' THEN
		IF OLD."effective_from" > (now() AT TIME ZONE 'America/Chicago')::date OR NOT EXISTS (SELECT 1 FROM "staff" WHERE "id" = OLD."staff_id") THEN RETURN OLD; END IF;
		RAISE EXCEPTION 'Only a compensation version that hasn''t started yet can be deleted' USING ERRCODE = 'check_violation';
	END IF;
	SELECT max("period_end") INTO locked FROM "payroll_runs";
	IF locked IS NOT NULL AND NEW."effective_from" <= locked THEN
		RAISE EXCEPTION 'A compensation version must start after the last locked pay period (%)', locked USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "staff_compensation_history" ON "staff_compensation";--> statement-breakpoint
CREATE TRIGGER "staff_compensation_history" BEFORE INSERT OR UPDATE OR DELETE ON "staff_compensation" FOR EACH ROW EXECUTE FUNCTION "staff_compensation_guard"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "staff_compensation_scrub_sensitive" ON "staff_compensation";--> statement-breakpoint
CREATE TRIGGER "staff_compensation_scrub_sensitive" BEFORE INSERT ON "staff_compensation" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('note');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_custom_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"position" integer DEFAULT 100 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_custom_fields_kind" CHECK ("kind" IN ('text', 'number', 'percent', 'date', 'dropdown')),
	CONSTRAINT "staff_custom_fields_label" CHECK (char_length(btrim("label")) BETWEEN 1 AND 60),
	-- Same words as SENSITIVE_LABEL in src/domain/compensation.ts; keep the two in step.
	CONSTRAINT "staff_custom_fields_not_sensitive" CHECK (NOT "is_forbidden_key"("label") AND "label" !~* '(^|[^a-z])(ssn|social security|bank|routing|iban|swift|account (number|no|#)|acct|card number|credit card|debit card|cvv|cvc|tax ?id|tin|itin|ein|fein|driver.?s licen[cs]e|passport|date of birth|dob|birth ?date)([^a-z]|$)')
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "staff_custom_fields_label_uq" ON "staff_custom_fields" USING btree (lower(btrim("label"))) WHERE "active";--> statement-breakpoint
DROP TRIGGER IF EXISTS "staff_custom_fields_scrub_sensitive" ON "staff_custom_fields";--> statement-breakpoint
CREATE TRIGGER "staff_custom_fields_scrub_sensitive" BEFORE INSERT OR UPDATE OF "label", "options" ON "staff_custom_fields" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('label', 'options');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_custom_values" (
	"staff_id" uuid NOT NULL REFERENCES "staff"("id") ON DELETE cascade,
	"field_id" uuid NOT NULL REFERENCES "staff_custom_fields"("id") ON DELETE cascade,
	"value" text NOT NULL,
	"updated_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_custom_values_pk" PRIMARY KEY ("staff_id", "field_id"),
	CONSTRAINT "staff_custom_values_value" CHECK (char_length("value") BETWEEN 1 AND 200)
);--> statement-breakpoint
DROP TRIGGER IF EXISTS "staff_custom_values_scrub_sensitive" ON "staff_custom_values";--> statement-breakpoint
CREATE TRIGGER "staff_custom_values_scrub_sensitive" BEFORE INSERT OR UPDATE OF "value" ON "staff_custom_values" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('value');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["compensation.view", "compensation.edit", "compensation.settings", "compensation.own", "report.commission_payout.view", "report.commission_payout.export"]'::jsonb WHERE "key" = 'brand_admin' AND NOT ("permissions" ? 'compensation.view');
