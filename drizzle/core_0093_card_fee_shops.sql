-- Which shops use the brand's credit card surcharge (brand_settings.card_fee.appliesTo and shopIds, "all" when unset, so
-- nothing charges differently after this) and when each shop's surcharge last changed, from its audit trail where it has one.
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "card_fee_changed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "shops" s SET "card_fee_changed_at" = a."at"
FROM (SELECT "shop_id", max("at") "at" FROM "audit_log" WHERE "action" = 'card_fee.shop' AND "shop_id" IS NOT NULL GROUP BY "shop_id") a
WHERE a."shop_id" = s."id" AND s."card_fee_changed_at" IS NULL;
