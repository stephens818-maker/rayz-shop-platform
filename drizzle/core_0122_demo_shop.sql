-- ST-I19: the Demo Shop and the reviewer login for Apple and Google app review.
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "is_demo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "is_demo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- A demo shop is never open to clients, and a review login works only there.
ALTER TABLE "shops" ADD CONSTRAINT "shops_demo_not_public" CHECK (NOT "is_demo" OR "status" = 'setup');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shops_one_demo" ON "shops" USING btree ("is_demo") WHERE "is_demo";
