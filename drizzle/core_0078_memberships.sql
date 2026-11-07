-- Memberships: brand plans (e.g. unlimited buzz cuts for a monthly price) billed through Stripe Billing, members, their invoices, and visits used at checkout.
ALTER TABLE "brand_settings" ADD COLUMN "memberships_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE "membership_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price_cents" integer NOT NULL,
	"service_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"visits_per_period" integer,
	"product_discount_pct" integer DEFAULT 0 NOT NULL,
	"shop_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"stripe_product_id" text,
	"stripe_price_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_plans_name" CHECK (length(trim("name")) BETWEEN 1 AND 60),
	CONSTRAINT "membership_plans_price" CHECK ("price_cents" BETWEEN 100 AND 100000),
	CONSTRAINT "membership_plans_visits" CHECK ("visits_per_period" IS NULL OR "visits_per_period" BETWEEN 1 AND 31),
	CONSTRAINT "membership_plans_product_pct" CHECK ("product_discount_pct" BETWEEN 0 AND 50)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "membership_plans_name_uq" ON "membership_plans" (lower("name"));
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL REFERENCES "membership_plans"("id"),
	"customer_id" uuid NOT NULL REFERENCES "customers"("id"),
	"home_shop_id" uuid NOT NULL REFERENCES "shops"("id"),
	"status" text DEFAULT 'active' NOT NULL,
	"billing" text DEFAULT 'simulated' NOT NULL,
	"price_cents" integer NOT NULL,
	"stripe_subscription_id" text UNIQUE,
	"stripe_checkout_url" text,
	"current_period_start" date NOT NULL,
	"current_period_end" date NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"canceled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_by" uuid REFERENCES "staff"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_status" CHECK ("status" IN ('incomplete', 'active', 'past_due', 'canceled')),
	CONSTRAINT "memberships_billing" CHECK ("billing" IN ('simulated', 'stripe')),
	CONSTRAINT "memberships_period" CHECK ("current_period_end" > "current_period_start")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_live_uq" ON "memberships" ("customer_id", "plan_id") WHERE "status" <> 'canceled';
--> statement-breakpoint
CREATE INDEX "memberships_customer_idx" ON "memberships" ("customer_id");
--> statement-breakpoint
CREATE INDEX "memberships_shop_idx" ON "memberships" ("home_shop_id", "status");
--> statement-breakpoint
CREATE TRIGGER "memberships_scrub_sensitive" BEFORE INSERT OR UPDATE OF "cancel_reason" ON "memberships" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('cancel_reason');
--> statement-breakpoint
CREATE TABLE "membership_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"membership_id" uuid NOT NULL REFERENCES "memberships"("id") ON DELETE CASCADE,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" text NOT NULL,
	"stripe_invoice_id" text UNIQUE,
	"failure_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_invoices_status" CHECK ("status" IN ('paid', 'failed')),
	CONSTRAINT "membership_invoices_period_uq" UNIQUE ("membership_id", "period_start", "status")
);
--> statement-breakpoint
CREATE TRIGGER "membership_invoices_scrub_sensitive" BEFORE INSERT OR UPDATE OF "failure_message" ON "membership_invoices" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('failure_message');
--> statement-breakpoint
CREATE TABLE "membership_uses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"membership_id" uuid NOT NULL REFERENCES "memberships"("id") ON DELETE CASCADE,
	"sale_id" uuid NOT NULL REFERENCES "sales"("id") ON DELETE CASCADE,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id"),
	"period_start" date NOT NULL,
	"visits" integer NOT NULL,
	"value_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_uses_sale_uq" UNIQUE ("membership_id", "sale_id"),
	CONSTRAINT "membership_uses_visits" CHECK ("visits" >= 0)
);
--> statement-breakpoint
CREATE INDEX "membership_uses_period_idx" ON "membership_uses" ("membership_id", "period_start");
