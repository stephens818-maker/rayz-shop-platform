-- Customer app, first part: where each shop's clients book (here, or a link out to the old booking site while shops move over one at a time), and the client's own preferences note, kept apart from staff notes. Additive only.
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "booking_mode" text DEFAULT 'platform' NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "external_booking_url" text;--> statement-breakpoint
ALTER TABLE "shops" DROP CONSTRAINT IF EXISTS "shops_booking_mode_chk";--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_booking_mode_chk" CHECK ("booking_mode" in ('platform', 'external') AND ("booking_mode" = 'platform' OR coalesce("external_booking_url", '') ~ '^https://[^[:space:]]+\.[^[:space:]]+$'));--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "preferences_note" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "preferences_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" DROP CONSTRAINT IF EXISTS "customers_preferences_note_len_chk";--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_preferences_note_len_chk" CHECK (char_length("preferences_note") <= 500);--> statement-breakpoint
DROP TRIGGER IF EXISTS "customers_preferences_scrub_sensitive" ON "customers";--> statement-breakpoint
CREATE TRIGGER "customers_preferences_scrub_sensitive" BEFORE INSERT OR UPDATE OF "preferences_note" ON "customers" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('preferences_note');--> statement-breakpoint
-- Staff read the client's note beside their own, so it gets the same contact redaction as staff notes (after the scrub trigger above, by name order).
CREATE OR REPLACE FUNCTION "customers_redact_preferences"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.preferences_note IS NOT NULL THEN NEW.preferences_note := "redact_contact_text"(NEW.preferences_note); END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "customers_redact_preferences" ON "customers";--> statement-breakpoint
CREATE TRIGGER "customers_redact_preferences" BEFORE INSERT OR UPDATE OF "preferences_note" ON "customers" FOR EACH ROW EXECUTE FUNCTION "customers_redact_preferences"();
