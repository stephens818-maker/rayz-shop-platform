-- Loyalty program settings mirrored from Squire at brand level: on or off, value based (every $300 of eligible spend earns $15) or transaction based (every N paid visits), whether product sales and tips count, and the assigned shops where clients earn and spend rewards. The current Squire setup is value based at $15 per $300 with products and tips off, at every location except Dubuque. Ledger rows now say what their progress counts (cents or visits), so a refund takes back what the ticket earned after the program changes type. Additive only.
ALTER TABLE "loyalty_ledger" ADD COLUMN IF NOT EXISTS "unit" text DEFAULT 'cents' NOT NULL;--> statement-breakpoint
ALTER TABLE "loyalty_ledger" DROP CONSTRAINT IF EXISTS "loyalty_ledger_unit_chk";--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_unit_chk" CHECK ("unit" in ('cents', 'visits'));--> statement-breakpoint
UPDATE "brand_settings" SET "loyalty" = jsonb_build_object('enabled', true, 'thresholdCents', 30000, 'rewardCents', 1500) || "loyalty" || jsonb_build_object(
	'type', 'value',
	'visitsGoal', 10,
	'minVisitCents', 0,
	'includeProducts', false,
	'includeTips', false,
	'shopIds', CASE WHEN EXISTS (SELECT 1 FROM "shops" WHERE "slug" = 'dubuque')
		THEN (SELECT coalesce(jsonb_agg("id"::text ORDER BY "name"), '[]'::jsonb) FROM "shops" WHERE "slug" <> 'dubuque' AND "status" <> 'archived')
		ELSE 'null'::jsonb END
) WHERE "id" = 1 AND NOT ("loyalty" ? 'type');
