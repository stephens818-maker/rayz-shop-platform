-- A location's public profile, edited in the admin settings and the Add Location wizard, and served to the booking site, the embeddable widget and the mobile app: a second address line, where the map pin came from (an address lookup, the ZIP centre, or placed by hand), its Google Place ID, social links, parking and directions notes, amenities, the sales-tax jurisdiction (kept for the books, never public), and photos plus an uploaded logo. Hours, holiday closures, time zone, phone, the text-enabled (Twilio) number, email and the Google review link already have homes. No API keys are kept here: the address lookup reads its key from the environment. Additive only.
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "address2" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "google_place_id" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "social" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "directions" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "amenities" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "tax_jurisdiction" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "geocode_source" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "geocoded_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "shops" ADD CONSTRAINT "shops_google_place_id" CHECK ("google_place_id" IS NULL OR "google_place_id" ~ '^[A-Za-z0-9_-]{16,512}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "shops" ADD CONSTRAINT "shops_directions" CHECK ("directions" IS NULL OR char_length("directions") <= 500);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "shops" ADD CONSTRAINT "shops_address2" CHECK (char_length("address2") <= 80);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "shops" ADD CONSTRAINT "shops_geocode_source" CHECK ("geocode_source" IS NULL OR "geocode_source" IN ('google', 'census', 'zip', 'manual'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "shops" ADD CONSTRAINT "shops_profile_shapes" CHECK (jsonb_typeof("social") = 'object' AND jsonb_typeof("amenities") = 'array' AND jsonb_typeof("tax_jurisdiction") = 'object');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- Pins already set by hand (the time clock's geofence) count as placed by hand.
UPDATE "shops" SET "geocode_source" = 'manual' WHERE "latitude" IS NOT NULL AND "longitude" IS NOT NULL AND "geocode_source" IS NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
	"kind" text DEFAULT 'photo' NOT NULL,
	"data_url" text NOT NULL,
	"alt" text,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"created_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_photos_kind" CHECK ("kind" IN ('photo', 'logo')),
	CONSTRAINT "shop_photos_image" CHECK ("data_url" ~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$' AND char_length("data_url") <= 1500000),
	CONSTRAINT "shop_photos_alt" CHECK ("alt" IS NULL OR char_length("alt") <= 140)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_photos_shop_idx" ON "shop_photos" USING btree ("shop_id", "kind", "sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_photos_one_logo" ON "shop_photos" USING btree ("shop_id") WHERE "kind" = 'logo';
