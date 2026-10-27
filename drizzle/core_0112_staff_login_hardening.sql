-- ST-C0c: password lockout, per-browser web sessions, step-up, new-device alerts and kiosk pairing.
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "password_failures" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "password_locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff_app_tokens" ADD COLUMN IF NOT EXISTS "step_up_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_web_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL REFERENCES "staff"("id") ON DELETE cascade,
	"device_hash" text,
	"device_label" text,
	"ip" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"step_up_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_web_sessions_staff_live_idx" ON "staff_web_sessions" ("staff_id") WHERE "revoked_at" is null;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_known_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL REFERENCES "staff"("id") ON DELETE cascade,
	"via" text NOT NULL,
	"device_hash" text NOT NULL,
	"device_label" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_known_devices_via" CHECK ("via" in ('web', 'app'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "staff_known_devices_uq" ON "staff_known_devices" ("staff_id", "device_hash");--> statement-breakpoint
ALTER TABLE "clock_devices" ADD COLUMN IF NOT EXISTS "paired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clock_devices" ADD COLUMN IF NOT EXISTS "install_hash" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "clock_pairings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
	"label" text NOT NULL,
	"code_hash" text NOT NULL UNIQUE,
	"created_by" uuid NOT NULL REFERENCES "staff"("id"),
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"device_id" uuid REFERENCES "clock_devices"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
)
