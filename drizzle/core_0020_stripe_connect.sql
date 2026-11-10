CREATE TABLE "owner_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"kind" text DEFAULT 'brand' NOT NULL,
	"contact_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_payment_accounts" (
	"shop_id" uuid PRIMARY KEY NOT NULL,
	"stripe_account_id" text NOT NULL,
	"simulated" boolean DEFAULT false NOT NULL,
	"charges_enabled" boolean DEFAULT false NOT NULL,
	"payouts_enabled" boolean DEFAULT false NOT NULL,
	"details_submitted" boolean DEFAULT false NOT NULL,
	"requirements_due" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"disabled_reason" text,
	"deauthorized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_payment_accounts_stripe_account_id_unique" UNIQUE("stripe_account_id")
);
--> statement-breakpoint
CREATE TABLE "shop_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"stripe_account_id" text NOT NULL,
	"stripe_payout_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" text NOT NULL,
	"arrival_date" date NOT NULL,
	"failure_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_payouts_stripe_payout_id_unique" UNIQUE("stripe_payout_id")
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "stripe_account_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "application_fee_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "processor_fee_cents" integer;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "stripe_charge_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "stripe_transfer_id" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "owner_entity_id" uuid;--> statement-breakpoint
ALTER TABLE "shop_payment_accounts" ADD CONSTRAINT "shop_payment_accounts_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_payouts" ADD CONSTRAINT "shop_payouts_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shop_payouts_shop_arrival_idx" ON "shop_payouts" USING btree ("shop_id","arrival_date");--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_owner_entity_id_owner_entities_id_fk" FOREIGN KEY ("owner_entity_id") REFERENCES "public"."owner_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_account_idx" ON "payments" USING btree ("stripe_account_id");--> statement-breakpoint
-- Every existing shop belongs to the brand until a franchisee is set up.
INSERT INTO "owner_entities" ("name", "kind") SELECT coalesce((SELECT "name" FROM "brand_settings" WHERE "id" = 1), 'Ray''z Barber Shop'), 'brand' WHERE EXISTS (SELECT 1 FROM "shops") AND NOT EXISTS (SELECT 1 FROM "owner_entities");--> statement-breakpoint
UPDATE "shops" SET "owner_entity_id" = (SELECT "id" FROM "owner_entities" ORDER BY "created_at" LIMIT 1) WHERE "owner_entity_id" IS NULL;--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["payments.accounts"]'::jsonb WHERE "key" = 'brand_admin' AND NOT ("permissions" ? 'payments.accounts');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["report.shop_accounts.view","report.shop_accounts.export"]'::jsonb WHERE "key" IN ('brand_admin', 'regional_manager', 'shop_manager') AND NOT ("permissions" ? 'report.shop_accounts.view');
