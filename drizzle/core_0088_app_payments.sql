ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "stripe_customer_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customers_stripe_customer_idx" ON "customers" ("stripe_customer_id") WHERE "stripe_customer_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
	"stripe_payment_method_id" text NOT NULL,
	"brand" text NOT NULL,
	"last4" text NOT NULL,
	"funding" text NOT NULL,
	"exp_month" integer,
	"exp_year" integer,
	"wallet" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"detached_at" timestamp with time zone,
	CONSTRAINT "customer_cards_pm_unique" UNIQUE ("customer_id", "stripe_payment_method_id"),
	CONSTRAINT "customer_cards_funding" CHECK ("funding" in ('credit', 'debit', 'prepaid', 'unknown'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_cards_pm_idx" ON "customer_cards" ("stripe_payment_method_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_cards_one_default" ON "customer_cards" ("customer_id") WHERE "is_default" AND "detached_at" IS NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"account" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 1 NOT NULL,
	"outcome" text
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stripe_events_unprocessed_idx" ON "stripe_events" ("received_at") WHERE "processed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "checkout_handoffs" ADD COLUMN IF NOT EXISTS "via" text DEFAULT 'device' NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_handoffs" DROP CONSTRAINT IF EXISTS "checkout_handoffs_via";--> statement-breakpoint
ALTER TABLE "checkout_handoffs" ADD CONSTRAINT "checkout_handoffs_via" CHECK ("via" in ('device', 'app'));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"handoff_id" uuid NOT NULL REFERENCES "checkout_handoffs"("id") ON DELETE CASCADE,
	"sale_id" uuid NOT NULL REFERENCES "sales"("id") ON DELETE CASCADE,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id"),
	"payer_customer_id" uuid REFERENCES "customers"("id") ON DELETE SET NULL,
	"stripe_payment_intent_id" text,
	"payment_method_ref" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"card_fee_cents" integer DEFAULT 0 NOT NULL,
	"tip_cents" integer NOT NULL,
	"tip_choice" text,
	"tip_by_staff" jsonb,
	"card_funding" text,
	"wallet" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_payments_status" CHECK ("status" in ('pending', 'requires_action', 'succeeded', 'failed', 'refunded'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_payments_intent_idx" ON "app_payments" ("stripe_payment_intent_id") WHERE "stripe_payment_intent_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_payments_sale_idx" ON "app_payments" ("sale_id");
