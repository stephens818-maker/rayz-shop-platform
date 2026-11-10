-- Brand catalog: one category order for services and one for products (seeded from today's order), a high stock threshold (brand default with a shop override) to flag overstock, and unallocated brand stock: units bought centrally and not yet at a shop, with an append-only ledger. Allocating moves units from it into a shop's stock ledger as a transfer in.
CREATE TABLE IF NOT EXISTS "catalog_categories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "catalog_categories_kind" CHECK ("kind" in ('service', 'product')),
  CONSTRAINT "catalog_categories_name" CHECK (length(trim("name")) between 1 and 60)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_categories_kind_name_uq" ON "catalog_categories" ("kind", lower("name"));--> statement-breakpoint
INSERT INTO "catalog_categories" ("kind", "name", "sort_order")
  SELECT 'service', "category", (row_number() OVER (ORDER BY min("sort_order"), "category"))::int * 10 FROM "services" GROUP BY "category"
  ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "catalog_categories" ("kind", "name", "sort_order")
  SELECT 'product', "category", (row_number() OVER (ORDER BY "category"))::int * 10 FROM "products" GROUP BY "category"
  ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "high_stock_threshold" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "unallocated_stock" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shop_products" ADD COLUMN IF NOT EXISTS "high_stock_threshold" integer;--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "products_high_nonnegative";--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_high_nonnegative" CHECK ("high_stock_threshold" IS NULL OR "high_stock_threshold" >= 0);--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "products_unallocated_nonnegative";--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_unallocated_nonnegative" CHECK ("unallocated_stock" >= 0);--> statement-breakpoint
ALTER TABLE "shop_products" DROP CONSTRAINT IF EXISTS "shop_products_high_nonnegative";--> statement-breakpoint
ALTER TABLE "shop_products" ADD CONSTRAINT "shop_products_high_nonnegative" CHECK ("high_stock_threshold" IS NULL OR "high_stock_threshold" >= 0);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "brand_stock_moves" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "product_id" uuid NOT NULL REFERENCES "products"("id"),
  "delta" integer NOT NULL,
  "kind" text NOT NULL,
  "shop_id" uuid REFERENCES "shops"("id"),
  "unit_cost_cents" integer,
  "note" text,
  "balance_after" integer NOT NULL,
  "staff_id" uuid REFERENCES "staff"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "brand_stock_moves_kind" CHECK ("kind" in ('receive', 'allocate', 'adjust')),
  CONSTRAINT "brand_stock_moves_delta" CHECK ("delta" <> 0 AND ("kind" <> 'receive' OR "delta" > 0) AND ("kind" <> 'allocate' OR "delta" < 0)),
  CONSTRAINT "brand_stock_moves_shop" CHECK (("kind" = 'allocate') = ("shop_id" IS NOT NULL)),
  CONSTRAINT "brand_stock_moves_balance" CHECK ("balance_after" >= 0)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brand_stock_moves_product_idx" ON "brand_stock_moves" ("product_id", "created_at");--> statement-breakpoint
DROP TRIGGER IF EXISTS "brand_stock_moves_scrub_sensitive" ON "brand_stock_moves";--> statement-breakpoint
CREATE TRIGGER "brand_stock_moves_scrub_sensitive" BEFORE INSERT OR UPDATE OF "note" ON "brand_stock_moves" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('note');
