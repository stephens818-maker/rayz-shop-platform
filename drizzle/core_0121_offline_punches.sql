-- ST-I18: a punch the staff app queued with no signal carries its own id, so a retry goes in once.
ALTER TABLE "time_punches" ADD COLUMN IF NOT EXISTS "client_punch_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "time_punches_client_punch_uq" ON "time_punches" USING btree ("staff_id", "client_punch_id") WHERE "client_punch_id" is not null;
