-- Combined checkout for linked and family appointments. A barber (or the desk, for a whole booking group) sends a finished appointment to checkout: it joins the group's one open ticket and shows as ready in the checkout queue. Staff can combine any open tickets into one and split a person back off; a ticket combined away is voided and points at the ticket it went into. A ticket can be paid with several tenders, each with who paid it. Service lines done by someone other than the ticket's barber are credited to that barber in reports and payroll (sale_line_moves), as tips already are (tip_split_moves). Additive only.
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "checkout_ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "checkout_ready_by" uuid REFERENCES "staff"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "merged_into_sale_id" uuid REFERENCES "sales"("id") ON DELETE set null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_merged_into_idx" ON "sales" USING btree ("merged_into_sale_id") WHERE "merged_into_sale_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "payer_customer_id" uuid REFERENCES "customers"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "payer_label" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payments" ADD CONSTRAINT "payments_payer_label" CHECK ("payer_label" IS NULL OR char_length("payer_label") <= 40);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
ALTER TABLE "checkout_handoffs" ADD COLUMN IF NOT EXISTS "tip_by_staff" jsonb;--> statement-breakpoint
-- What reports that credit a ticket's services to its barber must move: each service or add-on line done by another barber, to that barber, less the same from the ticket's barber. Refunded lines move back the same way (their net from refunds.items; older refunds without it pro rata by quantity). Adds up to zero per line.
CREATE OR REPLACE VIEW "sale_line_moves" AS
WITH l AS (
	SELECT 'sale'::text AS source, i."id" AS source_id, s."id" AS sale_id, s."shop_id", s."business_date", NULL::text AS refund_kind,
		s."staff_id" AS ticket_staff_id, i."staff_id", i."gross_cents" AS gross_cents, i."discount_cents" AS discount_cents, i."net_cents" AS net_cents,
		CASE WHEN i."kind" = 'service' THEN 1 ELSE 0 END AS services
	FROM "sale_items" i JOIN "sales" s ON s."id" = i."sale_id"
	WHERE i."kind" IN ('service', 'addon') AND i."staff_id" IS NOT NULL AND s."staff_id" IS NOT NULL AND i."staff_id" <> s."staff_id"
	UNION ALL
	SELECT 'refund'::text, r."id", s."id", r."shop_id", r."business_date", r."kind", s."staff_id", i."staff_id", 0, 0,
		coalesce((e.value->>'netCents')::int, round(i."net_cents"::numeric * coalesce((e.value->>'qty')::int, 0) / nullif(i."qty", 0))::int, 0), 0
	FROM "refunds" r JOIN "sales" s ON s."id" = r."sale_id"
		CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r."items") = 'array' THEN r."items" ELSE '[]'::jsonb END) e
		JOIN "sale_items" i ON i."id"::text = e.value->>'saleItemId'
	WHERE i."kind" IN ('service', 'addon') AND i."staff_id" IS NOT NULL AND s."staff_id" IS NOT NULL AND i."staff_id" <> s."staff_id"
)
SELECT source, source_id, sale_id, shop_id, business_date, refund_kind, staff_id, gross_cents, discount_cents, net_cents, services FROM l
UNION ALL
SELECT source, source_id, sale_id, shop_id, business_date, refund_kind, ticket_staff_id, -gross_cents, -discount_cents, -net_cents, -services FROM l;
