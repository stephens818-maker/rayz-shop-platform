CREATE TABLE "location_group_shops" (
	"group_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	CONSTRAINT "location_group_shops_group_id_shop_id_pk" PRIMARY KEY("group_id","shop_id")
);
--> statement-breakpoint
CREATE TABLE "location_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "location_group_shops" ADD CONSTRAINT "location_group_shops_group_id_location_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."location_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_group_shops" ADD CONSTRAINT "location_group_shops_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_groups" ADD CONSTRAINT "location_groups_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "location_groups_name_unique" ON "location_groups" USING btree (lower("name"));--> statement-breakpoint
ALTER TABLE "location_groups" ADD CONSTRAINT "location_groups_name_present" CHECK (length(btrim("name")) BETWEEN 1 AND 60);--> statement-breakpoint
-- New permission for saved location groups; Brand Admin's template includes it (Brand Owner has everything).
UPDATE "roles" SET "permissions" = "permissions" || '["locations.manage"]'::jsonb WHERE "key" IN ('brand_admin') AND NOT ("permissions" ? 'locations.manage');
