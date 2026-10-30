-- Family accounts: a parent or guardian's profile carries up to the brand's limit of child profiles (customers.guardian_id). Children keep their own visits, badges, ratings, notes and photo, but no login or contact details: messages go to the parent's phone and email under the parent's consent. A family ticket pays for several appointments (sale_appointments), with each line tied to the appointment it was for. Additive only.
ALTER TABLE "brand_settings" ADD COLUMN IF NOT EXISTS "family" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "guardian_id" uuid REFERENCES "customers"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "birth_year" integer;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "former_guardian_id" uuid REFERENCES "customers"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "own_account_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" DROP CONSTRAINT IF EXISTS "customers_birth_year";--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_birth_year" CHECK ("birth_year" IS NULL OR "birth_year" BETWEEN 1900 AND 2200);--> statement-breakpoint
ALTER TABLE "customers" DROP CONSTRAINT IF EXISTS "customers_not_own_guardian";--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_not_own_guardian" CHECK ("guardian_id" IS NULL OR "guardian_id" <> "id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customers_guardian_idx" ON "customers" USING btree ("guardian_id") WHERE "guardian_id" IS NOT NULL;--> statement-breakpoint
-- One level only, and a child never holds contact details or consent of their own: anything that writes them (a re-run of the Squire clients file included) is cleared here. Named to run before customers_lookup_hashes, whose hashes it clears with the values.
CREATE OR REPLACE FUNCTION "customers_family_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.guardian_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM customers g WHERE g.id = NEW.guardian_id AND g.guardian_id IS NOT NULL) THEN
      RAISE EXCEPTION 'A child profile can''t have children of its own' USING ERRCODE = 'check_violation', CONSTRAINT = 'customers_family_one_level';
    END IF;
    IF EXISTS (SELECT 1 FROM customers k WHERE k.guardian_id = NEW.id) THEN
      RAISE EXCEPTION 'A parent with children on their account can''t become a child profile' USING ERRCODE = 'check_violation', CONSTRAINT = 'customers_family_one_level';
    END IF;
    NEW.phone := NULL;
    NEW.email := NULL;
    NEW.phone_hash := NULL;
    NEW.email_hash := NULL;
    NEW.sms_opt_in := false;
    NEW.email_opt_in := false;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "customers_family_guard" ON "customers";--> statement-breakpoint
CREATE TRIGGER "customers_family_guard" BEFORE INSERT OR UPDATE OF "guardian_id", "phone", "email", "sms_opt_in", "email_opt_in" ON "customers" FOR EACH ROW EXECUTE FUNCTION "customers_family_guard"();--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sale_appointments" (
	"sale_id" uuid NOT NULL REFERENCES "sales"("id") ON DELETE cascade,
	"appointment_id" uuid NOT NULL REFERENCES "appointments"("id") ON DELETE cascade,
	"added_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_appointments_pk" PRIMARY KEY ("sale_id", "appointment_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sale_appointments_appointment_idx" ON "sale_appointments" USING btree ("appointment_id");--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN IF NOT EXISTS "appointment_id" uuid REFERENCES "appointments"("id") ON DELETE set null;--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["clients.family"]'::jsonb WHERE "key" IN ('brand_admin', 'regional_manager', 'shop_manager', 'front_desk', 'shop_login') AND NOT ("permissions" ? 'clients.family');
