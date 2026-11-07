-- Consent records and app devices (C20, C3–C5). Marketing consent is its own yes per channel, apart from the appointment texts and emails
-- (sms_opt_in, email_opt_in) clients agree to when booking. Every grant or revoke is a consent_events row: which text the client saw
-- (its version), where (ios, android, web, pos, import, sms, email) and the app version. Imported Squire opt-ins count as appointment
-- consent only. Names match PR #8's draft so it can rebase onto this. Additive only.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "sms_marketing_opt_in" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "email_marketing_opt_in" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "push_marketing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "push_transactional" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_devices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE cascade,
  "platform" text NOT NULL,
  "provider" text NOT NULL,
  "token" text NOT NULL,
  "app_version" text,
  "os_version" text,
  "locale" text,
  "push_enabled" boolean DEFAULT true NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "customer_devices_platform_chk" CHECK ("platform" IN ('ios', 'android')),
  CONSTRAINT "customer_devices_provider_chk" CHECK ("provider" IN ('apns', 'fcm', 'expo'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_devices_token_uq" ON "customer_devices" ("token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_devices_customer_idx" ON "customer_devices" ("customer_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "consent_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "customer_id" uuid REFERENCES "customers"("id") ON DELETE set null,
  "phone" text,
  "email" text,
  "channel" text NOT NULL,
  "action" text NOT NULL,
  "text_version" text NOT NULL,
  "source" text NOT NULL,
  "app_version" text,
  "ip" text,
  "staff_id" uuid REFERENCES "staff"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "consent_events_channel_chk" CHECK ("channel" IN ('sms_transactional', 'sms_marketing', 'email', 'email_marketing', 'push_transactional', 'push_marketing')),
  CONSTRAINT "consent_events_action_chk" CHECK ("action" IN ('granted', 'revoked')),
  CONSTRAINT "consent_events_source_chk" CHECK ("source" IN ('ios', 'android', 'web', 'pos', 'import', 'sms', 'email'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consent_events_customer_idx" ON "consent_events" ("customer_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consent_events_phone_idx" ON "consent_events" ("phone");--> statement-breakpoint
-- The record is evidence, so it's append-only: nothing edits or removes a row (account deletion clears the contact columns only).
CREATE OR REPLACE FUNCTION "consent_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Consent records can''t be deleted' USING ERRCODE = 'check_violation', CONSTRAINT = 'consent_events_append_only';
  END IF;
  IF NEW.channel IS DISTINCT FROM OLD.channel OR NEW.action IS DISTINCT FROM OLD.action OR NEW.text_version IS DISTINCT FROM OLD.text_version
     OR NEW.source IS DISTINCT FROM OLD.source OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (NEW.phone IS NOT NULL AND NEW.phone IS DISTINCT FROM OLD.phone) OR (NEW.email IS NOT NULL AND NEW.email IS DISTINCT FROM OLD.email) THEN
    RAISE EXCEPTION 'Consent records can''t be changed' USING ERRCODE = 'check_violation', CONSTRAINT = 'consent_events_append_only';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "consent_events_append_only" ON "consent_events";--> statement-breakpoint
CREATE TRIGGER "consent_events_append_only" BEFORE UPDATE OR DELETE ON "consent_events" FOR EACH ROW EXECUTE FUNCTION "consent_events_append_only"();--> statement-breakpoint
-- A child's messages go to their parent under the parent's consent, so a child holds none of their own, marketing and app push included.
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
    NEW.sms_marketing_opt_in := false;
    NEW.email_marketing_opt_in := false;
    NEW.push_marketing := false;
    NEW.push_transactional := false;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "customers_family_guard" ON "customers";--> statement-breakpoint
CREATE TRIGGER "customers_family_guard" BEFORE INSERT OR UPDATE OF "guardian_id", "phone", "email", "sms_opt_in", "email_opt_in", "sms_marketing_opt_in", "email_marketing_opt_in", "push_marketing", "push_transactional" ON "customers" FOR EACH ROW EXECUTE FUNCTION "customers_family_guard"();
