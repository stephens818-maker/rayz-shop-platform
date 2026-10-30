-- I10 follow-up (claude bot's review of mobile PR #6): payment_transfers replaces payments.stripe_transfer_id. Every card charge from before separate charges (charge_type destination) gets its shop row here: sent, with the transfer Stripe made with the charge (the simulator's get a sim_ id), the charge less the processing fee, tip included (those tips were the shop's). Its refunds and disputes are then taken back from that row like any other shop transfer, after a plain refund: reverse_transfer is never used again. Refunds already made reversed the transfer with the refund itself (reverse_transfer, in proportion), so each is recorded as an in_refund reversal and is never taken back twice. payments.stripe_transfer_id stays for history; nothing reads or writes it. Additive only.
ALTER TABLE "payment_transfer_reversals" DROP CONSTRAINT IF EXISTS "payment_transfer_reversals_status";--> statement-breakpoint
ALTER TABLE "payment_transfer_reversals" ADD CONSTRAINT "payment_transfer_reversals_status" CHECK ("status" IN ('pending', 'sent', 'netted', 'failed', 'none', 'in_refund'));--> statement-breakpoint
INSERT INTO "payment_transfers" ("payment_id", "sale_id", "shop_id", "kind", "destination_account", "amount_cents", "transfer_group", "status", "stripe_transfer_id", "attempts", "created_at", "sent_at")
SELECT p."id", p."sale_id", p."shop_id", 'shop', p."stripe_account_id", p."amount_cents" - p."application_fee_cents", coalesce(p."transfer_group", 'sale_' || p."sale_id"), 'sent',
	coalesce(p."stripe_transfer_id", 'sim_tr_legacy_' || replace(p."id"::text, '-', '')), 1, p."created_at", p."created_at"
FROM "payments" p
WHERE p."charge_type" = 'destination' AND p."method" = 'card' AND p."stripe_account_id" IS NOT NULL AND p."amount_cents" > p."application_fee_cents"
	AND (p."stripe_transfer_id" IS NOT NULL OR p."stripe_payment_intent_id" LIKE 'sim\_%')
	AND NOT EXISTS (SELECT 1 FROM "payment_transfers" t WHERE t."payment_id" = p."id" AND t."kind" = 'shop');--> statement-breakpoint
INSERT INTO "payment_transfer_reversals" ("transfer_id", "payment_id", "kind", "refund_id", "amount_cents", "status", "attempts", "created_at", "sent_at")
SELECT t."id", p."id", 'refund', r."id", least(t."amount_cents", round(r."amount_cents"::numeric * t."amount_cents" / p."amount_cents")::int), 'in_refund', 0, r."created_at", r."created_at"
FROM "refunds" r
JOIN "payments" p ON p."id" = r."payment_id"
JOIN "payment_transfers" t ON t."payment_id" = p."id" AND t."kind" = 'shop'
WHERE p."charge_type" = 'destination' AND r."amount_cents" > 0
	AND NOT EXISTS (SELECT 1 FROM "payment_transfer_reversals" x WHERE x."refund_id" = r."id");--> statement-breakpoint
UPDATE "payment_transfers" t SET "reversed_cents" = least(t."amount_cents", x."cents"), "updated_at" = now()
FROM (SELECT "transfer_id", sum("amount_cents")::int "cents" FROM "payment_transfer_reversals" WHERE "status" = 'in_refund' GROUP BY "transfer_id") x
WHERE x."transfer_id" = t."id" AND t."kind" = 'shop' AND t."reversed_cents" = 0;
