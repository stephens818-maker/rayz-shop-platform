-- Checkout prompts, shown on the ticket before or while it's paid: a rebook prompt (the next visit with the same barber at the client's usual interval, or the service's, with 2-3 times to book in one tap, a whole family together on a family ticket, and an optional reason and reminder when the client says no) and a product prompt (what the barber used in the service, the brand's products for the services on the ticket, and what the client bought before, with stock). The brand turns each on or off and makes it skippable or required to answer; a location, a role or a barber can override that (most specific wins). Each prompt shown is one row with what was suggested and how it was answered, for the report and the event log. Additive only.
ALTER TABLE "brand_settings" ADD COLUMN IF NOT EXISTS "checkout_prompts" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN IF NOT EXISTS "rebook_days" integer;--> statement-breakpoint
ALTER TABLE "services" DROP CONSTRAINT IF EXISTS "services_rebook_days";--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_rebook_days" CHECK ("rebook_days" IS NULL OR "rebook_days" BETWEEN 7 AND 182);--> statement-breakpoint
-- One override: a prompt on or off at one location, for one role, or for one barber's tickets.
CREATE TABLE IF NOT EXISTS "checkout_prompt_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prompt" text NOT NULL,
	"shop_id" uuid REFERENCES "shops"("id") ON DELETE cascade,
	"role_id" uuid REFERENCES "roles"("id") ON DELETE cascade,
	"staff_id" uuid REFERENCES "staff"("id") ON DELETE cascade,
	"enabled" boolean NOT NULL,
	"updated_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "checkout_prompt_rules_prompt" CHECK ("prompt" IN ('rebook', 'product')),
	CONSTRAINT "checkout_prompt_rules_one_target" CHECK (num_nonnulls("shop_id", "role_id", "staff_id") = 1),
	CONSTRAINT "checkout_prompt_rules_uq" UNIQUE NULLS NOT DISTINCT ("prompt", "shop_id", "role_id", "staff_id")
);--> statement-breakpoint
-- The brand's products for a service, suggested at checkout whenever the service is on the ticket.
CREATE TABLE IF NOT EXISTS "service_product_suggestions" (
	"service_id" uuid NOT NULL REFERENCES "services"("id") ON DELETE cascade,
	"product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE cascade,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"created_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "service_product_suggestions_pk" PRIMARY KEY ("service_id", "product_id")
);--> statement-breakpoint
-- Products the barber used in the service, tagged on the ticket (not sold, so no stock moves).
CREATE TABLE IF NOT EXISTS "sale_used_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_id" uuid NOT NULL REFERENCES "sales"("id") ON DELETE cascade,
	"product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE cascade,
	"appointment_id" uuid REFERENCES "appointments"("id") ON DELETE set null,
	"tagged_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "sale_used_products_uq" UNIQUE ("sale_id", "product_id")
);--> statement-breakpoint
-- A reminder to book, asked for at checkout when the client didn't book there. It goes on the channels they agreed to for appointment messages, and not at all once they've booked.
CREATE TABLE IF NOT EXISTS "rebook_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE cascade,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
	"staff_id" uuid REFERENCES "staff"("id") ON DELETE set null,
	"service_id" uuid REFERENCES "services"("id") ON DELETE set null,
	"sale_id" uuid REFERENCES "sales"("id") ON DELETE set null,
	"run_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"outcome" text,
	"created_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "rebook_reminders_status" CHECK ("status" IN ('scheduled', 'sent', 'cancelled', 'skipped')),
	CONSTRAINT "rebook_reminders_outcome" CHECK ("outcome" IS NULL OR "outcome" IN ('booked', 'no_contact', 'cancelled', 'queued'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rebook_reminders_due_idx" ON "rebook_reminders" USING btree ("status", "run_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rebook_reminders_customer_idx" ON "rebook_reminders" USING btree ("customer_id");--> statement-breakpoint
-- One prompt shown on one ticket: what it suggested, and how staff answered it.
CREATE TABLE IF NOT EXISTS "checkout_prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_id" uuid NOT NULL REFERENCES "sales"("id") ON DELETE cascade,
	"prompt" text NOT NULL,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
	"staff_id" uuid REFERENCES "staff"("id") ON DELETE set null,
	"customer_id" uuid REFERENCES "customers"("id") ON DELETE set null,
	"required" boolean DEFAULT false NOT NULL,
	"suggested" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"shown_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"shown_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"outcome" text,
	"skipped" boolean DEFAULT false NOT NULL,
	"answered_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"answered_at" timestamp with time zone,
	"decline_reason" text,
	"booked_appointment_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"added_product_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"paid_product_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"paid_product_cents" integer DEFAULT 0 NOT NULL,
	"reminder_id" uuid REFERENCES "rebook_reminders"("id") ON DELETE set null,
	CONSTRAINT "checkout_prompts_prompt" CHECK ("prompt" IN ('rebook', 'product')),
	CONSTRAINT "checkout_prompts_outcome" CHECK ("outcome" IS NULL OR "outcome" IN ('accepted', 'declined')),
	CONSTRAINT "checkout_prompts_answered" CHECK (("outcome" IS NULL) = ("answered_at" IS NULL)),
	CONSTRAINT "checkout_prompts_reason" CHECK ("decline_reason" IS NULL OR char_length("decline_reason") <= 120),
	CONSTRAINT "checkout_prompts_uq" UNIQUE ("sale_id", "prompt")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "checkout_prompts_shop_idx" ON "checkout_prompts" USING btree ("shop_id", "shown_at");--> statement-breakpoint
DROP TRIGGER IF EXISTS "checkout_prompts_scrub_sensitive" ON "checkout_prompts";--> statement-breakpoint
CREATE TRIGGER "checkout_prompts_scrub_sensitive" BEFORE INSERT OR UPDATE OF "decline_reason" ON "checkout_prompts" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('decline_reason');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["report.checkout_prompts.view"]'::jsonb WHERE "permissions" ? 'report.kpis.view' AND NOT ("permissions" ? 'report.checkout_prompts.view');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["report.checkout_prompts.export"]'::jsonb WHERE "permissions" ? 'report.kpis.export' AND NOT ("permissions" ? 'report.checkout_prompts.export');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["checkout_prompts.manage"]'::jsonb WHERE "key" = 'brand_admin' AND NOT ("permissions" ? 'checkout_prompts.manage');
