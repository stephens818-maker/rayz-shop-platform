-- The custom report builder: saved_reports keeps each report's definition (columns, filters, grouping, totals, dates and locations), who it's shared with and its email schedule; saved_report_sends records each scheduled report, recipient and day so a send goes out once, even when the cron reruns. Indexes for the per-client facts the reports read. Location management roles can open, build and export custom reports. Additive only.
CREATE TABLE "saved_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"source" text DEFAULT 'customers' NOT NULL,
	"definition" jsonb NOT NULL,
	"owner_id" uuid NOT NULL REFERENCES "staff"("id") ON DELETE cascade,
	"visibility" text DEFAULT 'private' NOT NULL,
	"role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"schedule" jsonb,
	"morning" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_reports_visibility" CHECK ("visibility" in ('private', 'roles', 'template')),
	CONSTRAINT "saved_reports_source" CHECK ("source" in ('customers', 'sales', 'appointments', 'staff', 'inventory', 'tips', 'campaigns'))
);--> statement-breakpoint
CREATE INDEX "saved_reports_owner_idx" ON "saved_reports" USING btree ("owner_id");--> statement-breakpoint
CREATE TABLE "saved_report_sends" (
	"report_id" uuid NOT NULL REFERENCES "saved_reports"("id") ON DELETE cascade,
	"staff_id" uuid NOT NULL REFERENCES "staff"("id") ON DELETE cascade,
	"period" date NOT NULL,
	"status" text DEFAULT 'building' NOT NULL,
	"rows" integer,
	"job_id" uuid,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_report_sends_report_id_staff_id_period_pk" PRIMARY KEY("report_id","staff_id","period"),
	CONSTRAINT "saved_report_sends_status" CHECK ("status" in ('building', 'queued', 'skipped'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_customer_date_idx" ON "sales" ("customer_id", "business_date") WHERE "customer_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_customer_status_idx" ON "appointments" ("customer_id", "status", "starts_at") WHERE "customer_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customers_created_at_idx" ON "customers" ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customers_preferred_staff_idx" ON "customers" ("preferred_staff_id") WHERE "preferred_staff_id" is not null;--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["report_builder.view","report_builder.build","report_builder.export"]'::jsonb WHERE "key" IN ('brand_admin', 'regional_manager', 'shop_manager') AND NOT ("permissions" ? 'report_builder.view');
