-- Test plan G-3 / BA-52, Charles (2026-10-28): a catalog bulk upload can be undone in one step. Each saved upload keeps what it changed (the before and after of every field, the items and shop rows it added, the stock it moved) and the brand sync batch it pushed, so an undo can put each back. Additive only.
ALTER TABLE "import_runs" ADD COLUMN IF NOT EXISTS "undo" jsonb;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN IF NOT EXISTS "sync_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN IF NOT EXISTS "rolled_back_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN IF NOT EXISTS "rolled_back_by" text;
