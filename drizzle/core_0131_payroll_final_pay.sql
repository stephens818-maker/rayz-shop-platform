-- Payroll spec review N9 (2026-10-27): someone who leaves is paid by the next regular payday at the latest, so their final pay can run off-cycle. A final pay approves one employee's figures for the pay period of their last day, as they stand, at every shop they worked: their own iSolved file per shop, and they're left out of the regular file for that period so nothing is paid twice. Kept as approved: never edited or deleted. One per employee per pay period. Additive only.
CREATE TABLE IF NOT EXISTS "payroll_final_pays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL REFERENCES "staff"("id"),
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"last_day" date NOT NULL,
	"snapshot" jsonb NOT NULL,
	"figures_hash" text NOT NULL,
	"note" text,
	"approved_by" uuid REFERENCES "staff"("id"),
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_final_pays_dates" CHECK ("period_end" >= "period_start" AND "last_day" >= "period_start" AND "last_day" <= "period_end"),
	CONSTRAINT "payroll_final_pays_note_len" CHECK ("note" IS NULL OR char_length("note") <= 300)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_final_pays_staff_period_uq" ON "payroll_final_pays" USING btree ("staff_id", "period_start");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payroll_final_pays_period_idx" ON "payroll_final_pays" USING btree ("period_start");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "payroll_final_pays_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A final pay is kept as approved: it is never changed or deleted' USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "payroll_final_pays_guard" ON "payroll_final_pays";--> statement-breakpoint
CREATE TRIGGER "payroll_final_pays_guard" BEFORE UPDATE OR DELETE ON "payroll_final_pays" FOR EACH ROW EXECUTE FUNCTION "payroll_final_pays_guard"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "payroll_final_pays_scrub_sensitive" ON "payroll_final_pays";--> statement-breakpoint
CREATE TRIGGER "payroll_final_pays_scrub_sensitive" BEFORE INSERT ON "payroll_final_pays" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('note');
