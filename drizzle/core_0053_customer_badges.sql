-- Customer-facing badges: the day each cached badge was earned and what progress meters read, Badge news notices (a customer-visible badge earned or lost, sent through the Campaign Center), and an orange tone for Bronze and Streak. Additive only; the tone check only widens.
ALTER TABLE "client_badges" ADD COLUMN IF NOT EXISTS "since" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "client_badges" ADD COLUMN IF NOT EXISTS "progress" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_badges" DROP CONSTRAINT IF EXISTS "custom_badges_tone";--> statement-breakpoint
ALTER TABLE "custom_badges" ADD CONSTRAINT "custom_badges_tone" CHECK ("tone" in ('gray', 'green', 'blue', 'amber', 'orange', 'red', 'violet'));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "client_badge_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE cascade,
	"badge_key" text NOT NULL,
	"change" text NOT NULL,
	"occurred_on" date NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"send_id" uuid REFERENCES "marketing_sends"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"handled_at" timestamp with time zone,
	CONSTRAINT "client_badge_notices_change" CHECK ("change" in ('earned', 'lost')),
	CONSTRAINT "client_badge_notices_status" CHECK ("status" in ('pending', 'queued', 'skipped'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "client_badge_notices_uq" ON "client_badge_notices" USING btree ("customer_id", "badge_key", "change", "occurred_on");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_badge_notices_pending_idx" ON "client_badge_notices" USING btree ("status", "created_at");
