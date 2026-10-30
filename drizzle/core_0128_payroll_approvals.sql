-- Charles's Payroll Report (2026-10-27): run, review, approve, then lock. An approval records the figures it approved (a hash of every shop's rows, totals and iSolved file) and who approved them; locking needs a current approval whose figures still match. Approvals are never edited or deleted, only revoked with a reason (a new approval of changed figures revokes the old one). One active approval per pay period. Additive only.
CREATE TABLE IF NOT EXISTS "payroll_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"figures_hash" text NOT NULL,
	"totals" jsonb NOT NULL,
	"note" text,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" uuid REFERENCES "staff"("id"),
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid REFERENCES "staff"("id"),
	"revoke_reason" text,
	CONSTRAINT "payroll_approvals_dates" CHECK ("period_end" >= "period_start"),
	CONSTRAINT "payroll_approvals_revoke_reason" CHECK ("revoked_at" IS NULL OR ("revoke_reason" IS NOT NULL AND char_length(btrim("revoke_reason")) > 0)),
	CONSTRAINT "payroll_approvals_note_len" CHECK ("note" IS NULL OR char_length("note") <= 300),
	CONSTRAINT "payroll_approvals_reason_len" CHECK ("revoke_reason" IS NULL OR char_length("revoke_reason") <= 300)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_approvals_active_uq" ON "payroll_approvals" USING btree ("period_start", "period_end") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payroll_approvals_period_idx" ON "payroll_approvals" USING btree ("period_start", "period_end", "approved_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "payroll_approvals_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payroll_approvals rows are never deleted: revoke the approval with a reason' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."revoked_at" IS NOT NULL
    OR NEW."id" IS DISTINCT FROM OLD."id" OR NEW."period_start" IS DISTINCT FROM OLD."period_start" OR NEW."period_end" IS DISTINCT FROM OLD."period_end"
    OR NEW."figures_hash" IS DISTINCT FROM OLD."figures_hash" OR NEW."totals" IS DISTINCT FROM OLD."totals" OR NEW."note" IS DISTINCT FROM OLD."note"
    OR NEW."approved_at" IS DISTINCT FROM OLD."approved_at" OR NEW."approved_by" IS DISTINCT FROM OLD."approved_by" THEN
    RAISE EXCEPTION 'An approval is only ever revoked, once: approve again instead of changing one' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "payroll_approvals_guard" ON "payroll_approvals";--> statement-breakpoint
CREATE TRIGGER "payroll_approvals_guard" BEFORE UPDATE OR DELETE ON "payroll_approvals" FOR EACH ROW EXECUTE FUNCTION "payroll_approvals_guard"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "payroll_approvals_scrub_sensitive" ON "payroll_approvals";--> statement-breakpoint
CREATE TRIGGER "payroll_approvals_scrub_sensitive" BEFORE INSERT OR UPDATE OF "note", "revoke_reason" ON "payroll_approvals" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('note', 'revoke_reason');--> statement-breakpoint
-- The owner's row: hours go to iSolved, Hourly Total is $0 (the workbook typed 0 over the formula).
ALTER TABLE "payroll_profiles" ADD COLUMN IF NOT EXISTS "zero_hourly_pay" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- The Payroll Report is brand-only like every payroll report: the brand roles and the Bookkeeper get it; no location role does.
UPDATE "roles" SET "permissions" = "permissions" || '["report.payroll_report.view","report.payroll_report.export"]'::jsonb WHERE "key" IN ('brand_admin', 'bookkeeper') AND NOT ("permissions" ? 'report.payroll_report.view');
