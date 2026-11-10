-- Post-visit review push (I4): strings the app reads when a push is tapped, beyond its kind and appointment (the review link).
ALTER TABLE "notification_jobs" ADD COLUMN IF NOT EXISTS "push_data" jsonb;
