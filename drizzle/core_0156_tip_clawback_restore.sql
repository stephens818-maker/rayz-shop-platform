-- Restore tip claw-backs written by the old refund logic (build bcc1b1e and the same shape), such as
-- Jessica's $7.60 on ticket 14858. A tip already transferred stays with the barber. The shop absorbs
-- the refund. A refund before the transfer was sent is left alone. A transfer Stripe reversed with
-- no tip refund is left alone. Safe to run again.
DO $$
DECLARE
  r record;
  still uuid;
  how text;
BEGIN
  FOR r IN
    SELECT l.id AS ledger_id, l.shop_id, l.staff_id, l.sale_id, l.payment_id, l.refund_id,
           l.amount_cents, l.business_date, l.payout_id, pt.id AS transfer_id, pt.stripe_reversed_at,
           s.number AS ticket
    FROM tip_ledger l
    JOIN payment_transfers pt
      ON pt.kind = 'tip' AND pt.payment_id = l.payment_id AND pt.staff_id = l.staff_id
    LEFT JOIN sales s ON s.id = l.sale_id
    WHERE l.kind = 'refund' AND l.amount_cents < 0 AND l.refund_id IS NOT NULL
      AND (pt.status IN ('pending', 'sent') OR pt.stripe_reversed_at IS NOT NULL)
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
      how := 'removed';
    ELSE
      INSERT INTO tip_ledger (shop_id, staff_id, sale_id, payment_id, kind, method, amount_cents, fee_cents, business_date, reason)
      SELECT r.shop_id, r.staff_id, r.sale_id, r.payment_id, 'adjust', 'adjust', -r.amount_cents, 0, r.business_date, 'core_0156:' || r.refund_id::text
      WHERE NOT EXISTS (
        SELECT 1 FROM tip_ledger x
        WHERE x.kind = 'adjust' AND x.staff_id = r.staff_id AND x.reason = 'core_0156:' || r.refund_id::text
      );
      how := 'adjusted';
    END IF;

    IF r.stripe_reversed_at IS NOT NULL THEN
      UPDATE payment_transfers SET stripe_reversed_at = NULL, updated_at = now() WHERE id = r.transfer_id AND stripe_reversed_at IS NOT NULL;
    END IF;

    INSERT INTO audit_log (actor_label, shop_id, action, entity, entity_id, details)
    VALUES (
      'system', r.shop_id, 'tips.clawback_restored', 'refund', r.refund_id::text || ':' || r.staff_id::text,
      jsonb_build_object(
        'ticket', r.ticket, 'saleId', r.sale_id, 'refundId', r.refund_id, 'staffId', r.staff_id,
        'paymentTransferId', r.transfer_id, 'cents', -r.amount_cents, 'how', how
      )
    );
  END LOOP;

  -- The transfer was marked reversed and the client was refunded the tip, but no negative ledger line remains.
  FOR r IN
    SELECT DISTINCT ON (pt.id)
      pt.id AS transfer_id, pt.shop_id, pt.staff_id, pt.sale_id, pt.payment_id, pt.amount_cents,
      rfd.id AS refund_id, LEAST(rfd.tip_cents, pt.amount_cents) AS cents, rfd.business_date, s.number AS ticket
    FROM payment_transfers pt
    JOIN refunds rfd ON rfd.payment_id = pt.payment_id AND rfd.tip_cents > 0
    LEFT JOIN sales s ON s.id = pt.sale_id
    WHERE pt.kind = 'tip' AND pt.status = 'sent' AND pt.stripe_reversed_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM tip_ledger l
        WHERE l.kind = 'refund' AND l.refund_id = rfd.id AND l.staff_id = pt.staff_id AND l.amount_cents < 0
      )
      AND NOT EXISTS (
        SELECT 1 FROM audit_log a
        WHERE a.action = 'tips.clawback_restored' AND a.entity = 'refund'
          AND a.entity_id = rfd.id::text || ':' || pt.staff_id::text
      )
    ORDER BY pt.id, abs(rfd.tip_cents - pt.amount_cents), rfd.created_at
  LOOP
    INSERT INTO tip_absorptions (shop_id, staff_id, sale_id, payment_id, refund_id, kind, amount_cents, business_date)
    VALUES (r.shop_id, r.staff_id, r.sale_id, r.payment_id, r.refund_id, 'after_payout', r.cents, r.business_date)
    ON CONFLICT (refund_id, staff_id) WHERE refund_id IS NOT NULL DO NOTHING;

    UPDATE payment_transfers SET stripe_reversed_at = NULL, updated_at = now() WHERE id = r.transfer_id AND stripe_reversed_at IS NOT NULL;

    INSERT INTO audit_log (actor_label, shop_id, action, entity, entity_id, details)
    VALUES (
      'system', r.shop_id, 'tips.clawback_restored', 'refund', r.refund_id::text || ':' || r.staff_id::text,
      jsonb_build_object(
        'ticket', r.ticket, 'saleId', r.sale_id, 'refundId', r.refund_id, 'staffId', r.staff_id,
        'paymentTransferId', r.transfer_id, 'cents', r.cents, 'how', 'cleared_reversal'
      )
    );
  END LOOP;
END $$;
