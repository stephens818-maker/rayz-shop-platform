-- The credit card surcharge is off at the brand until the owner turns it on (after the card networks' 30 days' notice, the door and counter signs, a rate at most the card cost, and the CPA's word on Iowa sales tax).
-- A brand that never chose keeps it off explicitly; a brand that saved a choice keeps it. Each shop's mirrored card_fee_enabled follows, unless the shop turned it on itself.
UPDATE "shops" SET "card_fee_enabled" = false, "card_fee_changed_at" = now()
WHERE "card_fee_enabled" AND coalesce("card_fee_override"->>'enabled', '') <> 'true'
  AND NOT EXISTS (SELECT 1 FROM "brand_settings" b WHERE b."card_fee" ? 'enabled');--> statement-breakpoint
UPDATE "brand_settings" SET "card_fee" = "card_fee" || '{"enabled": false}'::jsonb WHERE NOT ("card_fee" ? 'enabled');--> statement-breakpoint
ALTER TABLE "shops" ALTER COLUMN "card_fee_enabled" SET DEFAULT false;
