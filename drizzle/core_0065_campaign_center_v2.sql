-- Campaign Center, second pass (lessons from Squire's Engage): blasts get a type (quick update or promotion), recurring schedules (weekly, every 2 weeks, monthly, until an end date) and a paused state, an A/B test of the wording with an automatic winner, a holdout group, send-time optimization and the template they started from; AI-drafted blasts are marked so a person always reviews them before they go. Sends record their A/B variant, unique email opens (a tracking pixel) and whether the client was already booked when it went (left out of attributed revenue); holdout clients get a row of their own and no message. A brand-approved template library. Coupons get days of the week and a time window. Additive only.
ALTER TABLE "marketing_campaigns" DROP CONSTRAINT IF EXISTS "marketing_campaigns_status_chk";--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_status_chk" CHECK ("status" in ('draft', 'scheduled', 'sending', 'sent', 'cancelled', 'pending_approval', 'rejected', 'expired', 'paused', 'testing'));--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD COLUMN IF NOT EXISTS "campaign_type" text;--> statement-breakpoint
ALTER TABLE "marketing_campaigns" DROP CONSTRAINT IF EXISTS "marketing_campaigns_type_chk";--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_type_chk" CHECK ("campaign_type" IS NULL OR "campaign_type" in ('update', 'promotion'));--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD COLUMN IF NOT EXISTS "recurrence" jsonb;--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD COLUMN IF NOT EXISTS "ab" jsonb;--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD COLUMN IF NOT EXISTS "holdout_pct" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "marketing_campaigns" DROP CONSTRAINT IF EXISTS "marketing_campaigns_holdout_chk";--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_holdout_chk" CHECK ("holdout_pct" BETWEEN 0 AND 50);--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD COLUMN IF NOT EXISTS "send_time_opt" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD COLUMN IF NOT EXISTS "ai_drafted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- The brand's approved wording, for new blasts to start from.
CREATE TABLE IF NOT EXISTS "marketing_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"campaign_type" text DEFAULT 'update' NOT NULL,
	"description" text,
	"channels" jsonb DEFAULT '["sms","email","push"]'::jsonb NOT NULL,
	"templates" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"approved_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"approved_at" timestamp with time zone,
	"created_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketing_templates_type_chk" CHECK ("campaign_type" in ('update', 'promotion')),
	CONSTRAINT "marketing_templates_status_chk" CHECK ("status" in ('draft', 'approved', 'archived')),
	CONSTRAINT "marketing_templates_approved_chk" CHECK (("status" = 'approved') = ("approved_at" IS NOT NULL) OR "status" = 'archived')
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketing_templates_status_idx" ON "marketing_templates" ("status", "name");--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD COLUMN IF NOT EXISTS "template_id" uuid REFERENCES "marketing_templates"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "marketing_sends" DROP CONSTRAINT IF EXISTS "marketing_sends_status_chk";--> statement-breakpoint
ALTER TABLE "marketing_sends" ADD CONSTRAINT "marketing_sends_status_chk" CHECK ("status" in ('queued', 'skipped', 'test', 'holdout'));--> statement-breakpoint
ALTER TABLE "marketing_sends" ADD COLUMN IF NOT EXISTS "variant" text;--> statement-breakpoint
ALTER TABLE "marketing_sends" DROP CONSTRAINT IF EXISTS "marketing_sends_variant_chk";--> statement-breakpoint
ALTER TABLE "marketing_sends" ADD CONSTRAINT "marketing_sends_variant_chk" CHECK ("variant" IS NULL OR "variant" in ('a', 'b'));--> statement-breakpoint
ALTER TABLE "marketing_sends" ADD COLUMN IF NOT EXISTS "opens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "marketing_sends" ADD COLUMN IF NOT EXISTS "opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "marketing_sends" ADD COLUMN IF NOT EXISTS "already_booked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketing_sends_campaign_status_idx" ON "marketing_sends" ("campaign_id", "status");--> statement-breakpoint
ALTER TABLE "promo_codes" ADD COLUMN IF NOT EXISTS "days_of_week" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD COLUMN IF NOT EXISTS "time_from" text;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD COLUMN IF NOT EXISTS "time_to" text;--> statement-breakpoint
ALTER TABLE "promo_codes" DROP CONSTRAINT IF EXISTS "promo_codes_time_window_chk";--> statement-breakpoint
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_time_window_chk" CHECK (("time_from" IS NULL) = ("time_to" IS NULL) AND ("time_from" IS NULL OR ("time_from" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "time_to" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "time_from" < "time_to")));--> statement-breakpoint
INSERT INTO "marketing_templates" ("name", "campaign_type", "description", "channels", "templates", "status", "approved_at")
SELECT v.name, v.campaign_type, v.description, '["sms","email","push"]'::jsonb, v.templates::jsonb, 'approved', now()
FROM (VALUES
	('New hours', 'update', 'A change to a location''s hours.', '{"sms":"{shop}: Hi {first_name}, our hours are changing. See the new times and book: {book_link} Reply STOP to opt out.","emailSubject":"New hours at {shop}","emailBody":"Hi {first_name},\n\nOur hours at {shop} are changing. See the new times and grab a spot that suits you: {book_link}","pushTitle":"New hours at {shop}","pushBody":"See the new times and book."}'),
	('Holiday closing', 'update', 'Closed for a holiday; book before or after.', '{"sms":"{shop}: Heads up {first_name}, we''re closed for the holiday. Book before or after: {book_link} Reply STOP to opt out.","emailSubject":"Holiday hours at {shop}","emailBody":"Hi {first_name},\n\n{shop} is closed for the holiday. Book a time before or after so you''re fresh for it: {book_link}","pushTitle":"Holiday hours","pushBody":"Book before or after the holiday."}'),
	('Seasonal promotion', 'promotion', 'A limited-time offer with a promo code.', '{"sms":"{shop}: {first_name}, this one''s for you: {coupon_code} on your next cut, till {expiry}. Book: {book_link} Reply STOP to opt out.","emailSubject":"A little something from {shop}","emailBody":"Hi {first_name},\n\nUse {coupon_code} on your next visit, good till {expiry}. Book here: {book_link}","pushTitle":"An offer from {shop}","pushBody":"Use {coupon_code} till {expiry}."}'),
	('Refer a friend', 'promotion', 'Thank regulars and offer a code to share.', '{"sms":"{shop}: Thanks for being a regular, {first_name}! Bring a friend and use {coupon_code} till {expiry}: {book_link} Reply STOP to opt out.","emailSubject":"Bring a friend to {shop}","emailBody":"Hi {first_name},\n\nThanks for being a regular. Bring a friend and use {coupon_code}, good till {expiry}. Book: {book_link}","pushTitle":"Bring a friend","pushBody":"Use {coupon_code} till {expiry}."}')
) AS v(name, campaign_type, description, templates)
WHERE NOT EXISTS (SELECT 1 FROM "marketing_templates");
