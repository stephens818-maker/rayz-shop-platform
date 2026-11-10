-- Payroll spec review I2 (2026-10-27): commission owed for a pay period that's already locked (a missed credit, a corrected rate) is paid in the next open one as a dated adjustment, never by reopening the locked file. The period it was earned in is kept, so the half-time it adds to that period's overtime (the FLSA regular rate, 29 CFR 778.119) can be worked out from the locked figures. Only ever adds pay: a shortfall in the employee's favor, never a deduction. Additive only.
CREATE TABLE IF NOT EXISTS "payroll_commission_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
	"period_start" date NOT NULL,
	"staff_id" uuid NOT NULL REFERENCES "staff"("id") ON DELETE cascade,
	"earned_start" date NOT NULL,
	"earned_end" date NOT NULL,
	"amount_cents" integer NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid REFERENCES "staff"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_commission_adjustments_amount" CHECK ("amount_cents" > 0),
	CONSTRAINT "payroll_commission_adjustments_earned" CHECK ("earned_end" >= "earned_start" AND "earned_end" < "period_start"),
	CONSTRAINT "payroll_commission_adjustments_reason" CHECK (char_length(btrim("reason")) > 0 AND char_length("reason") <= 300)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payroll_commission_adjustments_period_idx" ON "payroll_commission_adjustments" USING btree ("period_start", "shop_id");--> statement-breakpoint
DROP TRIGGER IF EXISTS "payroll_commission_adjustments_scrub_sensitive" ON "payroll_commission_adjustments";--> statement-breakpoint
CREATE TRIGGER "payroll_commission_adjustments_scrub_sensitive" BEFORE INSERT OR UPDATE OF "reason" ON "payroll_commission_adjustments" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('reason');
