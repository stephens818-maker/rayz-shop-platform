-- Customer identity: verified emails (only those sign in or match), the light check on an imported profile's first app sign-in, "I can't sign in" requests that become staff tasks, request limits per IP and identifier, and the app kill switches. Additive only; every existing email starts unverified.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "identity_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "identity_check_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "last_app_sign_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "otp_codes" ADD COLUMN IF NOT EXISTS "provider" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "otp_codes" ADD COLUMN IF NOT EXISTS "purpose" text DEFAULT 'sign_in' NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "identity_help_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text,
	"email" text,
	"first_name" text NOT NULL,
	"last_name" text,
	"message" text,
	"reason" text NOT NULL,
	"candidate_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"resolution" text,
	CONSTRAINT "identity_help_requests_status_chk" CHECK ("status" in ('open', 'resolved', 'dismissed')),
	CONSTRAINT "identity_help_requests_reason_chk" CHECK ("reason" in ('identity_check', 'idle_number', 'cant_sign_in'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_help_requests_open_idx" ON "identity_help_requests" ("created_at") WHERE "status" = 'open';--> statement-breakpoint
DROP TRIGGER IF EXISTS "identity_help_requests_scrub_sensitive" ON "identity_help_requests";--> statement-breakpoint
CREATE TRIGGER "identity_help_requests_scrub_sensitive" BEFORE INSERT OR UPDATE OF "message", "reason" ON "identity_help_requests" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('message', 'reason');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_rate_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"bucket" text NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_rate_events_lookup_idx" ON "api_rate_events" ("bucket", "key", "created_at");--> statement-breakpoint
ALTER TABLE "brand_settings" ADD COLUMN IF NOT EXISTS "app_switches" jsonb DEFAULT '{}'::jsonb NOT NULL;
