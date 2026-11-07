-- Owner entities, lightly: Ray'z Corporate by default, franchisees as another kind, people scoped to an entity, and an entity-level Stripe account.
ALTER TABLE "owner_entities" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "owner_entities" ADD CONSTRAINT "owner_entities_kind" CHECK ("kind" IN ('brand', 'franchisee'));--> statement-breakpoint
ALTER TABLE "owner_entities" ADD CONSTRAINT "owner_entities_default_brand" CHECK (NOT "is_default" OR "kind" = 'brand');--> statement-breakpoint
CREATE UNIQUE INDEX "owner_entities_one_default" ON "owner_entities" USING btree ("is_default") WHERE "is_default";--> statement-breakpoint
-- The oldest brand entity becomes Ray'z Corporate; the name core_0020 gave it automatically is replaced, a name someone chose is kept.
UPDATE "owner_entities" SET "is_default" = true WHERE "id" = (SELECT "id" FROM "owner_entities" WHERE "kind" = 'brand' ORDER BY "created_at", "id" LIMIT 1);--> statement-breakpoint
UPDATE "owner_entities" SET "name" = 'Ray''z Corporate', "updated_at" = now() WHERE "is_default" AND "name" = coalesce((SELECT "name" FROM "brand_settings" WHERE "id" = 1), 'Ray''z Barber Shop');--> statement-breakpoint
CREATE OR REPLACE FUNCTION "rayz_corporate_entity"() RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE e uuid;
BEGIN
  SELECT "id" INTO e FROM "owner_entities" WHERE "is_default" LIMIT 1;
  IF e IS NULL THEN
    INSERT INTO "owner_entities" ("name", "kind", "is_default") VALUES ('Ray''z Corporate', 'brand', true) RETURNING "id" INTO e;
  END IF;
  RETURN e;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "shops_default_owner"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."owner_entity_id" IS NULL THEN NEW."owner_entity_id" := "rayz_corporate_entity"(); END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "shops_default_owner" BEFORE INSERT OR UPDATE OF "owner_entity_id" ON "shops" FOR EACH ROW EXECUTE FUNCTION "shops_default_owner"();--> statement-breakpoint
UPDATE "shops" SET "owner_entity_id" = "rayz_corporate_entity"() WHERE "owner_entity_id" IS NULL;--> statement-breakpoint
ALTER TABLE "shops" ALTER COLUMN "owner_entity_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "shops_owner_entity_idx" ON "shops" USING btree ("owner_entity_id");--> statement-breakpoint
-- An owner entity's own Stripe Connect account; shops in payments mode 'entity' settle there.
CREATE TABLE "entity_payment_accounts" (
	"owner_entity_id" uuid PRIMARY KEY NOT NULL REFERENCES "owner_entities"("id"),
	"stripe_account_id" text NOT NULL,
	"simulated" boolean DEFAULT false NOT NULL,
	"charges_enabled" boolean DEFAULT false NOT NULL,
	"payouts_enabled" boolean DEFAULT false NOT NULL,
	"details_submitted" boolean DEFAULT false NOT NULL,
	"requirements_due" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"disabled_reason" text,
	"payout_schedule" jsonb,
	"deauthorized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_payment_accounts_stripe_account_id_unique" UNIQUE("stripe_account_id")
);--> statement-breakpoint
CREATE TRIGGER "entity_payment_accounts_scrub_sensitive" BEFORE INSERT OR UPDATE OF "disabled_reason" ON "entity_payment_accounts" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('disabled_reason');--> statement-breakpoint
ALTER TABLE "shops" DROP CONSTRAINT "shops_payments_mode";--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_payments_mode" CHECK ("payments_mode" IN ('brand', 'connected', 'entity', 'cash_only'));--> statement-breakpoint
ALTER TABLE "shop_payouts" ADD COLUMN "owner_entity_id" uuid REFERENCES "owner_entities"("id");--> statement-breakpoint
CREATE INDEX "shop_payouts_entity_arrival_idx" ON "shop_payouts" USING btree ("owner_entity_id","arrival_date");--> statement-breakpoint
ALTER TABLE "shop_payouts" DROP CONSTRAINT "shop_payouts_owner";--> statement-breakpoint
ALTER TABLE "shop_payouts" ADD CONSTRAINT "shop_payouts_owner" CHECK ("shop_id" IS NOT NULL OR "owner_entity_id" IS NOT NULL OR "stripe_account_id" = 'platform');--> statement-breakpoint
-- People and roles scoped to an owner entity; their staff_access_shops rows are exactly that entity's shops.
ALTER TABLE "staff" ADD COLUMN "scope_entity_id" uuid REFERENCES "owner_entities"("id");--> statement-breakpoint
ALTER TABLE "staff" DROP CONSTRAINT "staff_shop_scope_valid";--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_shop_scope_valid" CHECK ("shop_scope" IN ('all', 'entity', 'selected', 'one'));--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_scope_entity" CHECK ("shop_scope" <> 'entity' OR "scope_entity_id" IS NOT NULL);--> statement-breakpoint
CREATE INDEX "staff_scope_entity_idx" ON "staff" USING btree ("scope_entity_id") WHERE "shop_scope" = 'entity';--> statement-breakpoint
ALTER TABLE "roles" DROP CONSTRAINT "roles_default_scope_valid";--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_default_scope_valid" CHECK ("default_scope" IN ('all', 'entity', 'selected', 'one'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION "sync_entity_access"(p_staff uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s record;
BEGIN
  SELECT "shop_scope", "scope_entity_id" INTO s FROM "staff" WHERE "id" = p_staff;
  IF NOT FOUND OR s."shop_scope" <> 'entity' THEN RETURN; END IF;
  DELETE FROM "staff_access_shops" a WHERE a."staff_id" = p_staff
    AND NOT EXISTS (SELECT 1 FROM "shops" sh WHERE sh."id" = a."shop_id" AND sh."owner_entity_id" = s."scope_entity_id");
  INSERT INTO "staff_access_shops" ("staff_id", "shop_id")
    SELECT p_staff, sh."id" FROM "shops" sh WHERE sh."owner_entity_id" = s."scope_entity_id"
    ON CONFLICT DO NOTHING;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "staff_entity_access"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'staff' THEN
    PERFORM "sync_entity_access"(NEW."id");
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM "sync_entity_access"(OLD."staff_id");
  ELSE
    PERFORM "sync_entity_access"(NEW."staff_id");
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
-- Deferred to commit, so a save that rewrites someone's shop list ends with the entity's.
CREATE CONSTRAINT TRIGGER "staff_entity_access" AFTER INSERT OR UPDATE OF "shop_scope", "scope_entity_id" ON "staff" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "staff_entity_access"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "staff_access_shops_entity" AFTER INSERT OR DELETE ON "staff_access_shops" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "staff_entity_access"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "shops_entity_access"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "staff_access_shops" a USING "staff" s
    WHERE a."shop_id" = NEW."id" AND s."id" = a."staff_id" AND s."shop_scope" = 'entity' AND s."scope_entity_id" IS DISTINCT FROM NEW."owner_entity_id";
  INSERT INTO "staff_access_shops" ("staff_id", "shop_id")
    SELECT s."id", NEW."id" FROM "staff" s WHERE s."shop_scope" = 'entity' AND s."scope_entity_id" = NEW."owner_entity_id"
    ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER "shops_entity_access" AFTER INSERT OR UPDATE OF "owner_entity_id" ON "shops" FOR EACH ROW EXECUTE FUNCTION "shops_entity_access"();--> statement-breakpoint
-- Role templates: Franchisee Owner and Franchisee Manager, scoped to an owner entity.
INSERT INTO "roles" ("key", "name", "description", "permissions", "max_discount_pct", "default_scope", "sort_order")
SELECT 'franchisee_owner', 'Franchisee Owner',
	'Owns a franchisee business (an owner entity) and runs all its locations: everything a regional manager does there, plus voiding gift cards and managing its people''s access. Brand-wide settings, the catalog, client exports and Stripe setup stay the brand''s.',
	'["calendar.manage","walkins.manage","schedules.edit","checkout.any","pos.discount","pos.price_override","handoff.unlock","sales.view","sales.refund","sales.reassign","drawer.manage","giftcards.issue","clients.view_all","clients.reveal","clients.message","clients.edit","clients.family","clients.rate","clients.ratings_all","clients.filters","clients.saved_searches","notes.view","notes.write","notes.edit_any","notes.private","catalog.prices","inventory.manage","inventory.adjust","inventory.transfer","inventory.stocktake","po.create","po.send","po.receive","staff.manage","staff.contact","settings.shop","scheduling.timing","calendar.squeeze_in","service_times.correct","blocks.own","blocks.others","timeoff.request","timeoff.approve","blocks.private","blocks.reasons","callins.mark","callins.outreach","callins.voice","inbox.view","notifications.view","reports.all_staff","clients.campaigns","campaign_center.openings","timeclock.punch","timeclock.kiosk","timesheet.own","timesheet.edit","timesheet.approve","tips.own","tips.approve","devices.approve","report_builder.view","report_builder.build","report_builder.export","logins.manage","po.approve","giftcards.void","permissions.manage","report.my_sales.view","report.my_sales.export","report.sales_summary.view","report.sales_summary.export","report.end_of_day.view","report.end_of_day.export","report.sales_by_barber.view","report.sales_by_barber.export","report.leaderboard.view","report.leaderboard.export","report.services_vs_products.view","report.services_vs_products.export","report.tips_payroll.view","report.tips_payroll.export","report.card_vs_cash.view","report.card_vs_cash.export","report.sales_tax.view","report.sales_tax.export","report.shop_accounts.view","report.shop_accounts.export","report.rollup.view","report.rollup.export","report.discounts_refunds.view","report.discounts_refunds.export","report.inventory.view","report.inventory.export","report.inventory_movement.view","report.inventory_movement.export","report.sell_through.view","report.sell_through.export","report.low_stock.view","report.low_stock.export","report.purchasing.view","report.purchasing.export","report.gift_cards.view","report.gift_cards.export","report.loyalty.view","report.loyalty.export","report.client_ratings.view","report.kpis.view","report.kpis.export","report.operations.view","report.operations.export","report.checkout_prompts.view","report.checkout_prompts.export","report.retention.view","report.retention.export","report.acquisition.view","report.acquisition.export","report.heatmap.view","report.heatmap.export","report.service_times.view","report.service_times.export","report.staffing.view","report.staffing.export","report.call_ins.view","report.call_ins.export","report.phone_operator.view","report.phone_operator.export","report.google_reviews.view","report.google_reviews.export","report.openings.view","report.openings.export","report.labor.view","report.labor.export","report.attendance.view","report.attendance.export","report.cash_drawer.view","report.cash_drawer.export","report.tip_payouts.view","report.tip_payouts.export","report.morning_dashboard.view","report.morning_dashboard.export","report.audit_log.view","report.audit_log.export"]'::jsonb,
	100, 'entity', 30
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "key" = 'franchisee_owner');--> statement-breakpoint
INSERT INTO "roles" ("key", "name", "description", "permissions", "max_discount_pct", "default_scope", "sort_order")
SELECT 'franchisee_manager', 'Franchisee Manager',
	'Manages a franchisee''s locations day to day: front desk, POS, clients, staff and shop settings, with every report for those locations but the brand''s marketing reports.',
	'["calendar.manage","walkins.manage","schedules.edit","checkout.any","pos.discount","pos.price_override","handoff.unlock","sales.view","sales.refund","sales.reassign","drawer.manage","giftcards.issue","clients.view_all","clients.reveal","clients.message","clients.edit","clients.family","clients.rate","clients.ratings_all","clients.filters","clients.saved_searches","notes.view","notes.write","notes.edit_any","notes.private","catalog.prices","inventory.manage","inventory.adjust","inventory.transfer","inventory.stocktake","po.create","po.send","po.receive","staff.manage","staff.contact","settings.shop","scheduling.timing","calendar.squeeze_in","service_times.correct","blocks.own","blocks.others","timeoff.request","timeoff.approve","blocks.private","blocks.reasons","callins.mark","callins.outreach","callins.voice","inbox.view","notifications.view","reports.all_staff","clients.campaigns","campaign_center.openings","timeclock.punch","timeclock.kiosk","timesheet.own","timesheet.edit","timesheet.approve","tips.own","tips.approve","devices.approve","report_builder.view","report_builder.build","report_builder.export","logins.manage","po.approve","report.my_sales.view","report.my_sales.export","report.sales_summary.view","report.sales_summary.export","report.end_of_day.view","report.end_of_day.export","report.sales_by_barber.view","report.sales_by_barber.export","report.leaderboard.view","report.leaderboard.export","report.services_vs_products.view","report.services_vs_products.export","report.tips_payroll.view","report.tips_payroll.export","report.card_vs_cash.view","report.card_vs_cash.export","report.sales_tax.view","report.sales_tax.export","report.shop_accounts.view","report.shop_accounts.export","report.rollup.view","report.rollup.export","report.discounts_refunds.view","report.discounts_refunds.export","report.inventory.view","report.inventory.export","report.inventory_movement.view","report.inventory_movement.export","report.sell_through.view","report.sell_through.export","report.low_stock.view","report.low_stock.export","report.purchasing.view","report.purchasing.export","report.gift_cards.view","report.gift_cards.export","report.loyalty.view","report.loyalty.export","report.client_ratings.view","report.kpis.view","report.kpis.export","report.operations.view","report.operations.export","report.checkout_prompts.view","report.checkout_prompts.export","report.retention.view","report.retention.export","report.acquisition.view","report.acquisition.export","report.heatmap.view","report.heatmap.export","report.service_times.view","report.service_times.export","report.staffing.view","report.staffing.export","report.call_ins.view","report.call_ins.export","report.phone_operator.view","report.phone_operator.export","report.google_reviews.view","report.google_reviews.export","report.openings.view","report.openings.export","report.labor.view","report.labor.export","report.attendance.view","report.attendance.export","report.cash_drawer.view","report.cash_drawer.export","report.tip_payouts.view","report.tip_payouts.export","report.morning_dashboard.view","report.morning_dashboard.export","report.audit_log.view","report.audit_log.export"]'::jsonb,
	100, 'entity', 40
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "key" = 'franchisee_manager');--> statement-breakpoint
UPDATE "roles" SET "sort_order" = 50 WHERE "key" = 'regional_manager';--> statement-breakpoint
UPDATE "roles" SET "sort_order" = 60 WHERE "key" = 'shop_manager';--> statement-breakpoint
UPDATE "roles" SET "sort_order" = 70 WHERE "key" = 'front_desk';--> statement-breakpoint
UPDATE "roles" SET "sort_order" = 80 WHERE "key" = 'shop_login';--> statement-breakpoint
UPDATE "roles" SET "sort_order" = 90 WHERE "key" = 'barber';
