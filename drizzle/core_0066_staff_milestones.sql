-- Staff milestones: counts (cuts, clients, new clients, rebooks, products sold), work anniversaries from a hire date, optional birthdays (month and day only, never a year), personal bests and streaks. The brand edits the rules and thresholds and adds its own; Squire totals from before the imported history are entered as a baseline per person. Achievements are logged once each, with who was told and when they saw it; teammates can cheer one when the brand turns on the team feed. A brand-approved Campaign Center template lets a barber's clients celebrate with them. Additive only.
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "hire_date" date;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "birthday_month" smallint;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "birthday_day" smallint;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "milestones_shared" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "staff" DROP CONSTRAINT IF EXISTS "staff_hire_date_chk";--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_hire_date_chk" CHECK ("hire_date" IS NULL OR "hire_date" >= '1950-01-01');--> statement-breakpoint
ALTER TABLE "staff" DROP CONSTRAINT IF EXISTS "staff_birthday_chk";--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_birthday_chk" CHECK (("birthday_month" IS NULL) = ("birthday_day" IS NULL) AND ("birthday_month" IS NULL OR ("birthday_month" BETWEEN 1 AND 12 AND "birthday_day" BETWEEN 1 AND CASE WHEN "birthday_month" = 2 THEN 29 WHEN "birthday_month" IN (4, 6, 9, 11) THEN 30 ELSE 31 END)));--> statement-breakpoint
ALTER TABLE "brand_settings" ADD COLUMN IF NOT EXISTS "milestones" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_milestone_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text UNIQUE,
	"kind" text NOT NULL,
	"metric" text NOT NULL,
	"name" text NOT NULL,
	"unit" text,
	"thresholds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"service_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"built_in" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"created_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_milestone_rules_kind_chk" CHECK ("kind" in ('count', 'anniversary', 'birthday', 'best', 'streak')),
	CONSTRAINT "staff_milestone_rules_metric_chk" CHECK (
		("kind" = 'count' AND "metric" in ('services', 'clients', 'new_clients', 'rebooks', 'products'))
		OR ("kind" = 'anniversary' AND "metric" = 'hire_date')
		OR ("kind" = 'birthday' AND "metric" = 'birthday')
		OR ("kind" = 'best' AND "metric" in ('sales_day', 'sales_week', 'sales_month', 'cuts_day', 'rebook_month'))
		OR ("kind" = 'streak' AND "metric" in ('five_star', 'on_time'))
	),
	CONSTRAINT "staff_milestone_rules_thresholds_chk" CHECK (jsonb_typeof("thresholds") = 'array' AND jsonb_array_length("thresholds") <= 20),
	CONSTRAINT "staff_milestone_rules_services_chk" CHECK (jsonb_typeof("service_ids") = 'array' AND ("metric" = 'services' OR jsonb_array_length("service_ids") = 0))
);--> statement-breakpoint
-- Totals from before the history in the system (Squire's own counts): the metric is this plus everything on or after as_of.
CREATE TABLE IF NOT EXISTS "staff_milestone_baselines" (
	"staff_id" uuid NOT NULL REFERENCES "staff"("id") ON DELETE cascade,
	"metric" text NOT NULL,
	"count" integer NOT NULL,
	"as_of" date NOT NULL,
	"set_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("staff_id", "metric"),
	CONSTRAINT "staff_milestone_baselines_metric_chk" CHECK ("metric" in ('services', 'clients', 'new_clients', 'rebooks', 'products')),
	CONSTRAINT "staff_milestone_baselines_count_chk" CHECK ("count" BETWEEN 0 AND 1000000)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL REFERENCES "staff"("id") ON DELETE cascade,
	"rule_id" uuid REFERENCES "staff_milestone_rules"("id") ON DELETE set null,
	"kind" text NOT NULL,
	"metric" text NOT NULL,
	"threshold" integer,
	"value" bigint,
	"previous" bigint,
	"period" text,
	"achieved_on" date NOT NULL,
	"shop_id" uuid REFERENCES "shops"("id") ON DELETE set null,
	"title" text NOT NULL,
	"silent" boolean DEFAULT false NOT NULL,
	"dedupe_key" text NOT NULL UNIQUE,
	"notified_at" timestamp with time zone,
	"seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_milestones_kind_chk" CHECK ("kind" in ('count', 'anniversary', 'birthday', 'best', 'streak'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_milestones_staff_idx" ON "staff_milestones" ("staff_id", "achieved_on");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_milestones_date_idx" ON "staff_milestones" ("achieved_on");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_milestone_cheers" (
	"milestone_id" uuid NOT NULL REFERENCES "staff_milestones"("id") ON DELETE cascade,
	"staff_id" uuid NOT NULL REFERENCES "staff"("id") ON DELETE cascade,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("milestone_id", "staff_id"),
	CONSTRAINT "staff_milestone_cheers_message_chk" CHECK ("message" IS NULL OR char_length("message") <= 140)
);--> statement-breakpoint
DROP TRIGGER IF EXISTS "staff_milestone_cheers_scrub_sensitive" ON "staff_milestone_cheers";--> statement-breakpoint
CREATE TRIGGER "staff_milestone_cheers_scrub_sensitive" BEFORE INSERT OR UPDATE OF "message" ON "staff_milestone_cheers" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('message');--> statement-breakpoint
INSERT INTO "staff_milestone_rules" ("key", "kind", "metric", "name", "unit", "thresholds", "built_in", "sort_order")
VALUES
	('services', 'count', 'services', 'Cuts and services', 'cuts', '[100, 500, 1000, 5000, 10000]'::jsonb, true, 10),
	('clients', 'count', 'clients', 'Clients served', 'clients served', '[100, 250, 500, 1000, 2500]'::jsonb, true, 20),
	('new_clients', 'count', 'new_clients', 'New clients', 'new clients', '[50, 100, 250, 500, 1000]'::jsonb, true, 30),
	('rebooks', 'count', 'rebooks', 'Rebooks', 'rebooks', '[100, 250, 500, 1000, 2500]'::jsonb, true, 40),
	('products', 'count', 'products', 'Products sold', 'products sold', '[100, 250, 500, 1000]'::jsonb, true, 50),
	('anniversary', 'anniversary', 'hire_date', 'Work anniversary', NULL, '[1, 5, 10]'::jsonb, true, 60),
	('birthday', 'birthday', 'birthday', 'Birthday', NULL, '[]'::jsonb, true, 70),
	('best_sales_day', 'best', 'sales_day', 'Best sales day', NULL, '[]'::jsonb, true, 80),
	('best_sales_week', 'best', 'sales_week', 'Best sales week', NULL, '[]'::jsonb, true, 81),
	('best_sales_month', 'best', 'sales_month', 'Best sales month', NULL, '[]'::jsonb, true, 82),
	('best_cuts_day', 'best', 'cuts_day', 'Most cuts in a day', NULL, '[]'::jsonb, true, 83),
	('best_rebook_month', 'best', 'rebook_month', 'Highest rebook rate', NULL, '[]'::jsonb, true, 84),
	('streak_five_star', 'streak', 'five_star', '5-star ratings in a row', '5-star ratings in a row', '[10, 25, 50, 100]'::jsonb, true, 90),
	('streak_on_time', 'streak', 'on_time', 'On-time starts in a row', 'on-time starts in a row', '[25, 50, 100, 250]'::jsonb, true, 91)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
ALTER TABLE "marketing_templates" ADD COLUMN IF NOT EXISTS "purpose" text;--> statement-breakpoint
ALTER TABLE "marketing_templates" DROP CONSTRAINT IF EXISTS "marketing_templates_purpose_chk";--> statement-breakpoint
ALTER TABLE "marketing_templates" ADD CONSTRAINT "marketing_templates_purpose_chk" CHECK ("purpose" IS NULL OR "purpose" in ('milestone'));--> statement-breakpoint
INSERT INTO "marketing_templates" ("name", "campaign_type", "description", "channels", "templates", "status", "approved_at", "purpose")
SELECT 'Celebrate a barber''s milestone', 'update', 'Lets a barber''s clients celebrate with them: first name only, never a number about the business. Offered from the barber''s milestone; "a big milestone" becomes the milestone itself.', '["sms","email","push"]'::jsonb,
	'{"sms":"{shop}: {barber} just hit a big milestone, and clients like you made it happen. Thanks, {first_name}! Come celebrate in the chair: {book_link} Reply STOP to opt out.","emailSubject":"{barber} just hit a big milestone","emailBody":"Hi {first_name},\n\n{barber} at {shop} just hit a big milestone, and clients like you made it happen. Thank you!\n\nCome celebrate in the chair: {book_link}","pushTitle":"{barber} just hit a big milestone","pushBody":"Thanks for being part of it, {first_name}."}'::jsonb,
	'approved', now(), 'milestone'
WHERE NOT EXISTS (SELECT 1 FROM "marketing_templates" WHERE "purpose" = 'milestone');--> statement-breakpoint
ALTER TABLE "notification_jobs" DROP CONSTRAINT IF EXISTS "notification_jobs_shop_present";--> statement-breakpoint
ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_shop_present" CHECK ("shop_id" IS NOT NULL OR "kind" IN ('otp', 'privacy_alert', 'digest', 'saved_report', 'staff_invite', 'milestone')) NOT VALID;--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["milestones.view","report.milestones.view","report.milestones.export"]'::jsonb WHERE "permissions" ? 'staff.manage' AND NOT ("permissions" ? 'milestones.view');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["milestones.settings"]'::jsonb WHERE "key" IN ('brand_admin') AND NOT ("permissions" ? 'milestones.settings');
