-- I14: a web guest booking whose phone or email matches an existing profile goes on a new, unverified guest record instead, never onto the existing profile; it's folded in once that phone signs in with a code.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "unverified_guest_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customers_unverified_guest_idx" ON "customers" USING btree ("phone") WHERE "unverified_guest_at" IS NOT NULL;--> statement-breakpoint
-- I15: "Secure my profile": signing in by phone also needs a code to the profile's verified email.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "secured_at" timestamp with time zone;--> statement-breakpoint
-- I15: a parent asking for a child's profile on their phone to become their dependent, when the shop has to check first.
ALTER TABLE "identity_help_requests" DROP CONSTRAINT IF EXISTS "identity_help_requests_reason_chk";--> statement-breakpoint
ALTER TABLE "identity_help_requests" ADD CONSTRAINT "identity_help_requests_reason_chk" CHECK ("reason" in ('identity_check', 'idle_number', 'cant_sign_in', 'child_claim'));--> statement-breakpoint
-- I16: when the account holder said they're 13 or older.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "age_confirmed_at" timestamp with time zone;--> statement-breakpoint
-- I16: a dependent keeps a first name and an optional birth year only. Contact, consent, last name, full birthday, address and nickname are cleared on every write.
CREATE OR REPLACE FUNCTION "customers_family_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.guardian_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM customers g WHERE g.id = NEW.guardian_id AND g.guardian_id IS NOT NULL) THEN
      RAISE EXCEPTION 'A child profile can''t have children of its own' USING ERRCODE = 'check_violation', CONSTRAINT = 'customers_family_one_level';
    END IF;
    IF EXISTS (SELECT 1 FROM customers k WHERE k.guardian_id = NEW.id) THEN
      RAISE EXCEPTION 'A parent with children on their account can''t become a child profile' USING ERRCODE = 'check_violation', CONSTRAINT = 'customers_family_one_level';
    END IF;
    IF NEW.birthday IS NOT NULL AND NEW.birth_year IS NULL THEN
      NEW.birth_year := extract(year from NEW.birthday)::int;
    END IF;
    NEW.birthday := NULL;
    NEW.birthday_hash := NULL;
    NEW.last_name := NULL;
    NEW.nickname := NULL;
    NEW.address := NULL;
    NEW.address_hash := NULL;
    NEW.phone := NULL;
    NEW.email := NULL;
    NEW.email_verified_at := NULL;
    NEW.phone_hash := NULL;
    NEW.email_hash := NULL;
    NEW.secured_at := NULL;
    NEW.sms_opt_in := false;
    NEW.email_opt_in := false;
    NEW.sms_marketing_opt_in := false;
    NEW.email_marketing_opt_in := false;
    NEW.push_marketing := false;
    NEW.push_transactional := false;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "customers_family_guard" ON "customers";--> statement-breakpoint
CREATE TRIGGER "customers_family_guard" BEFORE INSERT OR UPDATE OF "guardian_id", "phone", "email", "email_verified_at", "sms_opt_in", "email_opt_in", "sms_marketing_opt_in", "email_marketing_opt_in", "push_marketing", "push_transactional", "last_name", "birthday", "nickname", "address", "secured_at" ON "customers" FOR EACH ROW EXECUTE FUNCTION "customers_family_guard"();--> statement-breakpoint
UPDATE "customers" SET "guardian_id" = "guardian_id" WHERE "guardian_id" IS NOT NULL;--> statement-breakpoint
DELETE FROM "client_photos" WHERE "customer_id" IN (SELECT "id" FROM "customers" WHERE "guardian_id" IS NOT NULL);--> statement-breakpoint
-- P1: no biometrics. Phone punches can be proven by the front-desk screen's QR code or the shop's NFC tag.
ALTER TABLE "time_punches" DROP CONSTRAINT IF EXISTS "time_punches_method";--> statement-breakpoint
ALTER TABLE "time_punches" ADD CONSTRAINT "time_punches_method" CHECK ("method" in ('device', 'gps', 'network', 'qr', 'nfc', 'none', 'manager'));
