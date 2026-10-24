-- Franchising: Brand > owner group (owner_entities) > region (optional) > location.
-- Owner groups: status, payroll company code, tax settings. Tax IDs and bank details stay with Stripe.
ALTER TABLE "owner_entities" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "owner_entities" ADD COLUMN "payroll_company_code" text;--> statement-breakpoint
ALTER TABLE "owner_entities" ADD COLUMN "tax_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "owner_entities" ADD CONSTRAINT "owner_entities_kind" CHECK ("kind" IN ('brand', 'franchisee'));--> statement-breakpoint
ALTER TABLE "owner_entities" ADD CONSTRAINT "owner_entities_status" CHECK ("status" IN ('onboarding', 'active', 'exited'));--> statement-breakpoint
-- Rayz corporate: the oldest brand-kind owner group, created when there's none.
CREATE OR REPLACE FUNCTION "rayz_corporate_entity"() RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE e uuid;
BEGIN
  SELECT "id" INTO e FROM "owner_entities" WHERE "kind" = 'brand' ORDER BY "created_at", "id" LIMIT 1;
  IF e IS NULL THEN
    INSERT INTO "owner_entities" ("name", "kind") VALUES (coalesce((SELECT "name" FROM "brand_settings" WHERE "id" = 1), 'Ray''z Barber Shop'), 'brand') RETURNING "id" INTO e;
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
-- Regions and markets. With an owner group it's that group's own; without, a brand market across owners.
CREATE TABLE "regions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"owner_entity_id" uuid REFERENCES "owner_entities"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "regions_slug_unique" UNIQUE("slug")
);--> statement-breakpoint
CREATE INDEX "regions_entity_idx" ON "regions" USING btree ("owner_entity_id");--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "region_id" uuid REFERENCES "regions"("id");--> statement-breakpoint
CREATE INDEX "shops_region_idx" ON "shops" USING btree ("region_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "shops_region_fit"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner uuid;
BEGIN
  IF NEW."region_id" IS NOT NULL THEN
    SELECT "owner_entity_id" INTO owner FROM "regions" WHERE "id" = NEW."region_id";
    IF owner IS NOT NULL AND owner IS DISTINCT FROM NEW."owner_entity_id" THEN
      RAISE EXCEPTION 'region % belongs to another owner group', NEW."region_id" USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "shops_region_fit" BEFORE INSERT OR UPDATE OF "region_id", "owner_entity_id" ON "shops" FOR EACH ROW EXECUTE FUNCTION "shops_region_fit"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "regions_owner_fit"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."owner_entity_id" IS NOT NULL AND EXISTS (SELECT 1 FROM "shops" WHERE "region_id" = NEW."id" AND "owner_entity_id" IS DISTINCT FROM NEW."owner_entity_id") THEN
    RAISE EXCEPTION 'region % has locations of another owner group', NEW."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "regions_owner_fit" BEFORE UPDATE OF "owner_entity_id" ON "regions" FOR EACH ROW EXECUTE FUNCTION "regions_owner_fit"();--> statement-breakpoint
-- An owner group's Stripe Connect account; shops in payments mode 'entity' settle here.
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
ALTER TABLE "shops" DROP CONSTRAINT "shops_payments_mode";--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_payments_mode" CHECK ("payments_mode" IN ('brand', 'connected', 'entity', 'cash_only'));--> statement-breakpoint
ALTER TABLE "shop_payouts" ADD COLUMN "owner_entity_id" uuid REFERENCES "owner_entities"("id");--> statement-breakpoint
CREATE INDEX "shop_payouts_entity_arrival_idx" ON "shop_payouts" USING btree ("owner_entity_id","arrival_date");--> statement-breakpoint
ALTER TABLE "shop_payouts" DROP CONSTRAINT "shop_payouts_owner";--> statement-breakpoint
ALTER TABLE "shop_payouts" ADD CONSTRAINT "shop_payouts_owner" CHECK ("shop_id" IS NOT NULL OR "owner_entity_id" IS NOT NULL OR "stripe_account_id" = 'platform');--> statement-breakpoint
-- Royalty and ad fund rates per owner group from a date, never rewritten.
CREATE TABLE "entity_fee_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_entity_id" uuid NOT NULL REFERENCES "owner_entities"("id"),
	"effective_from" date NOT NULL,
	"royalty_bps" integer DEFAULT 0 NOT NULL,
	"ad_fund_bps" integer DEFAULT 0 NOT NULL,
	"collect" text DEFAULT 'application_fee' NOT NULL,
	"created_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_fee_terms_uq" UNIQUE("owner_entity_id","effective_from"),
	CONSTRAINT "entity_fee_terms_bps" CHECK ("royalty_bps" BETWEEN 0 AND 3000 AND "ad_fund_bps" BETWEEN 0 AND 3000),
	CONSTRAINT "entity_fee_terms_collect" CHECK ("collect" IN ('application_fee', 'invoice'))
);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "royalty_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "ad_fund_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Who owned a shop when (valid_to exclusive), kept by trigger, so royalties and owner reports follow a resale.
CREATE TABLE "shop_owner_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
	"owner_entity_id" uuid NOT NULL REFERENCES "owner_entities"("id"),
	"valid_from" date NOT NULL,
	"valid_to" date
);--> statement-breakpoint
CREATE INDEX "shop_owner_history_shop_idx" ON "shop_owner_history" USING btree ("shop_id","valid_from");--> statement-breakpoint
CREATE INDEX "shop_owner_history_entity_idx" ON "shop_owner_history" USING btree ("owner_entity_id");--> statement-breakpoint
INSERT INTO "shop_owner_history" ("shop_id", "owner_entity_id", "valid_from") SELECT "id", "owner_entity_id", DATE '2000-01-01' FROM "shops";--> statement-breakpoint
CREATE OR REPLACE FUNCTION "shops_owner_history"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  today date := (now() AT TIME ZONE coalesce(NEW."timezone", 'America/Chicago'))::date;
  cur record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "shop_owner_history" ("shop_id", "owner_entity_id", "valid_from") VALUES (NEW."id", NEW."owner_entity_id", DATE '2000-01-01');
    RETURN NEW;
  END IF;
  IF NEW."owner_entity_id" IS NOT DISTINCT FROM OLD."owner_entity_id" THEN RETURN NEW; END IF;
  SELECT * INTO cur FROM "shop_owner_history" WHERE "shop_id" = NEW."id" AND "valid_to" IS NULL ORDER BY "valid_from" DESC LIMIT 1;
  IF cur."id" IS NOT NULL AND cur."valid_from" >= today THEN
    UPDATE "shop_owner_history" SET "owner_entity_id" = NEW."owner_entity_id" WHERE "id" = cur."id";
  ELSE
    UPDATE "shop_owner_history" SET "valid_to" = today WHERE "shop_id" = NEW."id" AND "valid_to" IS NULL;
    INSERT INTO "shop_owner_history" ("shop_id", "owner_entity_id", "valid_from") VALUES (NEW."id", NEW."owner_entity_id", today);
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "shops_owner_history" AFTER INSERT OR UPDATE OF "owner_entity_id" ON "shops" FOR EACH ROW EXECUTE FUNCTION "shops_owner_history"();--> statement-breakpoint
-- People and roles scoped to an owner group or a region; their staff_access_shops rows follow the hierarchy.
ALTER TABLE "staff" ADD COLUMN "scope_entity_id" uuid REFERENCES "owner_entities"("id");--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "scope_region_id" uuid REFERENCES "regions"("id");--> statement-breakpoint
ALTER TABLE "staff" DROP CONSTRAINT "staff_shop_scope_valid";--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_shop_scope_valid" CHECK ("shop_scope" IN ('all', 'entity', 'region', 'selected', 'one'));--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_scope_target" CHECK (("shop_scope" <> 'entity' OR "scope_entity_id" IS NOT NULL) AND ("shop_scope" <> 'region' OR "scope_region_id" IS NOT NULL));--> statement-breakpoint
CREATE INDEX "staff_scope_entity_idx" ON "staff" USING btree ("scope_entity_id") WHERE "shop_scope" = 'entity';--> statement-breakpoint
CREATE INDEX "staff_scope_region_idx" ON "staff" USING btree ("scope_region_id") WHERE "shop_scope" = 'region';--> statement-breakpoint
ALTER TABLE "roles" DROP CONSTRAINT "roles_default_scope_valid";--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_default_scope_valid" CHECK ("default_scope" IN ('all', 'entity', 'region', 'selected', 'one'));--> statement-breakpoint
-- An entity or region person's shops are exactly that owner group's or region's: rows outside go, rows inside are added.
CREATE OR REPLACE FUNCTION "sync_scope_access"(p_staff uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s record;
BEGIN
  SELECT "shop_scope", "scope_entity_id", "scope_region_id" INTO s FROM "staff" WHERE "id" = p_staff;
  IF NOT FOUND OR s."shop_scope" NOT IN ('entity', 'region') THEN RETURN; END IF;
  DELETE FROM "staff_access_shops" a WHERE a."staff_id" = p_staff AND NOT EXISTS (
    SELECT 1 FROM "shops" sh WHERE sh."id" = a."shop_id"
      AND ((s."shop_scope" = 'entity' AND sh."owner_entity_id" = s."scope_entity_id") OR (s."shop_scope" = 'region' AND sh."region_id" = s."scope_region_id")));
  INSERT INTO "staff_access_shops" ("staff_id", "shop_id")
    SELECT p_staff, sh."id" FROM "shops" sh
    WHERE (s."shop_scope" = 'entity' AND sh."owner_entity_id" = s."scope_entity_id") OR (s."shop_scope" = 'region' AND sh."region_id" = s."scope_region_id")
    ON CONFLICT DO NOTHING;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "staff_scope_access"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'staff' THEN
    PERFORM "sync_scope_access"(NEW."id");
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM "sync_scope_access"(OLD."staff_id");
  ELSE
    PERFORM "sync_scope_access"(NEW."staff_id");
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
-- Deferred to commit, so a save that rewrites someone's shop list ends with the hierarchy's.
CREATE CONSTRAINT TRIGGER "staff_scope_access" AFTER INSERT OR UPDATE OF "shop_scope", "scope_entity_id", "scope_region_id" ON "staff" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "staff_scope_access"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "staff_access_shops_scope" AFTER INSERT OR DELETE ON "staff_access_shops" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "staff_scope_access"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "shops_scope_access"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "staff_access_shops" a USING "staff" s
    WHERE a."shop_id" = NEW."id" AND s."id" = a."staff_id"
      AND ((s."shop_scope" = 'entity' AND s."scope_entity_id" IS DISTINCT FROM NEW."owner_entity_id") OR (s."shop_scope" = 'region' AND s."scope_region_id" IS DISTINCT FROM NEW."region_id"));
  INSERT INTO "staff_access_shops" ("staff_id", "shop_id")
    SELECT s."id", NEW."id" FROM "staff" s
    WHERE (s."shop_scope" = 'entity' AND s."scope_entity_id" = NEW."owner_entity_id") OR (s."shop_scope" = 'region' AND s."scope_region_id" = NEW."region_id")
    ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER "shops_scope_access" AFTER INSERT OR UPDATE OF "owner_entity_id", "region_id" ON "shops" FOR EACH ROW EXECUTE FUNCTION "shops_scope_access"();--> statement-breakpoint
-- Brand standards on the master catalog: location prices open, within a range or locked; names and durations.
ALTER TABLE "services" ADD COLUMN "local_price" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "price_floor_cents" integer;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "price_ceiling_cents" integer;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "local_name" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "local_duration" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_local_price" CHECK ("local_price" IN ('open', 'range', 'locked') AND ("price_floor_cents" IS NULL OR "price_ceiling_cents" IS NULL OR "price_floor_cents" <= "price_ceiling_cents"));--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "local_price" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "price_floor_cents" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "price_ceiling_cents" integer;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_local_price" CHECK ("local_price" IN ('open', 'range', 'locked') AND ("price_floor_cents" IS NULL OR "price_ceiling_cents" IS NULL OR "price_floor_cents" <= "price_ceiling_cents"));--> statement-breakpoint
ALTER TABLE "brand_settings" ADD COLUMN "standards" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_settings" ADD COLUMN "franchise" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- Background tasks per location (or client bucket) and day, claimed with FOR UPDATE SKIP LOCKED.
CREATE TABLE "job_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"shard" text NOT NULL,
	"run_on" date NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_tasks_uq" UNIQUE("kind","shard","run_on"),
	CONSTRAINT "job_tasks_status" CHECK ("status" IN ('queued', 'running', 'done', 'failed'))
);--> statement-breakpoint
CREATE INDEX "job_tasks_claim_idx" ON "job_tasks" USING btree ("status","locked_until");--> statement-breakpoint
-- One location's day for brand rollups, with its owner and region as of that day.
CREATE TABLE "location_daily_stats" (
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
	"day" date NOT NULL,
	"owner_entity_id" uuid REFERENCES "owner_entities"("id"),
	"region_id" uuid REFERENCES "regions"("id") ON DELETE set null,
	"tickets" integer DEFAULT 0 NOT NULL,
	"gross_cents" bigint DEFAULT 0 NOT NULL,
	"discount_cents" bigint DEFAULT 0 NOT NULL,
	"service_net_cents" bigint DEFAULT 0 NOT NULL,
	"product_net_cents" bigint DEFAULT 0 NOT NULL,
	"refund_cents" bigint DEFAULT 0 NOT NULL,
	"tax_cents" bigint DEFAULT 0 NOT NULL,
	"tip_cents" bigint DEFAULT 0 NOT NULL,
	"clients" integer DEFAULT 0 NOT NULL,
	"new_clients" integer DEFAULT 0 NOT NULL,
	"appointments" integer DEFAULT 0 NOT NULL,
	"no_shows" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "location_daily_stats_shop_id_day_pk" PRIMARY KEY("shop_id","day")
);--> statement-breakpoint
CREATE INDEX "location_daily_stats_day_idx" ON "location_daily_stats" USING btree ("day");--> statement-breakpoint
CREATE INDEX "location_daily_stats_entity_day_idx" ON "location_daily_stats" USING btree ("owner_entity_id","day");--> statement-breakpoint
CREATE INDEX "location_daily_stats_region_day_idx" ON "location_daily_stats" USING btree ("region_id","day");--> statement-breakpoint
-- Role templates: Franchisee Owner and Franchisee Manager (owner group scope); Regional Manager now defaults to a region.
INSERT INTO "roles" ("key", "name", "description", "permissions", "max_discount_pct", "default_scope", "sort_order")
SELECT 'franchisee_owner', 'Franchisee Owner',
	'Owns a franchisee business (an owner group) and runs its locations within the brand''s standards: everything a regional manager does there, its staff and their access, its finances, Stripe account and royalty statements. Client lists and exports stay the brand''s.',
	'["calendar.manage","walkins.manage","schedules.edit","checkout.any","pos.discount","pos.price_override","handoff.unlock","sales.view","sales.refund","sales.reassign","drawer.manage","giftcards.issue","clients.view_all","clients.reveal","clients.message","clients.edit","clients.family","clients.rate","clients.ratings_all","clients.filters","clients.saved_searches","notes.view","notes.write","notes.edit_any","notes.private","catalog.prices","inventory.manage","inventory.adjust","inventory.transfer","inventory.stocktake","po.create","po.send","po.receive","staff.manage","staff.contact","settings.shop","scheduling.timing","calendar.squeeze_in","service_times.correct","blocks.own","blocks.others","timeoff.request","timeoff.approve","blocks.private","blocks.reasons","callins.mark","callins.outreach","callins.voice","inbox.view","notifications.view","reports.all_staff","clients.campaigns","campaign_center.openings","timeclock.punch","timeclock.kiosk","timesheet.own","timesheet.edit","timesheet.approve","tips.own","tips.approve","devices.approve","report_builder.view","report_builder.build","report_builder.export","logins.manage","po.approve","giftcards.void","permissions.manage","entity.finances","entity.settings","entity.banking","report.my_sales.view","report.my_sales.export","report.sales_summary.view","report.sales_summary.export","report.end_of_day.view","report.end_of_day.export","report.sales_by_barber.view","report.sales_by_barber.export","report.leaderboard.view","report.leaderboard.export","report.services_vs_products.view","report.services_vs_products.export","report.tips_payroll.view","report.tips_payroll.export","report.card_vs_cash.view","report.card_vs_cash.export","report.sales_tax.view","report.sales_tax.export","report.shop_accounts.view","report.shop_accounts.export","report.rollup.view","report.rollup.export","report.discounts_refunds.view","report.discounts_refunds.export","report.inventory.view","report.inventory.export","report.inventory_movement.view","report.inventory_movement.export","report.sell_through.view","report.sell_through.export","report.low_stock.view","report.low_stock.export","report.purchasing.view","report.purchasing.export","report.gift_cards.view","report.gift_cards.export","report.loyalty.view","report.loyalty.export","report.client_ratings.view","report.kpis.view","report.kpis.export","report.operations.view","report.operations.export","report.checkout_prompts.view","report.checkout_prompts.export","report.retention.view","report.retention.export","report.acquisition.view","report.acquisition.export","report.heatmap.view","report.heatmap.export","report.service_times.view","report.service_times.export","report.staffing.view","report.staffing.export","report.call_ins.view","report.call_ins.export","report.phone_operator.view","report.phone_operator.export","report.google_reviews.view","report.google_reviews.export","report.openings.view","report.openings.export","report.labor.view","report.labor.export","report.attendance.view","report.attendance.export","report.cash_drawer.view","report.cash_drawer.export","report.tip_payouts.view","report.tip_payouts.export","report.morning_dashboard.view","report.morning_dashboard.export","report.audit_log.view","report.audit_log.export","report.entity_pnl.view","report.entity_pnl.export","report.royalties.view","report.royalties.export"]'::jsonb,
	100, 'entity', 30
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "key" = 'franchisee_owner');--> statement-breakpoint
INSERT INTO "roles" ("key", "name", "description", "permissions", "max_discount_pct", "default_scope", "sort_order")
SELECT 'franchisee_manager', 'Franchisee Manager',
	'Manages a franchisee''s locations day to day: front desk, POS, clients, staff and shop settings, with their reports. No owner finances.',
	'["calendar.manage","walkins.manage","schedules.edit","checkout.any","pos.discount","pos.price_override","handoff.unlock","sales.view","sales.refund","sales.reassign","drawer.manage","giftcards.issue","clients.view_all","clients.reveal","clients.message","clients.edit","clients.family","clients.rate","clients.ratings_all","clients.filters","clients.saved_searches","notes.view","notes.write","notes.edit_any","notes.private","catalog.prices","inventory.manage","inventory.adjust","inventory.transfer","inventory.stocktake","po.create","po.send","po.receive","staff.manage","staff.contact","settings.shop","scheduling.timing","calendar.squeeze_in","service_times.correct","blocks.own","blocks.others","timeoff.request","timeoff.approve","blocks.private","blocks.reasons","callins.mark","callins.outreach","callins.voice","inbox.view","notifications.view","reports.all_staff","clients.campaigns","campaign_center.openings","timeclock.punch","timeclock.kiosk","timesheet.own","timesheet.edit","timesheet.approve","tips.own","tips.approve","devices.approve","report_builder.view","report_builder.build","report_builder.export","logins.manage","po.approve","report.my_sales.view","report.my_sales.export","report.sales_summary.view","report.sales_summary.export","report.end_of_day.view","report.end_of_day.export","report.sales_by_barber.view","report.sales_by_barber.export","report.leaderboard.view","report.leaderboard.export","report.services_vs_products.view","report.services_vs_products.export","report.tips_payroll.view","report.tips_payroll.export","report.card_vs_cash.view","report.card_vs_cash.export","report.sales_tax.view","report.sales_tax.export","report.shop_accounts.view","report.shop_accounts.export","report.rollup.view","report.rollup.export","report.discounts_refunds.view","report.discounts_refunds.export","report.inventory.view","report.inventory.export","report.inventory_movement.view","report.inventory_movement.export","report.sell_through.view","report.sell_through.export","report.low_stock.view","report.low_stock.export","report.purchasing.view","report.purchasing.export","report.gift_cards.view","report.gift_cards.export","report.loyalty.view","report.loyalty.export","report.client_ratings.view","report.kpis.view","report.kpis.export","report.operations.view","report.operations.export","report.checkout_prompts.view","report.checkout_prompts.export","report.retention.view","report.retention.export","report.acquisition.view","report.acquisition.export","report.heatmap.view","report.heatmap.export","report.service_times.view","report.service_times.export","report.staffing.view","report.staffing.export","report.call_ins.view","report.call_ins.export","report.phone_operator.view","report.phone_operator.export","report.google_reviews.view","report.google_reviews.export","report.openings.view","report.openings.export","report.labor.view","report.labor.export","report.attendance.view","report.attendance.export","report.cash_drawer.view","report.cash_drawer.export","report.tip_payouts.view","report.tip_payouts.export","report.morning_dashboard.view","report.morning_dashboard.export","report.audit_log.view","report.audit_log.export"]'::jsonb,
	100, 'entity', 40
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "key" = 'franchisee_manager');--> statement-breakpoint
UPDATE "roles" SET "sort_order" = 50 WHERE "key" = 'regional_manager';--> statement-breakpoint
UPDATE "roles" SET "sort_order" = 60 WHERE "key" = 'shop_manager';--> statement-breakpoint
UPDATE "roles" SET "sort_order" = 70 WHERE "key" = 'front_desk';--> statement-breakpoint
UPDATE "roles" SET "sort_order" = 80 WHERE "key" = 'shop_login';--> statement-breakpoint
UPDATE "roles" SET "sort_order" = 90 WHERE "key" = 'barber';--> statement-breakpoint
UPDATE "roles" SET "default_scope" = 'region' WHERE "key" = 'regional_manager' AND "default_scope" = 'selected';--> statement-breakpoint
UPDATE "roles" SET "description" = 'Manages a region''s shops: front desk, POS, clients, staff and shop settings, the Campaign Center''s We have openings, with every report for those shops but the brand''s marketing reports.' WHERE "key" = 'regional_manager' AND "description" = 'Manages several shops: front desk, POS, clients, staff and shop settings, the Campaign Center''s We have openings, with every report for those shops but the brand''s marketing reports.';--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["entities.manage","standards.manage","entity.finances","entity.settings","report.entity_pnl.view","report.entity_pnl.export","report.royalties.view","report.royalties.export","report.rollup.view","report.rollup.export"]'::jsonb WHERE "key" = 'brand_admin' AND NOT ("permissions" ? 'entities.manage');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["report.rollup.view","report.rollup.export"]'::jsonb WHERE "key" IN ('regional_manager', 'shop_manager') AND NOT ("permissions" ? 'report.rollup.view');
