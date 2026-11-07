-- Brand change scope: which shops a brand-level change syncs to, each shop's inheritance per setting,
-- brand values for settings that only lived on shops until now (hours, taxes, receipt), scheduled
-- syncs, and every sync's per-shop old and new values so it can be rolled back as one batch.
CREATE TABLE IF NOT EXISTS "shop_sync_state" (
  "shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE CASCADE,
  "key" text NOT NULL,
  "mode" text NOT NULL DEFAULT 'inherit',
  "local" jsonb,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "shop_sync_state_pk" PRIMARY KEY ("shop_id", "key"),
  CONSTRAINT "shop_sync_state_mode" CHECK ("mode" in ('inherit', 'override'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_sync_state_key_idx" ON "shop_sync_state" ("key");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "brand_sync_values" (
  "key" text PRIMARY KEY,
  "value" jsonb NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_by" uuid REFERENCES "staff"("id") ON DELETE SET NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "brand_sync_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind" text NOT NULL,
  "label" text NOT NULL,
  "status" text NOT NULL,
  "run_at" timestamp with time zone,
  "applied_at" timestamp with time zone,
  "created_by" uuid REFERENCES "staff"("id") ON DELETE SET NULL,
  "created_by_label" text NOT NULL,
  "scope" text NOT NULL DEFAULT 'all',
  "shop_ids" uuid[] NOT NULL DEFAULT '{}'::uuid[],
  "keys" text[] NOT NULL DEFAULT '{}'::text[],
  "brand" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "plan" jsonb,
  "error" text,
  "rolled_back_at" timestamp with time zone,
  "rolled_back_by" text,
  "rollback_of" uuid REFERENCES "brand_sync_batches"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "brand_sync_batches_kind" CHECK ("kind" in ('apply', 'push', 'reset', 'rollback')),
  CONSTRAINT "brand_sync_batches_status" CHECK ("status" in ('applied', 'scheduled', 'cancelled', 'rolled_back', 'failed')),
  CONSTRAINT "brand_sync_batches_scope" CHECK ("scope" in ('all', 'selected', 'brand_only')),
  CONSTRAINT "brand_sync_batches_run_at" CHECK ("status" <> 'scheduled' or "run_at" is not null)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brand_sync_batches_created_idx" ON "brand_sync_batches" ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brand_sync_batches_due_idx" ON "brand_sync_batches" ("run_at") WHERE "status" = 'scheduled';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "brand_sync_changes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "batch_id" uuid NOT NULL REFERENCES "brand_sync_batches"("id") ON DELETE CASCADE,
  "shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE CASCADE,
  "key" text NOT NULL,
  "action" text NOT NULL,
  "from" jsonb NOT NULL,
  "to" jsonb NOT NULL,
  CONSTRAINT "brand_sync_changes_action" CHECK ("action" in ('push', 'replace', 'keep', 'freeze', 'reset', 'restore'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brand_sync_changes_batch_idx" ON "brand_sync_changes" ("batch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brand_sync_changes_shop_idx" ON "brand_sync_changes" ("shop_id", "key");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "brand_sync_controls" (
  "type" text PRIMARY KEY,
  "shops_can_edit" boolean NOT NULL DEFAULT false,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_by" uuid REFERENCES "staff"("id") ON DELETE SET NULL
);
