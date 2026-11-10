-- Account deletion (C10): a deleted client keeps their row so tickets, tips and payouts still add up, but every
-- detail that identifies them is cleared and deleted_at is set. Marketing, search and imports skip them.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customers_deleted_idx" ON "customers" ("deleted_at") WHERE "deleted_at" IS NOT NULL;
