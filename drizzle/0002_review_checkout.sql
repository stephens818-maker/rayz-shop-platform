ALTER TABLE "gift_cards" ADD COLUMN "sale_item_id" uuid;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "source" text DEFAULT 'staff' NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "items" jsonb;--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "catalog_price_cents" integer;--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "override_reason" text;--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "refunded_qty" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_stripe_pi_uq" ON "payments" USING btree ("stripe_payment_intent_id");--> statement-breakpoint
UPDATE "gift_cards" g SET "sale_item_id" = m.item_id
FROM (
  SELECT DISTINCT ON (l.gift_card_id) l.gift_card_id, si.id AS item_id
  FROM "gift_card_ledger" l
  JOIN "sale_items" si ON si.sale_id = l.sale_id AND si.kind = 'gift_card'
  JOIN "gift_cards" gc ON gc.id = l.gift_card_id AND gc.initial_cents = si.unit_price_cents
  WHERE l.kind = 'issue'
  ORDER BY l.gift_card_id, si.id
) m
WHERE g.id = m.gift_card_id AND g.sale_item_id IS NULL;
