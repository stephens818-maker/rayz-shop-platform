-- I12: a customer's sessions. A session is one sign-in: its refresh tokens rotate, and every one of them carries the
-- session's id (the first token's). Access tokens name the session, and stop working once it has no live refresh token
-- (signed out, signed out from another device, or ended for a reused token). Push devices remember the session they were
-- registered from, so ending it stops push to that phone. Additive only; existing tokens each become their own session.
ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "session_id" uuid;--> statement-breakpoint
UPDATE "refresh_tokens" SET "session_id" = "id" WHERE "session_id" IS NULL;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ALTER COLUMN "session_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refresh_tokens_session_idx" ON "refresh_tokens" ("session_id") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refresh_tokens_customer_live_idx" ON "refresh_tokens" ("customer_id") WHERE "revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "customer_devices" ADD COLUMN IF NOT EXISTS "session_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_devices_session_idx" ON "customer_devices" ("session_id") WHERE "session_id" IS NOT NULL;
