-- Saved notices, receipt footers, and ticket disclosures say credit card fee.
-- Older text that still says surcharge is rewritten. Safe to run again.
-- Does not touch punches, tip payout schedules, or tip transfers.

CREATE OR REPLACE FUNCTION rayz_credit_card_fee_wording(t text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  s text := t;
BEGIN
  IF s IS NULL OR position('surcharge' in lower(s)) = 0 THEN
    RETURN s;
  END IF;
  s := regexp_replace(s, 'Credit card surcharges', 'Credit card fees', 'g');
  s := regexp_replace(s, 'credit card surcharges', 'credit card fees', 'g');
  s := regexp_replace(s, 'Credit card surcharge', 'Credit card fee', 'g');
  s := regexp_replace(s, 'credit card surcharge', 'credit card fee', 'g');
  s := regexp_replace(s, 'Card surcharges', 'Credit card fees', 'g');
  s := regexp_replace(s, 'card surcharges', 'credit card fees', 'g');
  s := regexp_replace(s, 'Card surcharge', 'Credit card fee', 'g');
  s := regexp_replace(s, 'card surcharge', 'credit card fee', 'g');
  s := regexp_replace(s, '\mSurcharges\M', 'Credit card fees', 'g');
  s := regexp_replace(s, '\msurcharges\M', 'credit card fees', 'g');
  s := regexp_replace(s, '\mSurcharge\M', 'Credit card fee', 'g');
  s := regexp_replace(s, '\msurcharge\M', 'credit card fee', 'g');
  RETURN s;
END;
$$;
--> statement-breakpoint

UPDATE shops
SET receipt = jsonb_set(receipt, '{footer}', to_jsonb(rayz_credit_card_fee_wording(receipt->>'footer')))
WHERE receipt->>'footer' ILIKE '%surcharge%';
--> statement-breakpoint

UPDATE brand_settings
SET card_fee = jsonb_set(card_fee, '{notice}', to_jsonb(rayz_credit_card_fee_wording(card_fee->>'notice')), false)
WHERE card_fee->>'notice' ILIKE '%surcharge%';
--> statement-breakpoint

UPDATE brand_settings
SET card_fee = jsonb_set(card_fee, '{label}', to_jsonb(rayz_credit_card_fee_wording(card_fee->>'label')), false)
WHERE card_fee->>'label' ILIKE '%surcharge%';
--> statement-breakpoint

UPDATE shops
SET card_fee_override = jsonb_set(card_fee_override, '{notice}', to_jsonb(rayz_credit_card_fee_wording(card_fee_override->>'notice')), false)
WHERE card_fee_override->>'notice' ILIKE '%surcharge%';
--> statement-breakpoint

UPDATE shops
SET card_fee_override = jsonb_set(card_fee_override, '{label}', to_jsonb(rayz_credit_card_fee_wording(card_fee_override->>'label')), false)
WHERE card_fee_override->>'label' ILIKE '%surcharge%';
--> statement-breakpoint

UPDATE brand_sync_values
SET value = jsonb_set(value, '{footer}', to_jsonb(rayz_credit_card_fee_wording(value->>'footer')))
WHERE value->>'footer' ILIKE '%surcharge%';
--> statement-breakpoint

UPDATE brand_sync_values
SET value = jsonb_set(value, '{notice}', to_jsonb(rayz_credit_card_fee_wording(value->>'notice')), false)
WHERE value->>'notice' ILIKE '%surcharge%';
--> statement-breakpoint

UPDATE brand_sync_values
SET value = jsonb_set(value, '{label}', to_jsonb(rayz_credit_card_fee_wording(value->>'label')), false)
WHERE value->>'label' ILIKE '%surcharge%';
--> statement-breakpoint

UPDATE sales
SET pricing = jsonb_set(
  pricing,
  '{disclosures}',
  COALESCE((
    SELECT jsonb_agg(to_jsonb(rayz_credit_card_fee_wording(txt)) ORDER BY ord)
    FROM jsonb_array_elements_text(pricing->'disclosures') WITH ORDINALITY AS e(txt, ord)
  ), '[]'::jsonb)
)
WHERE jsonb_typeof(pricing->'disclosures') = 'array'
  AND pricing->>'disclosures' ILIKE '%surcharge%';
--> statement-breakpoint

UPDATE sales
SET pricing = jsonb_set(pricing, '{cardFee,notice}', to_jsonb(rayz_credit_card_fee_wording(pricing->'cardFee'->>'notice')))
WHERE pricing->'cardFee'->>'notice' ILIKE '%surcharge%';
--> statement-breakpoint

UPDATE sales
SET pricing = jsonb_set(pricing, '{cardFee,name}', to_jsonb(rayz_credit_card_fee_wording(pricing->'cardFee'->>'name')))
WHERE pricing->'cardFee'->>'name' ILIKE '%surcharge%';
--> statement-breakpoint

DROP FUNCTION rayz_credit_card_fee_wording(text);
