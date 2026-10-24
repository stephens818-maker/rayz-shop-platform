-- The Morning Dashboard: the morning digest becomes an HTML email (with an optional PDF and text line) covering the last open day, and an in-app page with the same content behind its own report permission. notification_jobs gets an html_body for the HTML version of an email; morning_dashboard_sends records each person, day, version (all locations or one shop) and channel so the job sends once, even when rerun. Location management roles get the new report. Additive only.
ALTER TABLE "notification_jobs" ADD COLUMN "html_body" text;--> statement-breakpoint
DROP TRIGGER IF EXISTS "notification_jobs_scrub_sensitive" ON "notification_jobs";--> statement-breakpoint
CREATE TRIGGER "notification_jobs_scrub_sensitive" BEFORE INSERT OR UPDATE OF "body", "subject", "html_body" ON "notification_jobs" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('body', 'subject', 'html_body');--> statement-breakpoint
CREATE TABLE "morning_dashboard_sends" (
	"date" date NOT NULL,
	"staff_id" uuid NOT NULL REFERENCES "staff"("id") ON DELETE cascade,
	"scope" text NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'building' NOT NULL,
	"report_date" date,
	"job_id" uuid,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "morning_dashboard_sends_date_staff_id_scope_channel_pk" PRIMARY KEY("date","staff_id","scope","channel"),
	CONSTRAINT "morning_dashboard_sends_channel" CHECK ("channel" in ('email', 'sms')),
	CONSTRAINT "morning_dashboard_sends_status" CHECK ("status" in ('building', 'queued', 'skipped'))
);--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["report.morning_dashboard.view","report.morning_dashboard.export"]'::jsonb WHERE "key" IN ('brand_admin', 'regional_manager', 'shop_manager') AND NOT ("permissions" ? 'report.morning_dashboard.view');
