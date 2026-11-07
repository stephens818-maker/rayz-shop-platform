-- Charles (2026-10-28): tips to barbers on or off, and who covers a refund past the sale's portion, are brand settings in the brand login, sent to all shops or the shops he picks (brand sync's shop picker), behind their own permission (tips.barber_payouts: Brand Owner and Brand Admin to start), every change audited. The refund rule moves from the brand's staff payouts settings to a column per shop. Additive only.
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "tip_refund_overflow" text DEFAULT 'platform' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "shops" ADD CONSTRAINT "shops_tip_refund_overflow" CHECK ("tip_refund_overflow" IN ('platform', 'shop'));
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
UPDATE "shops" SET "tip_refund_overflow" = 'shop' WHERE EXISTS (SELECT 1 FROM "brand_settings" WHERE "staff_payouts"->>'tipRefundOverflow' = 'shop');--> statement-breakpoint
INSERT INTO "brand_sync_values" ("key", "value") SELECT 'shop_setting:tip_refund_overflow', jsonb_build_object('bearer', 'shop') FROM "brand_settings" WHERE "staff_payouts"->>'tipRefundOverflow' = 'shop' LIMIT 1 ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
UPDATE "brand_settings" SET "staff_payouts" = "staff_payouts" - 'tipRefundOverflow' WHERE "staff_payouts" ? 'tipRefundOverflow';--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["tips.barber_payouts"]'::jsonb WHERE "key" = 'brand_admin' AND NOT ("permissions" ? 'tips.barber_payouts');
