-- Scale to 50+ locations: optional regions, a background task queue and per-location daily rollups.
CREATE TABLE "regions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "regions_slug_unique" UNIQUE("slug")
);--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "region_id" uuid REFERENCES "regions"("id") ON DELETE set null;--> statement-breakpoint
CREATE INDEX "shops_region_idx" ON "shops" USING btree ("region_id");--> statement-breakpoint
-- Background tasks per location (or client bucket) and day, claimed with FOR UPDATE SKIP LOCKED.
CREATE TABLE "job_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"shard" text NOT NULL,
	"run_on" date NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_tasks_uq" UNIQUE("kind","shard","run_on"),
	CONSTRAINT "job_tasks_status" CHECK ("status" IN ('queued', 'running', 'done', 'failed'))
);--> statement-breakpoint
CREATE INDEX "job_tasks_claim_idx" ON "job_tasks" USING btree ("status","locked_until");--> statement-breakpoint
-- One location's day for the brand's location comparison, with its region.
CREATE TABLE "location_daily_stats" (
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
	"day" date NOT NULL,
	"region_id" uuid REFERENCES "regions"("id") ON DELETE set null,
	"tickets" integer DEFAULT 0 NOT NULL,
	"gross_cents" bigint DEFAULT 0 NOT NULL,
	"discount_cents" bigint DEFAULT 0 NOT NULL,
	"service_net_cents" bigint DEFAULT 0 NOT NULL,
	"product_net_cents" bigint DEFAULT 0 NOT NULL,
	"refund_cents" bigint DEFAULT 0 NOT NULL,
	"tax_cents" bigint DEFAULT 0 NOT NULL,
	"tip_cents" bigint DEFAULT 0 NOT NULL,
	"clients" integer DEFAULT 0 NOT NULL,
	"new_clients" integer DEFAULT 0 NOT NULL,
	"appointments" integer DEFAULT 0 NOT NULL,
	"no_shows" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "location_daily_stats_shop_id_day_pk" PRIMARY KEY("shop_id","day")
);--> statement-breakpoint
CREATE INDEX "location_daily_stats_day_idx" ON "location_daily_stats" USING btree ("day");--> statement-breakpoint
CREATE INDEX "location_daily_stats_region_day_idx" ON "location_daily_stats" USING btree ("region_id","day");--> statement-breakpoint
-- The location comparison report goes wherever the KPIs report already is.
UPDATE "roles" SET "permissions" = "permissions" || '["report.rollup.view"]'::jsonb WHERE "permissions" ? 'report.kpis.view' AND NOT ("permissions" ? 'report.rollup.view');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["report.rollup.export"]'::jsonb WHERE "permissions" ? 'report.kpis.export' AND NOT ("permissions" ? 'report.rollup.export');
