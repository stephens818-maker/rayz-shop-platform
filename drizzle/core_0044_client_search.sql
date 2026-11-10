-- Client search and filters: a client number, nickname, how they found us and who referred them, a photo, the fuzzy-search name (first, last and nickname, any order), the town and zip read from the address, and SHA-256 lookup hashes of each contact detail so staff who don't see a detail can still find a client by the exact value they type. Saved searches, "not the same person" for the duplicates tool, zip points for distance filters, and the permissions for advanced filters and saved searches. Additive only.
ALTER TABLE "customers" ADD COLUMN "number" integer GENERATED ALWAYS AS IDENTITY (START WITH 10001);--> statement-breakpoint
CREATE UNIQUE INDEX "customers_number_uq" ON "customers" ("number");--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "nickname" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "referred_by_id" uuid REFERENCES "customers"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_not_self_referred" CHECK ("referred_by_id" is null or "referred_by_id" <> "id");--> statement-breakpoint
CREATE INDEX "customers_referred_by_idx" ON "customers" ("referred_by_id") WHERE "referred_by_id" is not null;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "search_name" text GENERATED ALWAYS AS (lower("first_name" || ' ' || coalesce("last_name", '') || ' ' || coalesce("nickname", ''))) STORED;--> statement-breakpoint
CREATE INDEX "customers_search_name_trgm" ON "customers" USING gin ("search_name" gin_trgm_ops);--> statement-breakpoint
-- "1701 2nd Street, Moline, IL 61265": the zip at the end, and the town before the last comma.
ALTER TABLE "customers" ADD COLUMN "address_zip" text GENERATED ALWAYS AS (substring("address" from '(\d{5})(?:-\d{4})?\s*$')) STORED;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "address_city" text GENERATED ALWAYS AS (nullif(btrim(lower(substring("address" from '([^,]+),[^,]*$'))), '')) STORED;--> statement-breakpoint
CREATE INDEX "customers_address_zip_idx" ON "customers" ("address_zip") WHERE "address_zip" is not null;--> statement-breakpoint
CREATE INDEX "customers_address_city_idx" ON "customers" ("address_city") WHERE "address_city" is not null;--> statement-breakpoint
CREATE INDEX "customers_notes_trgm" ON "customers" USING gin ((lower("notes")) gin_trgm_ops) WHERE "notes" is not null;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "phone_hash" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "email_hash" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "birthday_hash" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "address_hash" text;--> statement-breakpoint
-- The same normalization as src/domain/client-search.ts: E.164 phones, lowercased emails, ISO birthdays, and addresses lowercased with every run of other characters as one space.
CREATE FUNCTION "customers_lookup_hashes"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.phone_hash := CASE WHEN NEW.phone IS NULL OR NEW.phone = '' THEN NULL ELSE encode(sha256(convert_to(NEW.phone, 'UTF8')), 'hex') END;
  NEW.email_hash := CASE WHEN NEW.email IS NULL OR btrim(NEW.email) = '' THEN NULL ELSE encode(sha256(convert_to(lower(btrim(NEW.email)), 'UTF8')), 'hex') END;
  NEW.birthday_hash := CASE WHEN NEW.birthday IS NULL THEN NULL ELSE encode(sha256(convert_to(to_char(NEW.birthday, 'YYYY-MM-DD'), 'UTF8')), 'hex') END;
  NEW.address_hash := CASE WHEN NEW.address IS NULL OR btrim(regexp_replace(lower(NEW.address), '[^a-z0-9]+', ' ', 'g')) = '' THEN NULL
    ELSE encode(sha256(convert_to(btrim(regexp_replace(lower(NEW.address), '[^a-z0-9]+', ' ', 'g')), 'UTF8')), 'hex') END;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "customers_lookup_hashes" BEFORE INSERT OR UPDATE OF "phone", "email", "birthday", "address", "phone_hash", "email_hash", "birthday_hash", "address_hash" ON "customers" FOR EACH ROW EXECUTE FUNCTION "customers_lookup_hashes"();--> statement-breakpoint
UPDATE "customers" SET "phone" = "phone";--> statement-breakpoint
CREATE INDEX "customers_phone_hash_idx" ON "customers" ("phone_hash") WHERE "phone_hash" is not null;--> statement-breakpoint
CREATE INDEX "customers_email_hash_idx" ON "customers" ("email_hash") WHERE "email_hash" is not null;--> statement-breakpoint
CREATE INDEX "customers_birthday_hash_idx" ON "customers" ("birthday_hash") WHERE "birthday_hash" is not null;--> statement-breakpoint
CREATE INDEX "customers_address_hash_idx" ON "customers" ("address_hash") WHERE "address_hash" is not null;--> statement-breakpoint
CREATE INDEX "customer_tags_tag_trgm" ON "customer_tags" USING gin ((lower("tag")) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "gift_cards_customer_idx" ON "gift_cards" ("customer_id") WHERE "customer_id" is not null;--> statement-breakpoint
CREATE TABLE "client_photos" (
	"customer_id" uuid PRIMARY KEY NOT NULL REFERENCES "customers"("id") ON DELETE cascade,
	"data_url" text NOT NULL,
	"updated_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_photos_image_chk" CHECK ("data_url" ~ '^data:image/(jpeg|png|webp);base64,' and length("data_url") <= 400000)
);--> statement-breakpoint
CREATE TABLE "saved_client_searches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"owner_id" uuid NOT NULL REFERENCES "staff"("id") ON DELETE cascade,
	"visibility" text DEFAULT 'private' NOT NULL,
	"shop_id" uuid REFERENCES "shops"("id") ON DELETE cascade,
	"term" text DEFAULT '' NOT NULL,
	"filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_client_searches_visibility_chk" CHECK ("visibility" in ('private', 'shop', 'brand') and ("visibility" = 'shop') = ("shop_id" is not null))
);--> statement-breakpoint
CREATE INDEX "saved_client_searches_owner_idx" ON "saved_client_searches" ("owner_id");--> statement-breakpoint
CREATE TABLE "customer_duplicate_dismissals" (
	"a_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE cascade,
	"b_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE cascade,
	"dismissed_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_duplicate_dismissals_pk" PRIMARY KEY ("a_id", "b_id"),
	CONSTRAINT "customer_duplicate_dismissals_order_chk" CHECK ("a_id" < "b_id")
);--> statement-breakpoint
CREATE TABLE "zip_points" (
	"zip" text PRIMARY KEY NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	CONSTRAINT "zip_points_zip_chk" CHECK ("zip" ~ '^\d{5}$')
);--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["clients.filters","clients.saved_searches"]'::jsonb WHERE "key" IN ('brand_admin', 'regional_manager', 'shop_manager', 'front_desk') AND NOT ("permissions" ? 'clients.filters');
