-- Payroll reports (Charles, 2026-10-27): iSolved stays the system of record; each pay period's iSolved file is draft until every shop in it is approved and locked, approved after, and sent once someone with "Approve and lock a pay period" marks it uploaded. One row per period, with what each shop's tab carried; undoing it deletes the row (audited).
CREATE TABLE "payroll_export_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"shops" jsonb NOT NULL,
	"note" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_by" uuid,
	CONSTRAINT "payroll_export_sends_uq" UNIQUE("period_start","period_end"),
	CONSTRAINT "payroll_export_sends_dates" CHECK ("payroll_export_sends"."period_end" >= "payroll_export_sends"."period_start")
);--> statement-breakpoint
ALTER TABLE "payroll_export_sends" ADD CONSTRAINT "payroll_export_sends_sent_by_staff_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The payroll reports are brand-only by default: the brand roles and the Bookkeeper get them; no location role does, and a shop login never can.
UPDATE "roles" SET "permissions" = "permissions" || '["report.payroll_summary.view","report.payroll_summary.export","report.payroll_timesheets.view","report.payroll_timesheets.export","report.payroll_tips.view","report.payroll_tips.export","report.payroll_commission.view","report.payroll_commission.export","report.payroll_full_time.view","report.payroll_full_time.export","report.payroll_labor.view","report.payroll_labor.export","report.payroll_overtime.view","report.payroll_overtime.export","report.payroll_isolved.view","report.payroll_isolved.export"]'::jsonb WHERE "key" IN ('brand_admin', 'bookkeeper');
