-- The staff app's API (/api/staff/v1): its own sign-ins with rotating refresh tokens, apart from the customer app's, and its phones for booking pushes. Additive only.
CREATE TABLE IF NOT EXISTS "staff_app_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL REFERENCES "staff"("id") ON DELETE cascade,
	"session_id" uuid NOT NULL,
	"token_hash" text NOT NULL UNIQUE,
	"device_name" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_app_tokens_session_idx" ON "staff_app_tokens" ("session_id") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_app_tokens_staff_live_idx" ON "staff_app_tokens" ("staff_id") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL REFERENCES "staff"("id") ON DELETE cascade,
	"platform" text NOT NULL,
	"provider" text NOT NULL,
	"token" text NOT NULL,
	"app_version" text,
	"os_version" text,
	"push_enabled" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"session_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "staff_devices_token_uq" ON "staff_devices" ("token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_devices_staff_idx" ON "staff_devices" ("staff_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_devices_session_idx" ON "staff_devices" ("session_id") WHERE "session_id" IS NOT NULL;
