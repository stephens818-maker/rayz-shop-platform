-- Per-location banking: each shop settles card money to the brand's own Stripe account, to its own connected account, or takes no cards.
ALTER TABLE "shops" ADD COLUMN "payments_mode" text DEFAULT 'connected' NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_payments_mode" CHECK ("payments_mode" IN ('brand', 'connected', 'cash_only'));--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "statement_descriptor" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "receipt" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "stripe_terminal_location_id" text;--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_stripe_terminal_location_id_unique" UNIQUE ("stripe_terminal_location_id");--> statement-breakpoint
ALTER TABLE "shop_payment_accounts" ADD COLUMN "payout_schedule" jsonb;--> statement-breakpoint
-- Brand-account payouts cover every shop on the brand account, so they belong to no one shop.
ALTER TABLE "shop_payouts" ALTER COLUMN "shop_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shop_payouts" ADD CONSTRAINT "shop_payouts_owner" CHECK ("shop_id" IS NOT NULL OR "stripe_account_id" = 'platform');--> statement-breakpoint
ALTER TABLE "shop_payouts" ADD COLUMN "gross_cents" integer;--> statement-breakpoint
ALTER TABLE "shop_payouts" ADD COLUMN "fee_cents" integer;--> statement-breakpoint
ALTER TABLE "shop_payouts" ADD COLUMN "refund_cents" integer;--> statement-breakpoint
ALTER TABLE "shop_payouts" ADD COLUMN "item_count" integer;--> statement-breakpoint
ALTER TABLE "terminal_readers" ADD COLUMN "device_type" text;--> statement-breakpoint
ALTER TABLE "terminal_readers" ADD COLUMN "stripe_location_id" text;--> statement-breakpoint
ALTER TABLE "terminal_readers" ADD COLUMN "registered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "settlement" text;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_settlement" CHECK ("settlement" IS NULL OR "settlement" IN ('platform', 'connected'));--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "terminal_reader_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_terminal_reader_id_terminal_readers_id_fk" FOREIGN KEY ("terminal_reader_id") REFERENCES "public"."terminal_readers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
UPDATE "payments" SET "settlement" = 'connected' WHERE "stripe_account_id" IS NOT NULL;--> statement-breakpoint
UPDATE "terminal_readers" SET "registered_at" = "created_at" WHERE "stripe_reader_id" IS NOT NULL;
