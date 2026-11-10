-- Roles and permissions: dollar limits per role and per person, overrides that end on a date, a
-- region as a shop scope, roles that belong to one owner entity, separate void / read-only
-- calendar / read-only staff / QuickBooks permissions, and the Bookkeeper and Marketing templates.
ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "money_limits" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "owner_entity_id" uuid REFERENCES "owner_entities"("id");--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "money_limits" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "permission_override_expires" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "scope_region_id" uuid REFERENCES "regions"("id");--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_money_limits_object" CHECK (jsonb_typeof("money_limits") = 'object');--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_money_limits_object" CHECK (jsonb_typeof("money_limits") = 'object');--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_override_expires_object" CHECK (jsonb_typeof("permission_override_expires") = 'object');--> statement-breakpoint
ALTER TABLE "staff" DROP CONSTRAINT "staff_shop_scope_valid";--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_shop_scope_valid" CHECK ("shop_scope" IN ('all', 'entity', 'region', 'selected', 'one'));--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_scope_region" CHECK ("shop_scope" <> 'region' OR "scope_region_id" IS NOT NULL);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_scope_region_idx" ON "staff" USING btree ("scope_region_id") WHERE "shop_scope" = 'region';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "roles_owner_entity_idx" ON "roles" USING btree ("owner_entity_id") WHERE "owner_entity_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "roles" DROP CONSTRAINT "roles_default_scope_valid";--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_default_scope_valid" CHECK ("default_scope" IN ('all', 'entity', 'region', 'selected', 'one'));--> statement-breakpoint
-- A region person's staff_access_shops rows are exactly the region's shops, like an entity person's.
CREATE OR REPLACE FUNCTION "sync_region_access"(p_staff uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s record;
BEGIN
  SELECT "shop_scope", "scope_region_id" INTO s FROM "staff" WHERE "id" = p_staff;
  IF NOT FOUND OR s."shop_scope" <> 'region' THEN RETURN; END IF;
  DELETE FROM "staff_access_shops" a WHERE a."staff_id" = p_staff
    AND NOT EXISTS (SELECT 1 FROM "shops" sh WHERE sh."id" = a."shop_id" AND sh."region_id" = s."scope_region_id");
  INSERT INTO "staff_access_shops" ("staff_id", "shop_id")
    SELECT p_staff, sh."id" FROM "shops" sh WHERE sh."region_id" = s."scope_region_id"
    ON CONFLICT DO NOTHING;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "staff_entity_access"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p uuid;
BEGIN
  IF TG_TABLE_NAME = 'staff' THEN
    p := NEW."id";
  ELSIF TG_OP = 'DELETE' THEN
    p := OLD."staff_id";
  ELSE
    p := NEW."staff_id";
  END IF;
  PERFORM "sync_entity_access"(p);
  PERFORM "sync_region_access"(p);
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "staff_entity_access" ON "staff";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "staff_entity_access" AFTER INSERT OR UPDATE OF "shop_scope", "scope_entity_id", "scope_region_id" ON "staff" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "staff_entity_access"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "shops_region_access"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "staff_access_shops" a USING "staff" s
    WHERE a."shop_id" = NEW."id" AND s."id" = a."staff_id" AND s."shop_scope" = 'region' AND s."scope_region_id" IS DISTINCT FROM NEW."region_id";
  INSERT INTO "staff_access_shops" ("staff_id", "shop_id")
    SELECT s."id", NEW."id" FROM "staff" s WHERE s."shop_scope" = 'region' AND s."scope_region_id" = NEW."region_id"
    ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER "shops_region_access" AFTER INSERT OR UPDATE OF "region_id" ON "shops" FOR EACH ROW EXECUTE FUNCTION "shops_region_access"();--> statement-breakpoint
-- New permissions split out of old ones, so nobody gains or loses anything: seeing every column
-- read-only (calendar.manage included it), voiding (sales.refund covered it), seeing staff
-- profiles (staff.manage included it) and the QuickBooks download (the Sales summary had it).
UPDATE "roles" SET "permissions" = "permissions" || '["calendar.view_all"]'::jsonb WHERE "permissions" ? 'calendar.manage' AND NOT "permissions" ? 'calendar.view_all';--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["sales.void"]'::jsonb WHERE "permissions" ? 'sales.refund' AND NOT "permissions" ? 'sales.void';--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["staff.view"]'::jsonb WHERE "permissions" ? 'staff.manage' AND NOT "permissions" ? 'staff.view';--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["exports.accounting"]'::jsonb WHERE "key" IN ('brand_admin', 'franchisee_owner') AND NOT "permissions" ? 'exports.accounting';--> statement-breakpoint
UPDATE "staff" SET "permission_overrides" = "permission_overrides" || jsonb_build_object('sales.void', "permission_overrides"->'sales.refund') WHERE "permission_overrides" ? 'sales.refund' AND NOT "permission_overrides" ? 'sales.void';--> statement-breakpoint
UPDATE "staff" SET "permission_overrides" = "permission_overrides" || '{"calendar.view_all": false}'::jsonb WHERE "permission_overrides"->'calendar.manage' = 'false'::jsonb AND NOT "permission_overrides" ? 'calendar.view_all';--> statement-breakpoint
UPDATE "staff" SET "permission_overrides" = "permission_overrides" || '{"staff.view": false}'::jsonb WHERE "permission_overrides"->'staff.manage' = 'false'::jsonb AND NOT "permission_overrides" ? 'staff.view';--> statement-breakpoint
-- The same for a shop's own version of a role.
UPDATE "shop_sync_state" SET "local" = jsonb_set("local", '{permissions}', ("local"->'permissions') || '["calendar.view_all"]'::jsonb)
  WHERE "key" LIKE 'role:%' AND jsonb_typeof("local"->'permissions') = 'array' AND "local"->'permissions' ? 'calendar.manage' AND NOT "local"->'permissions' ? 'calendar.view_all';--> statement-breakpoint
UPDATE "shop_sync_state" SET "local" = jsonb_set("local", '{permissions}', ("local"->'permissions') || '["sales.void"]'::jsonb)
  WHERE "key" LIKE 'role:%' AND jsonb_typeof("local"->'permissions') = 'array' AND "local"->'permissions' ? 'sales.refund' AND NOT "local"->'permissions' ? 'sales.void';--> statement-breakpoint
UPDATE "shop_sync_state" SET "local" = jsonb_set("local", '{permissions}', ("local"->'permissions') || '["staff.view"]'::jsonb)
  WHERE "key" LIKE 'role:%' AND jsonb_typeof("local"->'permissions') = 'array' AND "local"->'permissions' ? 'staff.manage' AND NOT "local"->'permissions' ? 'staff.view';--> statement-breakpoint
UPDATE "shop_sync_state" st SET "local" = jsonb_set(st."local", '{permissions}', (st."local"->'permissions') || '["exports.accounting"]'::jsonb)
  FROM "roles" r WHERE st."key" = 'role:' || r."id"::text AND r."key" IN ('brand_admin', 'franchisee_owner')
  AND jsonb_typeof(st."local"->'permissions') = 'array' AND NOT st."local"->'permissions' ? 'exports.accounting';--> statement-breakpoint
-- Custom roles already called what a template is about to be called keep working under a new name.
UPDATE "roles" SET "name" = "name" || ' (custom)', "updated_at" = now()
  WHERE lower("name") IN ('bookkeeper', 'marketing', 'regional / district manager') AND "key" IS DISTINCT FROM 'bookkeeper' AND "key" IS DISTINCT FROM 'marketing' AND "key" IS DISTINCT FROM 'regional_manager';--> statement-breakpoint
UPDATE "roles" SET "name" = 'Regional / District Manager' WHERE "key" = 'regional_manager' AND "name" = 'Regional Manager';--> statement-breakpoint
INSERT INTO "roles" ("key", "name", "description", "permissions", "max_discount_pct", "default_scope", "sort_order")
SELECT 'bookkeeper', 'Bookkeeper',
	'Keeps the books: sales, tax, card fees, P&L by Stripe account and payouts, payroll and tip reports, and the payroll and QuickBooks downloads. Sees tickets but no client contact details, and can''t check out, refund or change settings.',
	'["sales.view","reports.all_staff","staff.view","payroll.rates","payroll.export","exports.accounting","report.sales_summary.view","report.sales_summary.export","report.end_of_day.view","report.end_of_day.export","report.services_vs_products.view","report.services_vs_products.export","report.tips_payroll.view","report.tips_payroll.export","report.card_vs_cash.view","report.card_vs_cash.export","report.sales_tax.view","report.sales_tax.export","report.card_fees.view","report.card_fees.export","report.shop_accounts.view","report.shop_accounts.export","report.rollup.view","report.rollup.export","report.discounts_refunds.view","report.discounts_refunds.export","report.inventory.view","report.inventory.export","report.inventory_movement.view","report.inventory_movement.export","report.purchasing.view","report.purchasing.export","report.gift_cards.view","report.gift_cards.export","report.labor.view","report.labor.export","report.commission_payout.view","report.commission_payout.export","report.cash_drawer.view","report.cash_drawer.export","report.tip_payouts.view","report.tip_payouts.export"]'::jsonb,
	0, 'all', 100
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "key" = 'bookkeeper');--> statement-breakpoint
INSERT INTO "roles" ("key", "name", "description", "permissions", "max_discount_pct", "default_scope", "sort_order")
SELECT 'marketing', 'Marketing',
	'Runs the Campaign Center: automated campaigns, blasts, coupons and We have openings, with the marketing reports. Sends only to clients who agreed to marketing and sees counts, never client contact details, unless the brand gives contact access.',
	'["campaign_center.openings","campaign_center.view","campaign_center.create","campaign_center.send","promos.manage","reports.all_staff","report.campaign_center.view","report.campaign_center.export","report.openings.view","report.openings.export","report.lapsed_clients.view","report.lapsed_clients.export","report.google_reviews.view","report.google_reviews.export","report.acquisition.view","report.acquisition.export","report.retention.view","report.retention.export","report.rebook_rate.view","report.rebook_rate.export"]'::jsonb,
	0, 'all', 110
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "key" = 'marketing');
