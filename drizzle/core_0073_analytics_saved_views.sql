-- Analytics (period over period) goes to every role with Retention and rebook KPIs, export where that report's export is. Saved report views: a person's named filters for any report, kept as the report's query string, optionally shared with everyone who can open that report.
UPDATE "roles" SET "permissions" = "permissions" || '["report.analytics.view"]'::jsonb WHERE "permissions" ? 'report.kpis.view' AND NOT ("permissions" ? 'report.analytics.view');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["report.analytics.export"]'::jsonb WHERE "permissions" ? 'report.kpis.export' AND NOT ("permissions" ? 'report.analytics.export');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "report_views" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" uuid NOT NULL REFERENCES "staff"("id") ON DELETE CASCADE,
  "report" text NOT NULL,
  "name" text NOT NULL,
  "query" text NOT NULL,
  "shared" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "report_views_name" CHECK (length(trim("name")) between 1 and 60),
  CONSTRAINT "report_views_query" CHECK (length("query") <= 2000)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_views_report_idx" ON "report_views" ("report", "owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "report_views_owner_name_uq" ON "report_views" ("owner_id", "report", lower("name"));
