-- Client retention badges: the brand's settings (which are on, thresholds, which roles see which), custom badges built from a client filter, and each client's badges cached nightly and after checkout. Additive only.
ALTER TABLE "brand_settings" ADD COLUMN IF NOT EXISTS "badges" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "custom_badges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"tooltip" text DEFAULT '' NOT NULL,
	"icon" text DEFAULT 'tag' NOT NULL,
	"tone" text DEFAULT 'blue' NOT NULL,
	"filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_badges_tone" CHECK ("tone" in ('gray', 'green', 'blue', 'amber', 'red', 'violet'))
);--> statement-breakpoint
CREATE TRIGGER "custom_badges_scrub_sensitive" BEFORE INSERT OR UPDATE OF "label", "tooltip" ON "custom_badges" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('label', 'tooltip');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "client_badges" (
	"customer_id" uuid PRIMARY KEY NOT NULL REFERENCES "customers"("id") ON DELETE cascade,
	"keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"badges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hash" text NOT NULL DEFAULT '',
	"computed_on" date NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_badges_keys_idx" ON "client_badges" USING gin ("keys");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_badges_computed_idx" ON "client_badges" USING btree ("computed_on");--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["badges.settings"]'::jsonb WHERE "key" = 'brand_admin' AND NOT ("permissions" ? 'badges.settings');
