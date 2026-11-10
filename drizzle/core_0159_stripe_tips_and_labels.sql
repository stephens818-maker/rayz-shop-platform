-- Existing shops default to Stripe tips. core_0157 only rewrote defaultMethod when it was
-- exactly the text cash and the schedule was not payroll, so a capitalized value, a method
-- key, or a brand-sync override stayed on cash. This sets every non-payroll shop to Stripe
-- and leaves the schedule alone (Coralville stays end of night). Payroll-schedule shops stay.
-- A saved tax split that does not add up to the shop's service rate is cleared, so a receipt
-- cannot keep saying 6% + 1% on an 8% charge. Saved receipt footers and card-fee notices
-- say credit card fee. Safe to run again. Does not touch tip transfers or stripe_reversed_at.

UPDATE shops
SET tip_payouts = jsonb_set(
  CASE WHEN jsonb_typeof(tip_payouts) = 'object' THEN tip_payouts ELSE '{}'::jsonb END,
  '{defaultMethod}',
  '"stripe"'::jsonb,
  true
)
WHERE coalesce(tip_payouts->>'schedule', '') <> 'payroll'
  AND lower(btrim(coalesce(tip_payouts->>'defaultMethod', tip_payouts->>'method', ''))) IS DISTINCT FROM 'stripe';
--> statement-breakpoint

UPDATE shop_sync_state
SET local = jsonb_set(local, '{defaultMethod}', '"stripe"'::jsonb, true)
WHERE key = 'tip_schedule'
  AND jsonb_typeof(local) = 'object'
  AND coalesce(local->>'schedule', '') <> 'payroll'
  AND lower(btrim(coalesce(local->>'defaultMethod', ''))) = 'cash';
--> statement-breakpoint

UPDATE brand_sync_values
SET value = jsonb_set(value, '{defaultMethod}', '"stripe"'::jsonb, true)
WHERE key = 'tip_schedule'
  AND jsonb_typeof(value) = 'object'
  AND coalesce(value->>'schedule', '') <> 'payroll'
  AND lower(btrim(coalesce(value->>'defaultMethod', ''))) = 'cash';
--> statement-breakpoint

UPDATE shops
SET receipt = jsonb_set(
  receipt,
  '{taxDisplay}',
  (receipt->'taxDisplay') - 'stateRate' - 'cityRate',
  true
)
WHERE jsonb_typeof(receipt) = 'object'
  AND jsonb_typeof(receipt->'taxDisplay') = 'object'
  AND (
    nullif(receipt->'taxDisplay'->>'stateRate', '') IS NOT NULL
    OR nullif(receipt->'taxDisplay'->>'cityRate', '') IS NOT NULL
  )
  AND abs(
    coalesce(nullif(receipt->'taxDisplay'->>'stateRate', '')::numeric, 0)
    + coalesce(nullif(receipt->'taxDisplay'->>'cityRate', '')::numeric, 0)
    - coalesce(service_tax_rate, 0)
  ) > 0.0005;
--> statement-breakpoint

UPDATE shops
SET receipt = jsonb_set(
  receipt,
  '{footer}',
  to_jsonb(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(receipt->>'footer', 'credit card surcharges', 'credit card fees', 'gi'),
              'credit card surcharge', 'credit card fee', 'gi'
            ),
            'card surcharges', 'credit card fees', 'gi'
          ),
          'card surcharge', 'credit card fee', 'gi'
        ),
        '\msurcharges\M', 'credit card fees', 'gi'
      ),
      '\msurcharge\M', 'credit card fee', 'gi'
    )
  )
)
WHERE receipt->>'footer' ILIKE '%surcharge%';
--> statement-breakpoint

UPDATE brand_settings
SET card_fee = jsonb_set(
  card_fee,
  '{notice}',
  to_jsonb(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(card_fee->>'notice', 'credit card surcharges', 'credit card fees', 'gi'),
              'credit card surcharge', 'credit card fee', 'gi'
            ),
            'card surcharges', 'credit card fees', 'gi'
          ),
          'card surcharge', 'credit card fee', 'gi'
        ),
        '\msurcharges\M', 'credit card fees', 'gi'
      ),
      '\msurcharge\M', 'credit card fee', 'gi'
    )
  ),
  false
)
WHERE card_fee->>'notice' ILIKE '%surcharge%';
--> statement-breakpoint

UPDATE brand_settings
SET card_fee = jsonb_set(
  card_fee,
  '{label}',
  to_jsonb(
    regexp_replace(
      regexp_replace(card_fee->>'label', 'credit card surcharge', 'credit card fee', 'gi'),
      '\msurcharge\M', 'credit card fee', 'gi'
    )
  ),
  false
)
WHERE card_fee->>'label' ILIKE '%surcharge%';
--> statement-breakpoint

UPDATE shops
SET card_fee_override = jsonb_set(
  card_fee_override,
  '{notice}',
  to_jsonb(
      regexp_replace(
        regexp_replace(
          regexp_replace(card_fee_override->>'notice', 'credit card surcharge', 'credit card fee', 'gi'),
          'card surcharge', 'credit card fee', 'gi'
        ),
        '\msurcharge\M', 'credit card fee', 'gi'
      )
  ),
  false
)
WHERE card_fee_override->>'notice' ILIKE '%surcharge%';
--> statement-breakpoint

UPDATE shops
SET card_fee_override = jsonb_set(
  card_fee_override,
  '{label}',
  to_jsonb(
      regexp_replace(
        regexp_replace(
          regexp_replace(card_fee_override->>'label', 'credit card surcharge', 'credit card fee', 'gi'),
          'card surcharge', 'credit card fee', 'gi'
        ),
        '\msurcharge\M', 'credit card fee', 'gi'
      )
  ),
  false
)
WHERE card_fee_override->>'label' ILIKE '%surcharge%';
--> statement-breakpoint

UPDATE brand_sync_values
SET value = jsonb_set(
  value,
  '{footer}',
  to_jsonb(
    regexp_replace(
      regexp_replace(
        regexp_replace(value->>'footer', 'credit card surcharge', 'credit card fee', 'gi'),
        'card surcharge', 'credit card fee', 'gi'
      ),
      '\msurcharge\M', 'credit card fee', 'gi'
    )
  )
)
WHERE key = 'receipt' AND value->>'footer' ILIKE '%surcharge%';
