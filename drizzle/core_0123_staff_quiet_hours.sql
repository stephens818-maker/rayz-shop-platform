-- ST-I20: a staff text or app alert held for quiet hours names the person, so clocking in sends it then.
ALTER TABLE "notification_jobs" ADD COLUMN IF NOT EXISTS "held_for_staff_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_held_for_staff_id_staff_id_fk" FOREIGN KEY ("held_for_staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_jobs_held_idx" ON "notification_jobs" USING btree ("held_for_staff_id") WHERE "held_for_staff_id" is not null;
