UPDATE "notification_jobs" SET "body" = regexp_replace("body", '[0-9]{6}', '••••••', 'g') WHERE "kind" = 'otp';
