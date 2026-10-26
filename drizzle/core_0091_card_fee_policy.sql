-- The credit card fee policy (extends C7). The brand sets it in brand_settings.card_fee; a shop can override parts of it in
-- shops.card_fee_override. Shops whose own fee settings differ from the old defaults (on, 3%, not on tips) keep them as an
-- override, so nothing charges differently after this. Each payment records how its surcharge was worked out, and any waiver.
-- Two permissions: the policy (brand-level roles) and waiving the fee at the register (every role that can change prices),
-- and the new card fee report for the roles that see the Shop P&L.
ALTER TABLE "brand_settings" ADD COLUMN IF NOT EXISTS "card_fee" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "card_fee_override" jsonb;--> statement-breakpoint
UPDATE "shops" SET "card_fee_override" = jsonb_strip_nulls(jsonb_build_object(
  'enabled', CASE WHEN NOT "card_fee_enabled" THEN false END,
  'rate', CASE WHEN "card_fee_rate" <> 0.03 THEN to_jsonb("card_fee_rate"::float8) END,
  'appliesToTip', CASE WHEN "card_fee_applies_to_tip" THEN true END))
WHERE "card_fee_override" IS NULL AND (NOT "card_fee_enabled" OR "card_fee_rate" <> 0.03 OR "card_fee_applies_to_tip");--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "card_fee_waived_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "fee_rate" numeric(6, 5);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "fee_flat_cents" integer;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "fee_basis" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "fee_basis_cents" integer;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "fee_reason" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "fee_channel" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "fee_waived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "fee_waived_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "fee_waived_by" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "fee_waived_reason" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payments" ADD CONSTRAINT "payments_fee_waived_by_staff_id_fk" FOREIGN KEY ("fee_waived_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_fee_basis";--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_fee_basis" CHECK ("fee_basis" IS NULL OR "fee_basis" IN ('charge_excluding_tip', 'charge_including_tip'));--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_fee_channel";--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_fee_channel" CHECK ("fee_channel" IS NULL OR "fee_channel" IN ('pos', 'app', 'deposit', 'card_on_file'));--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_fee_waived";--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_fee_waived" CHECK (NOT "fee_waived" OR ("method" = 'card' AND "card_fee_cents" = 0 AND "fee_waived_cents" > 0 AND "fee_waived_reason" IS NOT NULL));--> statement-breakpoint
-- Card payments from before: the rate and basis from the ticket's pricing snapshot, where it had a surcharge.
UPDATE "payments" p SET
  "fee_rate" = least(coalesce(nullif(s."pricing"->'cardFee'->>'rate', '')::numeric, 0), 0.03),
  "fee_flat_cents" = 0,
  "fee_basis" = CASE WHEN coalesce((s."pricing"->'cardFee'->>'appliesToTip')::boolean, false) THEN 'charge_including_tip' ELSE 'charge_excluding_tip' END,
  "fee_reason" = 'applies',
  "fee_channel" = 'pos'
FROM "sales" s
WHERE s."id" = p."sale_id" AND p."method" = 'card' AND p."card_fee_cents" > 0 AND p."fee_basis" IS NULL;--> statement-breakpoint
-- The amount it was on isn't stored for those, so it's worked back from the fee and the rate (to within a few cents).
UPDATE "payments" SET "fee_basis_cents" = round("card_fee_cents" / "fee_rate")::int
WHERE "method" = 'card' AND "card_fee_cents" > 0 AND "fee_rate" > 0 AND "fee_basis_cents" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_fee_waived_idx" ON "payments" ("shop_id", "business_date") WHERE "fee_waived";--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["settings.card_fee"]'::jsonb WHERE "key" IN ('brand_owner', 'brand_admin') AND NOT ("permissions" ? 'settings.card_fee');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["pos.waive_card_fee"]'::jsonb WHERE "permissions" ? 'pos.price_override' AND NOT ("permissions" ? 'pos.waive_card_fee');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["report.card_fees.view","report.card_fees.export"]'::jsonb WHERE "permissions" ? 'report.shop_accounts.view' AND NOT ("permissions" ? 'report.card_fees.view');
