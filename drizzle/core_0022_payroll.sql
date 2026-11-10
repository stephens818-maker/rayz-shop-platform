CREATE TYPE "public"."time_entry_kind" AS ENUM('worked', 'training', 'pto');--> statement-breakpoint
CREATE TABLE "pay_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"label" text NOT NULL,
	"legal_entity" text DEFAULT 'Ray''z Inc.' NOT NULL,
	"export_tab" text NOT NULL,
	"anchor_start" date NOT NULL,
	"anchor_number" integer NOT NULL,
	"period_days" integer DEFAULT 14 NOT NULL,
	"check_offset_days" integer DEFAULT 6 NOT NULL,
	"number_resets_yearly" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pay_groups_shop_id_unique" UNIQUE("shop_id"),
	CONSTRAINT "pay_groups_period_days" CHECK ("pay_groups"."period_days" in (7, 14))
);
--> statement-breakpoint
CREATE TABLE "payroll_locked_ot" (
	"run_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"week_start" date NOT NULL,
	"ot_centi" integer NOT NULL,
	CONSTRAINT "payroll_locked_ot_staff_id_shop_id_period_start_week_start_pk" PRIMARY KEY("staff_id","shop_id","period_start","week_start")
);
--> statement-breakpoint
CREATE TABLE "payroll_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"staff_id" uuid NOT NULL,
	"field" text NOT NULL,
	"value" double precision NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_overrides_uq" UNIQUE("shop_id","period_start","staff_id","field")
);
--> statement-breakpoint
CREATE TABLE "payroll_profiles" (
	"staff_id" uuid PRIMARY KEY NOT NULL,
	"employee_number" text,
	"key_is_text" boolean DEFAULT false NOT NULL,
	"isolved_name" text,
	"export_position" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"shop_id" uuid,
	"hourly_rate" double precision DEFAULT 0 NOT NULL,
	"service_pct" double precision DEFAULT 0 NOT NULL,
	"product_pct" double precision DEFAULT 0.15 NOT NULL,
	"training_rate" double precision,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_rates_uq" UNIQUE NULLS NOT DISTINCT("staff_id","shop_id")
);
--> statement-breakpoint
CREATE TABLE "payroll_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pay_group_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"period_number" integer NOT NULL,
	"check_date" date NOT NULL,
	"settings" jsonb NOT NULL,
	"snapshot" jsonb NOT NULL,
	"locked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" uuid,
	CONSTRAINT "payroll_runs_uq" UNIQUE("pay_group_id","period_start")
);
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"kind" time_entry_kind DEFAULT 'worked' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_entries_order" CHECK ("time_entries"."ends_at" > "time_entries"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "brand_settings" ADD COLUMN "payroll" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "pay_groups" ADD CONSTRAINT "pay_groups_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_locked_ot" ADD CONSTRAINT "payroll_locked_ot_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_locked_ot" ADD CONSTRAINT "payroll_locked_ot_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_locked_ot" ADD CONSTRAINT "payroll_locked_ot_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_overrides" ADD CONSTRAINT "payroll_overrides_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_overrides" ADD CONSTRAINT "payroll_overrides_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_overrides" ADD CONSTRAINT "payroll_overrides_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_profiles" ADD CONSTRAINT "payroll_profiles_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_rates" ADD CONSTRAINT "payroll_rates_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_rates" ADD CONSTRAINT "payroll_rates_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_pay_group_id_pay_groups_id_fk" FOREIGN KEY ("pay_group_id") REFERENCES "public"."pay_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_locked_by_staff_id_fk" FOREIGN KEY ("locked_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "time_entries_starts_idx" ON "time_entries" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "time_entries_staff_idx" ON "time_entries" USING btree ("staff_id");--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["payroll.run","payroll.approve"]'::jsonb WHERE "key" = 'brand_admin' AND NOT ("permissions" ? 'payroll.run');