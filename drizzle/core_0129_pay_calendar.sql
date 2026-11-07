-- iSolved pay calendar (2026-10-27, from iSolved, still being confirmed): Ray'z Inc. is one legal entity; each shop is its own pay group with a letter code (B is Rock Island, C is Moline); bi-weekly Sun–Sat periods, e.g. period 22 = 10/4–10/17/2026, due in iSolved Wednesday 10/21, check Friday 10/23. Additive only.
ALTER TABLE "pay_groups" ADD COLUMN IF NOT EXISTS "isolved_code" text;--> statement-breakpoint
ALTER TABLE "pay_groups" ADD COLUMN IF NOT EXISTS "submit_offset_days" integer DEFAULT 4 NOT NULL;--> statement-breakpoint
UPDATE "pay_groups" SET "submit_offset_days" = LEAST("submit_offset_days", "check_offset_days") WHERE "submit_offset_days" > "check_offset_days";--> statement-breakpoint
ALTER TABLE "pay_groups" DROP CONSTRAINT IF EXISTS "pay_groups_submit_offset";--> statement-breakpoint
ALTER TABLE "pay_groups" ADD CONSTRAINT "pay_groups_submit_offset" CHECK ("submit_offset_days" BETWEEN 0 AND "check_offset_days");--> statement-breakpoint
ALTER TABLE "pay_groups" DROP CONSTRAINT IF EXISTS "pay_groups_isolved_code";--> statement-breakpoint
ALTER TABLE "pay_groups" ADD CONSTRAINT "pay_groups_isolved_code" CHECK ("isolved_code" IS NULL OR "isolved_code" ~ '^[A-Z0-9]{1,4}$');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pay_groups_isolved_code_uq" ON "pay_groups" USING btree ("isolved_code") WHERE "isolved_code" IS NOT NULL;--> statement-breakpoint
-- The two codes iSolved has given so far; the rest are entered on Payroll → Setup.
UPDATE "pay_groups" g SET "isolved_code" = c.code
FROM "shops" s, (VALUES ('rockisland', 'B'), ('moline', 'C')) AS c(name, code)
WHERE s."id" = g."shop_id" AND lower(regexp_replace(s."name", '[^A-Za-z]', '', 'g')) = c.name AND g."isolved_code" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "pay_groups" o WHERE o."isolved_code" = c.code);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pay_period_dates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pay_group_id" uuid NOT NULL REFERENCES "pay_groups"("id") ON DELETE cascade,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"period_number" integer NOT NULL,
	"check_date" date NOT NULL,
	"submit_by" date NOT NULL,
	"reason" text,
	"updated_by" uuid REFERENCES "staff"("id"),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pay_period_dates_uq" UNIQUE("pay_group_id", "period_start"),
	CONSTRAINT "pay_period_dates_order" CHECK ("period_end" >= "period_start" AND "submit_by" >= "period_end" AND "check_date" >= "submit_by"),
	CONSTRAINT "pay_period_dates_reason_len" CHECK ("reason" IS NULL OR char_length("reason") <= 200)
);--> statement-breakpoint
DROP TRIGGER IF EXISTS "pay_period_dates_scrub_sensitive" ON "pay_period_dates";--> statement-breakpoint
CREATE TRIGGER "pay_period_dates_scrub_sensitive" BEFORE INSERT OR UPDATE OF "reason" ON "pay_period_dates" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('reason');
