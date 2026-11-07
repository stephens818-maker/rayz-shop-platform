CREATE TABLE "client_access_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"staff_id" uuid,
	"actor_label" text NOT NULL,
	"kind" text NOT NULL,
	"profiles" integer DEFAULT 0 NOT NULL,
	"searches" integer DEFAULT 0 NOT NULL,
	"window_minutes" integer NOT NULL,
	"acknowledged_by" uuid,
	"acknowledged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "client_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"staff_id" uuid,
	"actor_label" text NOT NULL,
	"shop_id" uuid,
	"customer_id" uuid,
	"kind" text NOT NULL,
	"field" text,
	"reason" text,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "client_field_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"field" text NOT NULL,
	"level" text NOT NULL,
	"role_id" uuid,
	"staff_id" uuid,
	"shop_id" uuid,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_field_rules_uq" UNIQUE NULLS NOT DISTINCT("field","role_id","staff_id","shop_id")
);
--> statement-breakpoint
CREATE TABLE "client_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_fields_label_unique" UNIQUE("label")
);
--> statement-breakpoint
ALTER TABLE "brand_settings" ADD COLUMN "client_lookup_limits" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "birthday" date;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "client_access_alerts" ADD CONSTRAINT "client_access_alerts_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_access_alerts" ADD CONSTRAINT "client_access_alerts_acknowledged_by_staff_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_access_log" ADD CONSTRAINT "client_access_log_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_access_log" ADD CONSTRAINT "client_access_log_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_field_rules" ADD CONSTRAINT "client_field_rules_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_field_rules" ADD CONSTRAINT "client_field_rules_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_field_rules" ADD CONSTRAINT "client_field_rules_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_field_rules" ADD CONSTRAINT "client_field_rules_updated_by_staff_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_access_alerts_at_idx" ON "client_access_alerts" USING btree ("at");--> statement-breakpoint
CREATE INDEX "client_access_alerts_staff_idx" ON "client_access_alerts" USING btree ("staff_id","at");--> statement-breakpoint
CREATE INDEX "client_access_staff_at_idx" ON "client_access_log" USING btree ("staff_id","at");--> statement-breakpoint
CREATE INDEX "client_access_customer_idx" ON "client_access_log" USING btree ("customer_id","at");--> statement-breakpoint
CREATE INDEX "client_access_at_idx" ON "client_access_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "client_field_rules_staff_idx" ON "client_field_rules" USING btree ("staff_id");--> statement-breakpoint
CREATE INDEX "client_field_rules_role_idx" ON "client_field_rules" USING btree ("role_id");--> statement-breakpoint
ALTER TABLE "client_field_rules" ADD CONSTRAINT "client_field_rules_level_valid" CHECK ("level" IN ('hidden', 'masked', 'full'));--> statement-breakpoint
ALTER TABLE "client_field_rules" ADD CONSTRAINT "client_field_rules_one_subject" CHECK (("role_id" IS NULL) <> ("staff_id" IS NULL));--> statement-breakpoint
ALTER TABLE "client_field_rules" ADD CONSTRAINT "client_field_rules_field_valid" CHECK ("field" IN ('phone', 'email', 'address', 'birthday', 'notes', 'preferred_barber', 'ratings') OR "field" ~ '^custom:[0-9a-f-]{36}$');--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_custom_fields_object" CHECK (jsonb_typeof("custom_fields") = 'object');--> statement-breakpoint
-- "See client phone numbers and emails" becomes field visibility. Custom roles and people that had it keep seeing both in full;
-- people it was taken from see them masked. The built-in roles get their new defaults (src/domain/client-privacy.ts).
INSERT INTO "client_field_rules" ("field", "level", "role_id")
	SELECT f."field", 'full', r."id" FROM "roles" r CROSS JOIN (VALUES ('phone'), ('email')) AS f("field")
	WHERE r."key" IS NULL AND r."permissions" ? 'clients.contact';--> statement-breakpoint
INSERT INTO "client_field_rules" ("field", "level", "staff_id")
	SELECT f."field", CASE WHEN (s."permission_overrides" ->> 'clients.contact')::boolean THEN 'full' ELSE 'masked' END, s."id"
	FROM "staff" s CROSS JOIN (VALUES ('phone'), ('email')) AS f("field")
	WHERE s."permission_overrides" ? 'clients.contact';--> statement-breakpoint
UPDATE "staff" SET "permission_overrides" = "permission_overrides" - 'clients.contact' WHERE "permission_overrides" ? 'clients.contact';--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" - 'clients.contact' WHERE "key" IS NULL;--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" - 'clients.contact' WHERE "key" IN ('brand_admin', 'regional_manager', 'shop_manager', 'front_desk');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["clients.reveal","clients.message"]'::jsonb WHERE "key" IN ('brand_admin', 'regional_manager', 'shop_manager') AND NOT ("permissions" ? 'clients.reveal');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["clients.message"]'::jsonb WHERE "key" IN ('front_desk', 'barber') AND NOT ("permissions" ? 'clients.message');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["clients.privacy"]'::jsonb WHERE "key" IN ('brand_admin') AND NOT ("permissions" ? 'clients.privacy');
