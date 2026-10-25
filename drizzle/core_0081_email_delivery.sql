-- Email delivery: addresses no email goes to any more (a hard bounce, a spam complaint, the stop link in an email, or staff), with the clients whose "OK to email" that turned off; and each customer's private calendar feed, by the hash of its token, revocable. Additive only.
CREATE TABLE IF NOT EXISTS "email_suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"reason" text NOT NULL,
	"provider" text,
	"customer_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_suppressions_email_uq" UNIQUE ("email"),
	CONSTRAINT "email_suppressions_reason_chk" CHECK ("reason" in ('bounce', 'complaint', 'unsubscribe', 'staff')),
	CONSTRAINT "email_suppressions_email_lower_chk" CHECK ("email" = lower("email"))
);
--> statement-breakpoint
DROP TRIGGER IF EXISTS "email_suppressions_scrub_sensitive" ON "email_suppressions";--> statement-breakpoint
CREATE TRIGGER "email_suppressions_scrub_sensitive" BEFORE INSERT OR UPDATE OF "reason" ON "email_suppressions" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('reason');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendar_feeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE cascade,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "calendar_feeds_token_uq" UNIQUE ("token_hash")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "calendar_feeds_active_uq" ON "calendar_feeds" ("customer_id") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_jobs_customer_idx" ON "notification_jobs" ("customer_id", "created_at");
