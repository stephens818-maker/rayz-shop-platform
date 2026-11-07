-- Kiosk and time clock security (claude bot, Oct 28): every clock request and kiosk QR code carries a single-use nonce. Claiming one is an insert into this table, so the primary key refuses a replay atomically, even two sends racing. Additive; nothing reads it but the clock.
CREATE TABLE IF NOT EXISTS "clock_nonces" (
  "nonce" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "device_id" uuid REFERENCES "clock_devices"("id") ON DELETE SET NULL,
  "staff_id" uuid REFERENCES "staff"("id") ON DELETE SET NULL,
  "requested_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "clock_nonces_created_idx" ON "clock_nonces" ("created_at");
