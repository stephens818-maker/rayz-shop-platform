-- Lapsed-client targeting: multi-step lapsed sequences (a campaign kind with its steps, each with its own wording and coupon, and which step each message was), barbers messaging their own lapsed clients ("Campaign Center: own lapsed clients"), and the lapsed clients by barber report. The kind check only widens: every existing row still passes.
ALTER TABLE "marketing_campaigns" DROP CONSTRAINT "marketing_campaigns_kind_chk";--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_kind_chk" CHECK ("kind" in ('trigger', 'blast', 'sequence') and ("kind" = 'trigger') = ("trigger" is not null));--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD COLUMN "enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE "marketing_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL REFERENCES "marketing_campaigns"("id") ON DELETE cascade,
	"position" integer NOT NULL,
	"after_days" integer NOT NULL,
	"templates" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"promo_id" uuid REFERENCES "promo_codes"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketing_steps_after_days_chk" CHECK ("after_days" between 7 and 365)
);--> statement-breakpoint
CREATE UNIQUE INDEX "marketing_steps_position_uq" ON "marketing_steps" ("campaign_id", "position");--> statement-breakpoint
ALTER TABLE "marketing_sends" ADD COLUMN "step_id" uuid REFERENCES "marketing_steps"("id") ON DELETE set null;--> statement-breakpoint
CREATE INDEX "marketing_sends_step_idx" ON "marketing_sends" ("step_id") WHERE "step_id" is not null;--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["campaign_center.own_clients"]'::jsonb WHERE "key" IN ('brand_admin', 'regional_manager', 'shop_manager') AND "permissions" ? 'campaign_center.view' AND NOT ("permissions" ? 'campaign_center.own_clients');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["report.lapsed_clients.view","report.lapsed_clients.export"]'::jsonb WHERE "key" IN ('brand_admin', 'regional_manager', 'shop_manager') AND "permissions" ? 'report.campaign_center.view' AND NOT ("permissions" ? 'report.lapsed_clients.view');
