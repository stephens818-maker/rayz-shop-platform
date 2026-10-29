-- Credit card fee and sales tax are entered per shop. No built-in rate and no 3% cap.
-- Existing rows keep the rate they already have. A new shop's card_fee_rate is null until someone enters one.
-- 100% is only a typo guard, matching the app. It is not a card-network ceiling.
ALTER TABLE "shops" DROP CONSTRAINT IF EXISTS "shops_card_fee_cap";--> statement-breakpoint
ALTER TABLE "shops" ALTER COLUMN "card_fee_rate" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "shops" ALTER COLUMN "card_fee_rate" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_card_fee_rate_sane" CHECK ("card_fee_rate" IS NULL OR ("card_fee_rate" >= 0 AND "card_fee_rate" <= 1));--> statement-breakpoint

CREATE TABLE "card_fee_rates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "shop_id" uuid REFERENCES "shops"("id") ON DELETE CASCADE,
  "rate" numeric(6, 5) NOT NULL,
  "label" text,
  "follows_brand" boolean DEFAULT false NOT NULL,
  "effective_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "card_fee_rates_shop_at_idx" ON "card_fee_rates" ("shop_id", "effective_at");--> statement-breakpoint

CREATE TABLE "sales_tax_rates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE CASCADE,
  "service_rate" numeric(7, 5) NOT NULL,
  "product_rate" numeric(7, 5) NOT NULL,
  "effective_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "sales_tax_rates_shop_at_idx" ON "sales_tax_rates" ("shop_id", "effective_at");
