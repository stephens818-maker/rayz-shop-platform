-- Client contact grants (the brand's per-person or per-location exceptions to "no full contact details, no client-list exports" for shop logins and staff) and self-serve brand portal users: email invites, required two-step sign-in with an authenticator app, and removing a user while keeping their history. Additive only.
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "two_factor_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "totp_secret" text;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "totp_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "totp_last_step" integer;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "totp_failures" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "totp_locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "invited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "removed_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL REFERENCES "staff"("id") ON DELETE cascade,
	"token_hash" text NOT NULL UNIQUE,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_invites_staff_idx" ON "staff_invites" USING btree ("staff_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "client_contact_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"staff_id" uuid REFERENCES "staff"("id") ON DELETE cascade,
	"shop_id" uuid REFERENCES "shops"("id") ON DELETE cascade,
	"note" text,
	"expires_at" timestamp with time zone,
	"granted_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"granted_by_label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"revoked_by_label" text,
	CONSTRAINT "client_contact_grants_kind" CHECK ("kind" in ('full_contact', 'export')),
	CONSTRAINT "client_contact_grants_target" CHECK (("staff_id" is null) <> ("shop_id" is null))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_contact_grants_staff_idx" ON "client_contact_grants" USING btree ("staff_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_contact_grants_shop_idx" ON "client_contact_grants" USING btree ("shop_id");--> statement-breakpoint
CREATE TRIGGER "client_contact_grants_scrub_sensitive" BEFORE INSERT OR UPDATE OF "note" ON "client_contact_grants" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('note');--> statement-breakpoint
ALTER TABLE "notification_jobs" DROP CONSTRAINT IF EXISTS "notification_jobs_shop_present";--> statement-breakpoint
ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_shop_present" CHECK ("shop_id" IS NOT NULL OR "kind" IN ('otp', 'privacy_alert', 'digest', 'saved_report', 'staff_invite')) NOT VALID;
