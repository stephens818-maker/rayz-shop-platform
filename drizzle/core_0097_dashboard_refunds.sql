-- A refund made in the Stripe dashboard is booked as money back on the card with no lines: it
-- doesn't touch loyalty, gift cards, commissions or tip pay until staff say what it was for.
ALTER TABLE "refunds" ADD COLUMN IF NOT EXISTS "awaiting_lines" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN IF NOT EXISTS "lines_assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN IF NOT EXISTS "lines_assigned_by" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refunds_awaiting_idx" ON "refunds" USING btree ("shop_id") WHERE "awaiting_lines";
