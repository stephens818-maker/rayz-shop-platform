-- The rollout Charles approved (2026-10-28): one pilot shop goes live while Squire stays as its backup; the rest switch after one clean pay period. Per shop: its wave, the day it's planned to go live, the first pay period whose payroll comes from this platform (before it, from the Squire data imported for the period), how long Squire is kept as the backup, and, for the pilot, the clean pay period an owner signed off. Additive only.
CREATE TABLE IF NOT EXISTS "shop_rollouts" (
	"shop_id" uuid PRIMARY KEY NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
	"wave" smallint DEFAULT 2 NOT NULL,
	"planned_on" date,
	"payroll_from" date,
	"squire_backup_until" date,
	"clean_period_start" date,
	"clean_period_end" date,
	"clean_check" jsonb,
	"clean_note" text,
	"clean_signed_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"clean_signed_at" timestamp with time zone,
	"note" text,
	"updated_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_rollouts_wave" CHECK ("wave" IN (1, 2)),
	CONSTRAINT "shop_rollouts_clean" CHECK (("clean_period_start" IS NULL) = ("clean_signed_at" IS NULL) AND ("clean_period_end" IS NULL) = ("clean_signed_at" IS NULL) AND ("clean_period_end" IS NULL OR "clean_period_end" >= "clean_period_start")),
	CONSTRAINT "shop_rollouts_clean_pilot" CHECK ("clean_signed_at" IS NULL OR "wave" = 1),
	CONSTRAINT "shop_rollouts_note_len" CHECK (("note" IS NULL OR char_length("note") <= 300) AND ("clean_note" IS NULL OR char_length("clean_note") <= 300))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_rollouts_one_pilot" ON "shop_rollouts" USING btree ("wave") WHERE "wave" = 1;--> statement-breakpoint
DROP TRIGGER IF EXISTS "shop_rollouts_scrub_sensitive" ON "shop_rollouts";--> statement-breakpoint
CREATE TRIGGER "shop_rollouts_scrub_sensitive" BEFORE INSERT OR UPDATE OF "note", "clean_note" ON "shop_rollouts" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('note', 'clean_note');--> statement-breakpoint
-- A shop's Squire Commissions report for a pay period whose payroll still comes from Squire: one import per shop and period, replaced by importing again while the period is open.
CREATE TABLE IF NOT EXISTS "payroll_squire_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"file_name" text,
	"rows" integer NOT NULL,
	"totals" jsonb NOT NULL,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"imported_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_squire_imports_dates" CHECK ("period_end" >= "period_start")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_squire_imports_shop_period_uq" ON "payroll_squire_imports" USING btree ("shop_id", "period_start");--> statement-breakpoint
DROP TRIGGER IF EXISTS "payroll_squire_imports_scrub_sensitive" ON "payroll_squire_imports";--> statement-breakpoint
CREATE TRIGGER "payroll_squire_imports_scrub_sensitive" BEFORE INSERT ON "payroll_squire_imports" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('notes');--> statement-breakpoint
-- One employee's figures at the shop for the period, as Squire's report has them: hours worked (OT included), net service and product sales (no tax or tips), tips, and sales tax (reference only). OT, PTO and training hours aren't in Squire's report: from extra columns in the file, or typed on the Payroll Report.
CREATE TABLE IF NOT EXISTS "payroll_squire_inputs" (
	"import_id" uuid NOT NULL REFERENCES "payroll_squire_imports"("id") ON DELETE cascade,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
	"period_start" date NOT NULL,
	"staff_id" uuid NOT NULL REFERENCES "staff"("id") ON DELETE cascade,
	"squire_name" text NOT NULL,
	"worked_centi" integer DEFAULT 0 NOT NULL,
	"ot_centi" integer DEFAULT 0 NOT NULL,
	"pto_centi" integer DEFAULT 0 NOT NULL,
	"training_centi" integer DEFAULT 0 NOT NULL,
	"service_cents" integer DEFAULT 0 NOT NULL,
	"product_cents" integer DEFAULT 0 NOT NULL,
	"tips_cents" integer DEFAULT 0 NOT NULL,
	"sales_tax_cents" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "payroll_squire_inputs_pk" PRIMARY KEY ("period_start", "shop_id", "staff_id"),
	CONSTRAINT "payroll_squire_inputs_hours" CHECK ("worked_centi" >= 0 AND "ot_centi" >= 0 AND "ot_centi" <= "worked_centi" AND "pto_centi" >= 0 AND "training_centi" >= 0)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payroll_squire_inputs_import_idx" ON "payroll_squire_inputs" USING btree ("import_id");
