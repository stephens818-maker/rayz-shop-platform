CREATE TABLE "customer_squire_ids" (
	"squire_id" text PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"shop_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "customers_squire_uq";--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "sms_opt_in" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "email_opt_in" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "booked_at_known" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "preferred_staff_id" uuid;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "stats" jsonb;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "squire_ref" text;--> statement-breakpoint
ALTER TABLE "customer_squire_ids" ADD CONSTRAINT "customer_squire_ids_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_squire_ids" ADD CONSTRAINT "customer_squire_ids_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_squire_ids_customer_idx" ON "customer_squire_ids" USING btree ("customer_id");--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_preferred_staff_id_staff_id_fk" FOREIGN KEY ("preferred_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customers_home_shop_idx" ON "customers" USING btree ("home_shop_id");--> statement-breakpoint
INSERT INTO "customer_squire_ids" ("squire_id", "customer_id", "shop_id") SELECT "squire_id", "id", "home_shop_id" FROM "customers" WHERE "squire_id" IS NOT NULL;--> statement-breakpoint
UPDATE "appointments" SET "booked_at_known" = false WHERE "source" = 'import';--> statement-breakpoint
ALTER TABLE "customers" DROP COLUMN "squire_id";--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_squire_ref_unique" UNIQUE("squire_ref");