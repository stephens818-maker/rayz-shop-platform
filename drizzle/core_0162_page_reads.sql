-- Faster page reads. Does not change punches, tip payout schedules, or tip transfers.
ALTER TABLE "brand_settings" ADD COLUMN "tip_ledger_synced_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "appointments_shop_ends_idx" ON "appointments" ("shop_id", "ends_at");--> statement-breakpoint
CREATE INDEX "time_entries_ends_idx" ON "time_entries" ("ends_at");--> statement-breakpoint
CREATE INDEX "payments_tipped_created_idx" ON "payments" ("created_at") WHERE "tip_cents" <> 0;--> statement-breakpoint
CREATE INDEX "refunds_tipped_created_idx" ON "refunds" ("created_at") WHERE "tip_cents" <> 0;
