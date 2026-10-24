-- Shop login parity with Squire, tighter: the cash drawer opens with a counted balance (each shop's default, $300 to start) and records cash paid in and out, so the drawer page shows the balance through the day; a paid ticket can be reassigned to another barber (sale_reassignments), with its sales and tips; refunds and voids record the manager whose PIN approved them; the phone operator answers a shop's number after hours or when nobody picks up (shops.phone_operator, call_logs.operator and operator_choice); brand_settings.shop_login caps the client contact details shop logins see (masked to start) and brand_settings.tax_filing says how often each state's sales tax is filed. Adds the Shop Login role and the new permissions to the built-in roles. Additive only.
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "drawer_opening_cents" integer DEFAULT 30000 NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "phone_operator" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_settings" ADD COLUMN IF NOT EXISTS "shop_login" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_settings" ADD COLUMN IF NOT EXISTS "tax_filing" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_drawers" ADD COLUMN IF NOT EXISTS "opened_by" uuid;--> statement-breakpoint
ALTER TABLE "cash_drawers" ADD COLUMN IF NOT EXISTS "opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN IF NOT EXISTS "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "void_approved_by" uuid;--> statement-breakpoint
ALTER TABLE "call_logs" ADD COLUMN IF NOT EXISTS "operator" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "call_logs" ADD COLUMN IF NOT EXISTS "operator_choice" text;--> statement-breakpoint
CREATE TABLE "cash_drawer_moves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id"),
	"business_date" date NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"reason" text NOT NULL,
	"staff_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_drawer_moves_kind" CHECK ("kind" in ('paid_in', 'paid_out')),
	CONSTRAINT "cash_drawer_moves_amount" CHECK ("amount_cents" > 0)
);--> statement-breakpoint
CREATE INDEX "cash_drawer_moves_shop_date_idx" ON "cash_drawer_moves" USING btree ("shop_id","business_date");--> statement-breakpoint
CREATE TABLE "sale_reassignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_id" uuid NOT NULL REFERENCES "sales"("id"),
	"shop_id" uuid NOT NULL REFERENCES "shops"("id"),
	"from_staff_id" uuid REFERENCES "staff"("id"),
	"to_staff_id" uuid NOT NULL REFERENCES "staff"("id"),
	"reason" text NOT NULL,
	"tip_cents" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "sale_reassignments_sale_idx" ON "sale_reassignments" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "sale_reassignments_shop_idx" ON "sale_reassignments" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE TRIGGER "cash_drawer_moves_scrub_sensitive" BEFORE INSERT OR UPDATE OF "reason" ON "cash_drawer_moves" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('reason');--> statement-breakpoint
CREATE TRIGGER "sale_reassignments_scrub_sensitive" BEFORE INSERT OR UPDATE OF "reason" ON "sale_reassignments" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('reason');--> statement-breakpoint
INSERT INTO "roles" ("key", "name", "description", "permissions", "max_discount_pct", "default_scope", "sort_order")
SELECT 'shop_login', 'Shop Login',
	'The shared front-desk login for one shop: the calendar, waitlist, checkout, the drawer, clients with masked contact details, the front-desk clock and the shop''s reports. Refunds, voids and reassigning tickets need a manager''s PIN; no exports.',
	'["calendar.manage","walkins.manage","blocks.others","checkout.any","pos.discount","sales.view","drawer.manage","clients.view_all","clients.message","clients.edit","clients.filters","reports.all_staff","callins.outreach","inbox.view","timeclock.kiosk","campaign_center.openings","report.sales_summary.view","report.end_of_day.view","report.sales_by_barber.view","report.leaderboard.view","report.services_vs_products.view","report.tips_payroll.view","report.card_vs_cash.view","report.sales_tax.view","report.discounts_refunds.view","report.gift_cards.view","report.kpis.view","report.retention.view","report.acquisition.view","report.staffing.view","report.phone_operator.view","report.attendance.view","report.cash_drawer.view"]'::jsonb,
	10, 'one', 55
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "key" = 'shop_login');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["sales.reassign","staff.contact","settings.shop_details","settings.shop_hours","settings.shop_booking","settings.shop_checkout","settings.shop_phone","report.end_of_day.view","report.end_of_day.export","report.leaderboard.view","report.leaderboard.export","report.sales_tax.view","report.sales_tax.export","report.retention.view","report.retention.export","report.acquisition.view","report.acquisition.export","report.phone_operator.view","report.phone_operator.export"]'::jsonb WHERE "key" = 'brand_admin' AND NOT ("permissions" ? 'sales.reassign');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["sales.reassign","staff.contact","report.end_of_day.view","report.end_of_day.export","report.leaderboard.view","report.leaderboard.export","report.sales_tax.view","report.sales_tax.export","report.retention.view","report.retention.export","report.acquisition.view","report.acquisition.export","report.phone_operator.view","report.phone_operator.export"]'::jsonb WHERE "key" IN ('regional_manager', 'shop_manager') AND NOT ("permissions" ? 'sales.reassign');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["report.end_of_day.view"]'::jsonb WHERE "key" = 'front_desk' AND NOT ("permissions" ? 'report.end_of_day.view');
