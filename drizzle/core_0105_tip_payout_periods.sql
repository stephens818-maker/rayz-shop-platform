-- Direct tip payouts to employees (Charles, 2026-10-27) with the W-2 safeguards: each payout records the pay period its tips belong to (tip_payout_periods, one row per payout per period, by the business date of every entry on the shop's pay group calendar), so payroll reconciles the iSolved export to the cent per employee and period; and each employee's Stripe account keeps who pays its fees (no 1099-K unless the account pays) and when it was tagged as a W-2 employee's.
CREATE TABLE "tip_payout_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payout_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"method" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"tips_cents" integer NOT NULL,
	"adjust_cents" integer DEFAULT 0 NOT NULL,
	"fee_cents" integer DEFAULT 0 NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tip_payout_periods_method" CHECK ("tip_payout_periods"."method" in ('cash', 'stripe', 'payroll', 'prior')),
	CONSTRAINT "tip_payout_periods_dates" CHECK ("tip_payout_periods"."period_end" >= "tip_payout_periods"."period_start")
);--> statement-breakpoint
ALTER TABLE "tip_payout_periods" ADD CONSTRAINT "tip_payout_periods_payout_id_tip_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."tip_payouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_payout_periods" ADD CONSTRAINT "tip_payout_periods_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_payout_periods" ADD CONSTRAINT "tip_payout_periods_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tip_payout_periods_uq" ON "tip_payout_periods" USING btree ("payout_id","period_start");--> statement-breakpoint
CREATE INDEX "tip_payout_periods_period_idx" ON "tip_payout_periods" USING btree ("shop_id","period_start","staff_id");--> statement-breakpoint
ALTER TABLE "staff_payout_accounts" ADD COLUMN "fees_payer" text;--> statement-breakpoint
ALTER TABLE "staff_payout_accounts" ADD COLUMN "w2_tagged_at" timestamp with time zone;--> statement-breakpoint
-- Every payout already approved, sent or paid gets its periods, on the shop's pay group calendar (the brand's, 14 days from 2026-10-18, where the shop has none yet).
INSERT INTO "tip_payout_periods" ("payout_id", "shop_id", "staff_id", "method", "period_start", "period_end", "tips_cents", "adjust_cents", "fee_cents")
SELECT p.id, p.shop_id, p.staff_id, p.method, x.ps, x.ps + (c.pd - 1),
	sum(case when l.kind <> 'adjust' then l.amount_cents else 0 end)::int,
	sum(case when l.kind = 'adjust' then l.amount_cents else 0 end)::int,
	sum(case when p.fee_cents <> 0 and l.kind <> 'adjust' then l.fee_cents else 0 end)::int
FROM "tip_payouts" p
JOIN "tip_ledger" l ON l.payout_id = p.id
LEFT JOIN "pay_groups" g ON g.shop_id = p.shop_id
CROSS JOIN LATERAL (SELECT coalesce(g.anchor_start, date '2026-10-18') a, coalesce(g.period_days, 14) pd) c
CROSS JOIN LATERAL (SELECT c.a + (floor((l.business_date - c.a)::numeric / c.pd)::int * c.pd) ps) x
WHERE p.status in ('approved', 'processing', 'paid')
GROUP BY p.id, p.shop_id, p.staff_id, p.method, x.ps, c.pd
ON CONFLICT DO NOTHING;
