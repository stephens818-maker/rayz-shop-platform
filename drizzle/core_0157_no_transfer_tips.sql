-- Simulator tickets (and any other tip reversal with no Stripe tip transfer) such as Jessica's
-- $7.60 on ticket 14858. core_0156 only restored a reversal that had a tip transfer. Here the shop
-- absorbs the tip and the barber keeps it. A void is left reversed. Safe to run again.
-- Also: every shop still stored on cash tips moves to Stripe, unless it pays tips through payroll.
-- Iowa shops charged 7% get a receipt split of 6% state and 1% city when that split was never saved.
DO $$
DECLARE
  r record;
  still uuid;
  how text;
BEGIN
  FOR r IN
    SELECT l.id AS ledger_id, l.shop_id, l.staff_id, l.sale_id, l.payment_id, l.refund_id,
           l.amount_cents, l.business_date, l.payout_id, s.number AS ticket
    FROM tip_ledger l
    JOIN refunds rfd ON rfd.id = l.refund_id AND rfd.kind <> 'void'
    LEFT JOIN sales s ON s.id = l.sale_id
    WHERE l.kind = 'refund' AND l.amount_cents < 0
      AND NOT EXISTS (
        SELECT 1 FROM payment_transfers pt
        WHERE pt.kind = 'tip' AND pt.payment_id = l.payment_id AND pt.staff_id = l.staff_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM audit_log a
        WHERE a.action = 'tips.clawback_restored' AND a.entity = 'refund'
          AND a.entity_id = l.refund_id::text || ':' || l.staff_id::text
      )
  LOOP
    INSERT INTO tip_absorptions (shop_id, staff_id, sale_id, payment_id, refund_id, kind, amount_cents, business_date)
    VALUES (r.shop_id, r.staff_id, r.sale_id, r.payment_id, r.refund_id, 'after_payout', -r.amount_cents, r.business_date)
    ON CONFLICT (refund_id, staff_id) WHERE refund_id IS NOT NULL DO NOTHING;

    UPDATE tip_ledger l
    SET payout_id = NULL
    WHERE l.id = r.ledger_id AND l.payout_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM tip_payouts p
        WHERE p.id = l.payout_id AND p.status IN ('approved', 'processing', 'paid')
      );

    SELECT l.payout_id INTO still FROM tip_ledger l WHERE l.id = r.ledger_id;
    IF still IS NULL THEN
      DELETE FROM tip_ledger WHERE id = r.ledger_id;
      how := 'no_transfer';
    ELSE
      INSERT INTO tip_ledger (shop_id, staff_id, sale_id, payment_id, kind, method, amount_cents, fee_cents, business_date, reason)
      SELECT r.shop_id, r.staff_id, r.sale_id, r.payment_id, 'adjust', 'adjust', -r.amount_cents, 0, r.business_date, 'core_0157:' || r.refund_id::text
      WHERE NOT EXISTS (
        SELECT 1 FROM tip_ledger x
        WHERE x.kind = 'adjust' AND x.staff_id = r.staff_id AND x.reason = 'core_0157:' || r.refund_id::text
      );
      how := 'no_transfer_adjusted';
    END IF;

    INSERT INTO audit_log (actor_label, shop_id, action, entity, entity_id, details)
    VALUES (
      'system', r.shop_id, 'tips.clawback_restored', 'refund', r.refund_id::text || ':' || r.staff_id::text,
      jsonb_build_object(
        'ticket', r.ticket, 'saleId', r.sale_id, 'refundId', r.refund_id, 'staffId', r.staff_id,
        'cents', -r.amount_cents, 'how', how
      )
    );
  END LOOP;
END $$;
--> statement-breakpoint
UPDATE shops
SET tip_payouts = jsonb_set(coalesce(tip_payouts, '{}'::jsonb), '{defaultMethod}', '"stripe"'::jsonb)
WHERE coalesce(tip_payouts->>'defaultMethod', '') = 'cash'
  AND coalesce(tip_payouts->>'schedule', '') <> 'payroll';
--> statement-breakpoint
UPDATE shops
SET receipt = jsonb_set(
  coalesce(receipt, '{}'::jsonb),
  '{taxDisplay}',
  coalesce(receipt->'taxDisplay', '{}'::jsonb) || jsonb_build_object('stateRate', 0.06, 'cityRate', 0.01),
  true
)
WHERE upper(state) = 'IA'
  AND service_tax_rate = 0.07
  AND btrim(coalesce(city, '')) <> ''
  AND coalesce(receipt->'taxDisplay'->>'stateRate', '') = ''
  AND coalesce(receipt->'taxDisplay'->>'cityRate', '') = '';
