-- Staff chat, shop and staff photos, archived clients, and demo cleanup.
-- Punches are not voided here. A one-minute GPS cluster used to be voided on every
-- run of this file. That rule is gone: no punch is voided automatically. Makenna's
-- Oct 27 punches are not touched.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS archived_at timestamptz;
CREATE INDEX IF NOT EXISTS customers_live_name_idx ON customers (search_name) WHERE archived_at IS NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS location_photos (
  shop_id uuid PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,
  data_url text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES staff(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS staff_photos (
  staff_id uuid PRIMARY KEY REFERENCES staff(id) ON DELETE CASCADE,
  data_url text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  shop_id uuid REFERENCES shops(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_channels_kind_ck CHECK (kind IN ('shop', 'brand', 'dm')),
  CONSTRAINT staff_channels_shop_ck CHECK ((kind = 'shop') = (shop_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS staff_channels_shop_uq ON staff_channels (shop_id) WHERE kind = 'shop';
CREATE UNIQUE INDEX IF NOT EXISTS staff_channels_brand_uq ON staff_channels (kind) WHERE kind = 'brand';

CREATE TABLE IF NOT EXISTS staff_channel_members (
  channel_id uuid NOT NULL REFERENCES staff_channels(id) ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, staff_id)
);

CREATE TABLE IF NOT EXISTS staff_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES staff_channels(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES staff(id),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  reported_at timestamptz,
  CONSTRAINT staff_messages_body_ck CHECK (char_length(btrim(body)) > 0 AND char_length(body) <= 2000)
);
CREATE INDEX IF NOT EXISTS staff_messages_channel_idx ON staff_messages (channel_id, created_at);

UPDATE customers
SET archived_at = now()
WHERE archived_at IS NULL
  AND deleted_at IS NULL
  AND lower(first_name) = 'consent'
  AND lower(last_name) = 'zzcanary';

UPDATE appointments
SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'staff', cancel_reason = 'Demo cleanup'
WHERE code = 'A5TDPQTQ87'
  AND status IN ('booked', 'confirmed', 'checked_in');

UPDATE sales s
SET status = 'voided', voided_at = now(), void_reason = 'Demo cleanup: open unpaid test ticket'
WHERE s.id::text LIKE '5417a3e4%'
  AND s.status = 'open'
  AND NOT EXISTS (
    SELECT 1 FROM payments p
    WHERE p.sale_id = s.id AND p.status IN ('pending', 'succeeded')
  );
