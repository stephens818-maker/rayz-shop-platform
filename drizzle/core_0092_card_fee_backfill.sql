-- Card payments from before the ticket kept a pricing snapshot came through core_0091 with a 0 rate and no basis.
-- What was charged is still there: the basis is the charge less the surcharge (and the tip, unless the surcharge was on it).
UPDATE "payments" SET
  "fee_basis_cents" = "amount_cents" - "card_fee_cents" - CASE WHEN "fee_basis" = 'charge_including_tip' THEN 0 ELSE "tip_cents" END
WHERE "method" = 'card' AND "card_fee_cents" > 0 AND "fee_basis_cents" IS NULL
  AND "amount_cents" - "card_fee_cents" - CASE WHEN "fee_basis" = 'charge_including_tip' THEN 0 ELSE "tip_cents" END > 0;--> statement-breakpoint
UPDATE "payments" SET "fee_rate" = least(round("card_fee_cents"::numeric / "fee_basis_cents", 5), 0.03)
WHERE "method" = 'card' AND "card_fee_cents" > 0 AND "fee_basis_cents" > 0 AND coalesce("fee_rate", 0) = 0;
