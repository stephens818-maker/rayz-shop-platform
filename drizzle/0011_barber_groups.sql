CREATE TABLE "staff_group_members" (
	"group_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	CONSTRAINT "staff_group_members_group_id_staff_id_pk" PRIMARY KEY("group_id","staff_id")
);
--> statement-breakpoint
CREATE TABLE "staff_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "staff_group_members" ADD CONSTRAINT "staff_group_members_group_id_staff_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."staff_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_group_members" ADD CONSTRAINT "staff_group_members_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_groups" ADD CONSTRAINT "staff_groups_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_groups_name_unique" ON "staff_groups" USING btree (lower("name"));--> statement-breakpoint
ALTER TABLE "staff_groups" ADD CONSTRAINT "staff_groups_name_present" CHECK (length(btrim("name")) BETWEEN 1 AND 60);--> statement-breakpoint
-- Seeing other barbers' numbers in reports is now a permission. Every template except Barber gets it.
UPDATE "roles" SET "permissions" = "permissions" || '["reports.all_staff"]'::jsonb WHERE "key" IN ('brand_admin', 'regional_manager', 'shop_manager', 'front_desk') AND NOT ("permissions" ? 'reports.all_staff');--> statement-breakpoint
-- Custom roles saw every barber's numbers before, so they keep doing so.
UPDATE "roles" SET "permissions" = "permissions" || '["reports.all_staff"]'::jsonb WHERE "key" IS NULL AND NOT ("permissions" ? 'reports.all_staff');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["barber_groups.manage"]'::jsonb WHERE "key" IN ('brand_admin') AND NOT ("permissions" ? 'barber_groups.manage');
