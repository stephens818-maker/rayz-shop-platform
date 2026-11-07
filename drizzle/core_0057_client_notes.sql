-- Client notes that follow the client to every location: profile notes (pinned ones show on the appointment block and at check-in), cut notes per visit (guard, style, products, before and after photos) and private notes for managers. The profile's notes field (customers.notes, which the Squire importer fills) is kept as the client's record note, a pinned profile note kept in step by trigger; imported appointment notes become Squire cut notes. Phone numbers and email addresses are removed from every note, whoever writes it. Additive only.
CREATE TABLE IF NOT EXISTS "client_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE cascade,
	"kind" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"details" jsonb,
	"appointment_id" uuid REFERENCES "appointments"("id") ON DELETE set null,
	"shop_id" uuid REFERENCES "shops"("id") ON DELETE set null,
	"author_staff_id" uuid REFERENCES "staff"("id") ON DELETE set null,
	"author_label" text,
	"source" text DEFAULT 'staff' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	CONSTRAINT "client_notes_kind" CHECK ("kind" IN ('profile', 'visit', 'private')),
	CONSTRAINT "client_notes_source" CHECK ("source" IN ('staff', 'record', 'squire_visit')),
	CONSTRAINT "client_notes_record_is_profile" CHECK ("source" <> 'record' OR "kind" = 'profile'),
	CONSTRAINT "client_notes_author_label" CHECK ("author_label" IS NULL OR char_length("author_label") <= 40)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_notes_customer_idx" ON "client_notes" USING btree ("customer_id", "created_at" DESC) WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_notes_appointment_idx" ON "client_notes" USING btree ("appointment_id") WHERE "appointment_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "client_notes_one_record" ON "client_notes" USING btree ("customer_id") WHERE "source" = 'record';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "client_notes_one_squire_visit" ON "client_notes" USING btree ("appointment_id") WHERE "source" = 'squire_visit';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "client_note_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL REFERENCES "client_notes"("id") ON DELETE cascade,
	"kind" text NOT NULL,
	"data_url" text NOT NULL,
	"created_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_note_photos_kind" CHECK ("kind" IN ('before', 'after'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_note_photos_note_idx" ON "client_note_photos" USING btree ("note_id");--> statement-breakpoint
-- Same patterns as redactContact in src/domain/client-notes.ts; keep the two in step. Email first, then phone numbers with an area code (optional +1, brackets, dots, dashes or spaces), then 555-1234 style local numbers. Never inside a longer run of digits or letters.
CREATE OR REPLACE FUNCTION "redact_contact_text"(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
	SELECT regexp_replace(
		regexp_replace(
			regexp_replace(t, '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}', '[email removed]', 'g'),
			'(?<![0-9A-Za-z+])(?:\+?1[ .-]?)?(?:\([0-9]{3}\) ?|[0-9]{3}[ .-]?)[0-9]{3}[ .-]?[0-9]{4}(?![0-9A-Za-z])', '[phone removed]', 'g'),
		'(?<![0-9A-Za-z.-])[0-9]{3}[.-][0-9]{4}(?![0-9A-Za-z]|[.-][0-9])', '[phone removed]', 'g')
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "redact_contact_jsonb"(j jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
	out jsonb;
BEGIN
	CASE jsonb_typeof(j)
		WHEN 'string' THEN
			RETURN to_jsonb("redact_contact_text"(j #>> '{}'));
		WHEN 'array' THEN
			SELECT coalesce(jsonb_agg("redact_contact_jsonb"(e) ORDER BY i), '[]'::jsonb) INTO out FROM jsonb_array_elements(j) WITH ORDINALITY AS a(e, i);
			RETURN out;
		WHEN 'object' THEN
			SELECT coalesce(jsonb_object_agg(key, "redact_contact_jsonb"(value)), '{}'::jsonb) INTO out FROM jsonb_each(j);
			RETURN out;
		ELSE
			RETURN j;
	END CASE;
END
$$;--> statement-breakpoint
-- Card numbers and the like go first (scrub_sensitive_text), so a phone pattern never eats part of one.
CREATE OR REPLACE FUNCTION "client_notes_redact"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	NEW.body := "redact_contact_text"("scrub_sensitive_text"(NEW.body));
	IF NEW.details IS NOT NULL THEN NEW.details := "redact_contact_jsonb"("scrub_sensitive_jsonb"(NEW.details)); END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "customers_redact_notes"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.notes IS NOT NULL THEN NEW.notes := "redact_contact_text"("scrub_sensitive_text"(NEW.notes)); END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
-- The record note follows customers.notes: written by the profile, a child's profile, a merge or the Squire importer. Who wrote it is stamped by the app (stampRecordNote); here it's cleared, since the trigger can't know.
CREATE OR REPLACE FUNCTION "client_notes_from_customer"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'UPDATE' AND NEW.notes IS NOT DISTINCT FROM OLD.notes THEN RETURN NULL; END IF;
	IF coalesce(btrim(NEW.notes), '') = '' THEN
		UPDATE "client_notes" SET "deleted_at" = now(), "updated_at" = now(), "updated_by" = NULL
		WHERE "customer_id" = NEW.id AND "source" = 'record' AND "deleted_at" IS NULL;
		RETURN NULL;
	END IF;
	INSERT INTO "client_notes" ("customer_id", "kind", "pinned", "body", "source", "shop_id")
	VALUES (NEW.id, 'profile', true, NEW.notes, 'record', NEW.home_shop_id)
	ON CONFLICT ("customer_id") WHERE "source" = 'record' DO UPDATE
		SET "body" = EXCLUDED."body", "updated_at" = now(), "updated_by" = NULL, "deleted_at" = NULL, "deleted_by" = NULL,
			"pinned" = CASE WHEN "client_notes"."deleted_at" IS NULL THEN "client_notes"."pinned" ELSE true END
		WHERE "client_notes"."body" IS DISTINCT FROM EXCLUDED."body" OR "client_notes"."deleted_at" IS NOT NULL;
	RETURN NULL;
END $$;--> statement-breakpoint
-- A Squire appointment's notes become that visit's cut note, dated the visit, at its shop. Bookings made here keep their notes as booking notes.
CREATE OR REPLACE FUNCTION "client_notes_from_import"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.source <> 'import' THEN RETURN NULL; END IF;
	IF TG_OP = 'UPDATE' AND NEW.notes IS NOT DISTINCT FROM OLD.notes AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id THEN RETURN NULL; END IF;
	IF NEW.customer_id IS NULL OR coalesce(btrim(NEW.notes), '') = '' THEN
		UPDATE "client_notes" SET "deleted_at" = now(), "updated_at" = now()
		WHERE "appointment_id" = NEW.id AND "source" = 'squire_visit' AND "deleted_at" IS NULL;
		RETURN NULL;
	END IF;
	INSERT INTO "client_notes" ("customer_id", "kind", "body", "appointment_id", "shop_id", "author_label", "source", "created_at", "updated_at")
	VALUES (NEW.customer_id, 'visit', btrim(NEW.notes), NEW.id, NEW.shop_id, 'Squire', 'squire_visit', NEW.starts_at, now())
	ON CONFLICT ("appointment_id") WHERE "source" = 'squire_visit' DO UPDATE
		SET "body" = EXCLUDED."body", "customer_id" = EXCLUDED."customer_id", "updated_at" = now(), "deleted_at" = NULL, "deleted_by" = NULL
		WHERE "client_notes"."body" IS DISTINCT FROM EXCLUDED."body" OR "client_notes"."customer_id" IS DISTINCT FROM EXCLUDED."customer_id" OR "client_notes"."deleted_at" IS NOT NULL;
	RETURN NULL;
END $$;--> statement-breakpoint
UPDATE "customers" SET "notes" = "redact_contact_text"("notes") WHERE "notes" IS NOT NULL AND "notes" IS DISTINCT FROM "redact_contact_text"("notes");--> statement-breakpoint
INSERT INTO "client_notes" ("customer_id", "kind", "pinned", "body", "source", "shop_id", "created_at", "updated_at")
SELECT "id", 'profile', true, "notes", 'record', "home_shop_id", "created_at", now() FROM "customers" WHERE coalesce(btrim("notes"), '') <> ''
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "client_notes" ("customer_id", "kind", "body", "appointment_id", "shop_id", "author_label", "source", "created_at", "updated_at")
SELECT "customer_id", 'visit', btrim("notes"), "id", "shop_id", 'Squire', 'squire_visit', "starts_at", now() FROM "appointments"
WHERE "source" = 'import' AND "customer_id" IS NOT NULL AND coalesce(btrim("notes"), '') <> ''
ON CONFLICT DO NOTHING;--> statement-breakpoint
DROP TRIGGER IF EXISTS "client_notes_redact_contact" ON "client_notes";--> statement-breakpoint
CREATE TRIGGER "client_notes_redact_contact" BEFORE INSERT OR UPDATE OF "body", "details" ON "client_notes" FOR EACH ROW EXECUTE FUNCTION "client_notes_redact"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "client_notes_scrub_sensitive" ON "client_notes";--> statement-breakpoint
CREATE TRIGGER "client_notes_scrub_sensitive" BEFORE INSERT OR UPDATE OF "body", "details" ON "client_notes" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('body', 'details');--> statement-breakpoint
DROP TRIGGER IF EXISTS "customers_redact_notes" ON "customers";--> statement-breakpoint
CREATE TRIGGER "customers_redact_notes" BEFORE INSERT OR UPDATE OF "notes" ON "customers" FOR EACH ROW EXECUTE FUNCTION "customers_redact_notes"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "customers_record_note" ON "customers";--> statement-breakpoint
CREATE TRIGGER "customers_record_note" AFTER INSERT OR UPDATE OF "notes" ON "customers" FOR EACH ROW EXECUTE FUNCTION "client_notes_from_customer"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "appointments_squire_note" ON "appointments";--> statement-breakpoint
CREATE TRIGGER "appointments_squire_note" AFTER INSERT OR UPDATE OF "notes", "customer_id" ON "appointments" FOR EACH ROW EXECUTE FUNCTION "client_notes_from_import"();--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["notes.view", "notes.write"]'::jsonb WHERE "key" IN ('brand_admin', 'regional_manager', 'shop_manager', 'front_desk', 'shop_login', 'barber') AND NOT ("permissions" ? 'notes.view');--> statement-breakpoint
-- Custom roles saw the profile's notes field before; they keep seeing and writing notes.
UPDATE "roles" SET "permissions" = "permissions" || '["notes.view", "notes.write"]'::jsonb WHERE "key" IS NULL AND NOT ("permissions" ? 'notes.view');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["notes.edit_any"]'::jsonb WHERE "key" IN ('brand_admin', 'regional_manager', 'shop_manager') AND NOT ("permissions" ? 'notes.edit_any');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["notes.private"]'::jsonb WHERE "key" IN ('brand_admin', 'regional_manager', 'shop_manager') AND NOT ("permissions" ? 'notes.private');
