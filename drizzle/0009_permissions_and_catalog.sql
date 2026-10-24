CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_discount_pct" smallint DEFAULT 0 NOT NULL,
	"default_scope" text DEFAULT 'one' NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_key_unique" UNIQUE("key"),
	CONSTRAINT "roles_name_unique" UNIQUE("name"),
	CONSTRAINT "roles_max_discount_range" CHECK ("max_discount_pct" BETWEEN 0 AND 100),
	CONSTRAINT "roles_default_scope_valid" CHECK ("default_scope" IN ('all', 'selected', 'one')),
	CONSTRAINT "roles_permissions_array" CHECK (jsonb_typeof("permissions") = 'array')
);
--> statement-breakpoint
CREATE TABLE "staff_access_shops" (
	"staff_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	CONSTRAINT "staff_access_shops_staff_id_shop_id_pk" PRIMARY KEY("staff_id","shop_id")
);
--> statement-breakpoint
ALTER TABLE "staff_access_shops" ADD CONSTRAINT "staff_access_shops_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_access_shops" ADD CONSTRAINT "staff_access_shops_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_access_shops_shop_idx" ON "staff_access_shops" USING btree ("shop_id");--> statement-breakpoint
-- Built-in role templates, generated from ROLE_TEMPLATES in src/domain/permissions.ts (tests check they match).
-- The Brand Owner's permissions are computed (always everything), so its list is empty.
INSERT INTO "roles" ("key", "name", "description", "permissions", "max_discount_pct", "default_scope", "sort_order") VALUES
  ('brand_owner', 'Brand Owner', 'Everything, at every shop. The only role that can grant Brand Owner or change brand-level settings.', '[]'::jsonb, 100, 'all', 10),
  ('brand_admin', 'Brand Admin', 'Runs the whole brand day to day. Everything except brand-level settings and granting Brand Owner.', '["calendar.manage","walkins.manage","schedules.edit","checkout.any","pos.discount","pos.price_override","sales.view","sales.refund","drawer.manage","promos.manage","giftcards.issue","giftcards.void","clients.view_all","clients.contact","clients.edit","clients.merge","clients.rate","clients.ratings_all","clients.ratings_moderate","loyalty.grant","catalog.prices","catalog.manage","inventory.manage","staff.manage","permissions.manage","settings.shop","settings.taxes","import.run","notifications.view","notifications.send","report.my_sales.view","report.my_sales.export","report.sales_summary.view","report.sales_summary.export","report.sales_by_barber.view","report.sales_by_barber.export","report.services_vs_products.view","report.services_vs_products.export","report.tips_payroll.view","report.tips_payroll.export","report.card_vs_cash.view","report.card_vs_cash.export","report.discounts_refunds.view","report.discounts_refunds.export","report.inventory.view","report.inventory.export","report.gift_cards.view","report.gift_cards.export","report.loyalty.view","report.loyalty.export","report.client_ratings.view","report.client_ratings.export","report.kpis.view","report.kpis.export","report.heatmap.view","report.heatmap.export","report.cash_drawer.view","report.cash_drawer.export","report.audit_log.view","report.audit_log.export"]'::jsonb, 100, 'all', 20),
  ('regional_manager', 'Regional Manager', 'Manages several shops: front desk, POS, clients, staff and shop settings, with every report for those shops.', '["calendar.manage","walkins.manage","schedules.edit","checkout.any","pos.discount","pos.price_override","sales.view","sales.refund","drawer.manage","promos.manage","giftcards.issue","clients.view_all","clients.contact","clients.edit","clients.merge","clients.rate","clients.ratings_all","catalog.prices","inventory.manage","staff.manage","settings.shop","notifications.view","giftcards.void","report.my_sales.view","report.my_sales.export","report.sales_summary.view","report.sales_summary.export","report.sales_by_barber.view","report.sales_by_barber.export","report.services_vs_products.view","report.services_vs_products.export","report.tips_payroll.view","report.tips_payroll.export","report.card_vs_cash.view","report.card_vs_cash.export","report.discounts_refunds.view","report.discounts_refunds.export","report.inventory.view","report.inventory.export","report.gift_cards.view","report.gift_cards.export","report.loyalty.view","report.loyalty.export","report.client_ratings.view","report.client_ratings.export","report.kpis.view","report.kpis.export","report.heatmap.view","report.heatmap.export","report.cash_drawer.view","report.cash_drawer.export","report.audit_log.view","report.audit_log.export"]'::jsonb, 100, 'selected', 30),
  ('shop_manager', 'Shop Manager', 'Manages one shop: front desk, POS, clients, staff and shop settings, with that shop''s reports.', '["calendar.manage","walkins.manage","schedules.edit","checkout.any","pos.discount","pos.price_override","sales.view","sales.refund","drawer.manage","promos.manage","giftcards.issue","clients.view_all","clients.contact","clients.edit","clients.merge","clients.rate","clients.ratings_all","catalog.prices","inventory.manage","staff.manage","settings.shop","notifications.view","report.my_sales.view","report.my_sales.export","report.sales_summary.view","report.sales_summary.export","report.sales_by_barber.view","report.sales_by_barber.export","report.services_vs_products.view","report.services_vs_products.export","report.tips_payroll.view","report.tips_payroll.export","report.card_vs_cash.view","report.card_vs_cash.export","report.discounts_refunds.view","report.discounts_refunds.export","report.inventory.view","report.inventory.export","report.gift_cards.view","report.gift_cards.export","report.loyalty.view","report.loyalty.export","report.client_ratings.view","report.client_ratings.export","report.kpis.view","report.kpis.export","report.heatmap.view","report.heatmap.export","report.cash_drawer.view","report.cash_drawer.export","report.audit_log.view","report.audit_log.export"]'::jsonb, 100, 'one', 40),
  ('front_desk', 'Front Desk', 'Books and checks out every barber''s clients, runs walk-ins and the drawer. Small discounts only.', '["calendar.manage","walkins.manage","checkout.any","pos.discount","sales.view","drawer.manage","clients.view_all","clients.contact","clients.edit","report.card_vs_cash.view","report.cash_drawer.view"]'::jsonb, 10, 'one', 50),
  ('barber', 'Barber', 'Their own column, their own clients and their own sales.', '["clients.rate","report.my_sales.view","report.my_sales.export"]'::jsonb, 0, 'selected', 60);
--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "role_id" uuid;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "shop_scope" text DEFAULT 'selected' NOT NULL;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "permission_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "max_discount_pct" smallint;--> statement-breakpoint
-- The old brand admin owns the brand; managers keep their one shop; barbers see the shops they work at.
UPDATE "staff" SET
	"role_id" = (SELECT "id" FROM "roles" WHERE "key" = CASE "staff"."role" WHEN 'brand_admin' THEN 'brand_owner' WHEN 'shop_manager' THEN 'shop_manager' ELSE 'barber' END),
	"shop_scope" = CASE WHEN "role" = 'brand_admin' THEN 'all' WHEN "role" = 'shop_manager' AND "manager_shop_id" IS NOT NULL THEN 'one' ELSE 'selected' END;--> statement-breakpoint
INSERT INTO "staff_access_shops" ("staff_id", "shop_id")
	SELECT "id", "manager_shop_id" FROM "staff" WHERE "role" = 'shop_manager' AND "manager_shop_id" IS NOT NULL;--> statement-breakpoint
INSERT INTO "staff_access_shops" ("staff_id", "shop_id")
	SELECT ss."staff_id", ss."shop_id" FROM "staff_shops" ss JOIN "staff" s ON s."id" = ss."staff_id"
	WHERE s."role" = 'barber' OR (s."role" = 'shop_manager' AND s."manager_shop_id" IS NULL)
	ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "staff" ALTER COLUMN "role_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_shop_scope_valid" CHECK ("shop_scope" IN ('all', 'selected', 'one'));--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_max_discount_range" CHECK ("max_discount_pct" IS NULL OR "max_discount_pct" BETWEEN 0 AND 100);--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_overrides_object" CHECK (jsonb_typeof("permission_overrides") = 'object');--> statement-breakpoint
ALTER TABLE "staff" DROP CONSTRAINT "staff_manager_shop_id_shops_id_fk";--> statement-breakpoint
ALTER TABLE "staff" DROP COLUMN "role";--> statement-breakpoint
ALTER TABLE "staff" DROP COLUMN "manager_shop_id";--> statement-breakpoint
DROP TYPE "public"."staff_role";--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "barcode" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "tax_category" text DEFAULT 'product' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "cost_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "price_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "low_stock_threshold" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
-- Brand-level cost and price start from what most shops charge today.
UPDATE "products" p SET
	"cost_cents" = coalesce((SELECT mode() WITHIN GROUP (ORDER BY sp."cost_cents") FROM "shop_products" sp WHERE sp."product_id" = p."id"), 0),
	"price_cents" = coalesce((SELECT mode() WITHIN GROUP (ORDER BY sp."price_cents") FROM "shop_products" sp WHERE sp."product_id" = p."id"), 0),
	"low_stock_threshold" = coalesce((SELECT mode() WITHIN GROUP (ORDER BY sp."low_stock_threshold") FROM "shop_products" sp WHERE sp."product_id" = p."id"), 3);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_barcode_unique" UNIQUE("barcode");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tax_category_valid" CHECK ("tax_category" IN ('service', 'product', 'exempt'));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_money_nonnegative" CHECK ("cost_cents" >= 0 AND "price_cents" >= 0 AND "low_stock_threshold" >= 0);--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "sku" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "tax_category" text DEFAULT 'service' NOT NULL;--> statement-breakpoint
UPDATE "services" SET "sku" = upper("slug") WHERE NOT EXISTS (SELECT 1 FROM "products" p WHERE p."sku" = upper("services"."slug"));--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_sku_unique" UNIQUE("sku");--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_tax_category_valid" CHECK ("tax_category" IN ('service', 'product', 'exempt'));
