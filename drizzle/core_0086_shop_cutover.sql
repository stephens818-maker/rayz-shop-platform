CREATE TABLE IF NOT EXISTS "shop_cutovers" (
	"shop_id" uuid PRIMARY KEY NOT NULL REFERENCES "shops"("id") ON DELETE CASCADE,
	"squire_frozen_at" timestamp with time zone,
	"freeze_recorded_by" uuid REFERENCES "staff"("id") ON DELETE SET NULL,
	"freeze_recorded_at" timestamp with time zone,
	"reconciliation" jsonb,
	"reconciled_at" timestamp with time zone,
	"reconciled_by" uuid REFERENCES "staff"("id") ON DELETE SET NULL,
	"matched" boolean DEFAULT false NOT NULL,
	"signed_off_by" uuid REFERENCES "staff"("id") ON DELETE SET NULL,
	"signed_off_at" timestamp with time zone,
	"switched_at" timestamp with time zone,
	"handed_back_at" timestamp with time zone,
	"handed_back_by" uuid REFERENCES "staff"("id") ON DELETE SET NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_cutovers_signoff_chk" CHECK ("signed_off_at" IS NULL OR ("matched" AND "reconciled_at" IS NOT NULL AND "squire_frozen_at" IS NOT NULL))
);--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN IF NOT EXISTS "shop_id" uuid REFERENCES "shops"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_runs_shop_idx" ON "import_runs" ("shop_id", "created_at");
