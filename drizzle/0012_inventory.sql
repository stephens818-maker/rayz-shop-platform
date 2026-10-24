CREATE TYPE "public"."count_status" AS ENUM('open', 'posted', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."po_status" AS ENUM('draft', 'approved', 'sent', 'partially_received', 'received', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."transfer_status" AS ENUM('draft', 'sent', 'received', 'cancelled');--> statement-breakpoint
CREATE TABLE "po_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"unit_cost_cents" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "po_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"note" text,
	"received_by" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"vendor_sku" text,
	"case_pack" integer DEFAULT 1 NOT NULL,
	"qty_ordered" integer NOT NULL,
	"unit_cost_cents" integer NOT NULL,
	"qty_received" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" integer GENERATED ALWAYS AS IDENTITY (sequence name "purchase_orders_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1001 CACHE 1),
	"shop_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"status" "po_status" DEFAULT 'draft' NOT NULL,
	"batch_id" uuid,
	"expected_on" date,
	"notes" text,
	"created_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"sent_by" uuid,
	"sent_at" timestamp with time zone,
	"sent_to" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"closed_short" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_count_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"count_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"expected_at_start" integer NOT NULL,
	"counted" integer,
	"on_hand_at_post" integer,
	"variance" integer,
	"unit_cost_cents" integer
);
--> statement-breakpoint
CREATE TABLE "stock_counts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" integer GENERATED ALWAYS AS IDENTITY (sequence name "stock_counts_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 101 CACHE 1),
	"shop_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" "count_status" DEFAULT 'open' NOT NULL,
	"note" text,
	"created_by" uuid,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_transfer_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transfer_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"qty_received" integer,
	"unit_cost_cents" integer
);
--> statement-breakpoint
CREATE TABLE "stock_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" integer GENERATED ALWAYS AS IDENTITY (sequence name "stock_transfers_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 501 CACHE 1),
	"from_shop_id" uuid NOT NULL,
	"to_shop_id" uuid NOT NULL,
	"status" "transfer_status" DEFAULT 'draft' NOT NULL,
	"note" text,
	"created_by" uuid,
	"sent_by" uuid,
	"sent_at" timestamp with time zone,
	"received_by" uuid,
	"received_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_products" (
	"vendor_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"vendor_sku" text,
	"case_pack" integer DEFAULT 1 NOT NULL,
	"cost_cents" integer NOT NULL,
	"preferred" boolean DEFAULT false NOT NULL,
	CONSTRAINT "vendor_products_vendor_id_product_id_pk" PRIMARY KEY("vendor_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"contact_name" text,
	"email" text,
	"phone" text,
	"address" text,
	"account_number" text,
	"payment_terms" text,
	"lead_time_days" integer DEFAULT 7 NOT NULL,
	"minimum_order_cents" integer DEFAULT 0 NOT NULL,
	"send_csv" boolean DEFAULT false NOT NULL,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The old adjustments table becomes the ledger, keeping its history.
ALTER TABLE "inventory_adjustments" RENAME TO "inventory_ledger";--> statement-breakpoint
ALTER INDEX "inventory_adjustments_pkey" RENAME TO "inventory_ledger_pkey";--> statement-breakpoint
ALTER TABLE "inventory_ledger" RENAME CONSTRAINT "inventory_adjustments_shop_id_shops_id_fk" TO "inventory_ledger_shop_id_shops_id_fk";--> statement-breakpoint
ALTER TABLE "inventory_ledger" RENAME CONSTRAINT "inventory_adjustments_product_id_products_id_fk" TO "inventory_ledger_product_id_products_id_fk";--> statement-breakpoint
ALTER TABLE "inventory_ledger" RENAME COLUMN "reason" TO "kind";--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD COLUMN "seq" integer GENERATED ALWAYS AS IDENTITY (sequence name "inventory_ledger_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1);--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD COLUMN "unit_cost_cents" integer;--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD COLUMN "balance_after" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD COLUMN "purchase_order_id" uuid;--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD COLUMN "receipt_id" uuid;--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD COLUMN "transfer_id" uuid;--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD COLUMN "count_id" uuid;--> statement-breakpoint
ALTER TABLE "shop_products" ALTER COLUMN "low_stock_threshold" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "shop_products" ALTER COLUMN "low_stock_threshold" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_settings" ADD COLUMN "po_approval_threshold_cents" integer;--> statement-breakpoint
ALTER TABLE "notification_jobs" ADD COLUMN "shop_id" uuid;--> statement-breakpoint
ALTER TABLE "notification_jobs" ADD COLUMN "purchase_order_id" uuid;--> statement-breakpoint
ALTER TABLE "notification_jobs" ADD COLUMN "attachments" jsonb;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "par_level" integer DEFAULT 6 NOT NULL;--> statement-breakpoint
ALTER TABLE "shop_products" ADD COLUMN "par_level" integer;--> statement-breakpoint
ALTER TABLE "shop_products" ADD COLUMN "low_alerted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "negative_stock" text DEFAULT 'block' NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "inventory_alert_email" text;--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_receipt_id_po_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."po_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_transfer_id_stock_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."stock_transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_count_id_stock_counts_id_fk" FOREIGN KEY ("count_id") REFERENCES "public"."stock_counts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_receipt_lines" ADD CONSTRAINT "po_receipt_lines_receipt_id_po_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."po_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_receipt_lines" ADD CONSTRAINT "po_receipt_lines_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_receipt_lines" ADD CONSTRAINT "po_receipt_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_receipts" ADD CONSTRAINT "po_receipts_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_receipts" ADD CONSTRAINT "po_receipts_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_receipts" ADD CONSTRAINT "po_receipts_received_by_staff_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_approved_by_staff_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_sent_by_staff_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_cancelled_by_staff_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_count_id_stock_counts_id_fk" FOREIGN KEY ("count_id") REFERENCES "public"."stock_counts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_posted_by_staff_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_transfer_id_stock_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."stock_transfers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_from_shop_id_shops_id_fk" FOREIGN KEY ("from_shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_shop_id_shops_id_fk" FOREIGN KEY ("to_shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_sent_by_staff_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_received_by_staff_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_products" ADD CONSTRAINT "vendor_products_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_products" ADD CONSTRAINT "vendor_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_ledger_shop_product_idx" ON "inventory_ledger" USING btree ("shop_id","product_id","seq");--> statement-breakpoint
CREATE INDEX "inventory_ledger_shop_at_idx" ON "inventory_ledger" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE INDEX "po_receipt_lines_receipt_idx" ON "po_receipt_lines" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "po_receipts_po_idx" ON "po_receipts" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_lines_uq" ON "purchase_order_lines" USING btree ("purchase_order_id","product_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_shop_status_idx" ON "purchase_orders" USING btree ("shop_id","status");--> statement-breakpoint
CREATE INDEX "purchase_orders_vendor_idx" ON "purchase_orders" USING btree ("vendor_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_count_lines_uq" ON "stock_count_lines" USING btree ("count_id","product_id");--> statement-breakpoint
CREATE INDEX "stock_counts_shop_idx" ON "stock_counts" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_transfer_lines_uq" ON "stock_transfer_lines" USING btree ("transfer_id","product_id");--> statement-breakpoint
CREATE INDEX "stock_transfers_from_idx" ON "stock_transfers" USING btree ("from_shop_id","status");--> statement-breakpoint
CREATE INDEX "stock_transfers_to_idx" ON "stock_transfers" USING btree ("to_shop_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_products_preferred_uq" ON "vendor_products" USING btree ("product_id") WHERE preferred;--> statement-breakpoint
CREATE UNIQUE INDEX "vendors_name_unique" ON "vendors" USING btree (lower("name"));--> statement-breakpoint
ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Old adjustment reasons become ledger kinds; counts and damage are manual adjustments with a reason.
UPDATE "inventory_ledger" SET "reason" = 'count_correction', "kind" = 'adjust' WHERE "kind" = 'count';--> statement-breakpoint
UPDATE "inventory_ledger" SET "reason" = 'damage', "kind" = 'adjust' WHERE "kind" = 'damage';--> statement-breakpoint
UPDATE "inventory_ledger" l SET "unit_cost_cents" = sp."cost_cents" FROM "shop_products" sp WHERE sp."shop_id" = l."shop_id" AND sp."product_id" = l."product_id";--> statement-breakpoint
-- An opening entry per shop product makes the ledger add up to what's on the shelf today.
INSERT INTO "inventory_ledger" ("shop_id", "product_id", "delta", "kind", "note", "unit_cost_cents", "created_at")
SELECT sp."shop_id", sp."product_id", sp."stock" - coalesce(l."total", 0), 'opening', 'Stock on hand before the ledger', sp."cost_cents", coalesce(l."first" - interval '1 second', now())
FROM "shop_products" sp
LEFT JOIN (SELECT "shop_id", "product_id", sum("delta")::int "total", min("created_at") "first" FROM "inventory_ledger" GROUP BY 1, 2) l ON l."shop_id" = sp."shop_id" AND l."product_id" = sp."product_id"
WHERE sp."stock" <> coalesce(l."total", 0);--> statement-breakpoint
UPDATE "inventory_ledger" l SET "balance_after" = r."bal"
FROM (SELECT "id", sum("delta") OVER (PARTITION BY "shop_id", "product_id" ORDER BY ("kind" <> 'opening'), "created_at", "seq")::int "bal" FROM "inventory_ledger") r
WHERE r."id" = l."id";--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_delta_nonzero" CHECK ("delta" <> 0);--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_kind_known" CHECK ("kind" IN ('opening', 'sale', 'refund', 'void', 'receive', 'transfer_out', 'transfer_in', 'adjust', 'stocktake', 'upload'));--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_reason_for_adjust" CHECK (("kind" = 'adjust') = ("reason" IS NOT NULL) AND ("reason" IS NULL OR "reason" IN ('damage', 'theft', 'count_correction', 'back_bar', 'found', 'other')));--> statement-breakpoint
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_direction" CHECK (
	("kind" IN ('sale', 'transfer_out') AND "delta" < 0) OR ("kind" IN ('refund', 'void', 'receive', 'transfer_in') AND "delta" > 0) OR "kind" IN ('opening', 'adjust', 'stocktake', 'upload')
);--> statement-breakpoint
-- Stock is the ledger: posting an entry moves shop_products.stock and records the balance after it.
CREATE FUNCTION "inventory_ledger_apply"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bal integer;
BEGIN
	UPDATE "shop_products" SET "stock" = "stock" + NEW."delta" WHERE "shop_id" = NEW."shop_id" AND "product_id" = NEW."product_id" RETURNING "stock" INTO bal;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'inventory_ledger: product % is not carried at shop %', NEW."product_id", NEW."shop_id" USING ERRCODE = 'foreign_key_violation';
	END IF;
	NEW."balance_after" := bal;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "inventory_ledger_apply" BEFORE INSERT ON "inventory_ledger" FOR EACH ROW EXECUTE FUNCTION "inventory_ledger_apply"();--> statement-breakpoint
CREATE FUNCTION "inventory_ledger_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'inventory_ledger is append-only: post a correcting entry instead' USING ERRCODE = 'restrict_violation';
END $$;--> statement-breakpoint
CREATE TRIGGER "inventory_ledger_append_only" BEFORE UPDATE OR DELETE ON "inventory_ledger" FOR EACH ROW EXECUTE FUNCTION "inventory_ledger_append_only"();--> statement-breakpoint
-- Nothing else may write stock: new rows start at zero and only the ledger trigger (depth 2) changes it.
CREATE FUNCTION "shop_products_stock_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'INSERT' AND NEW."stock" <> 0 THEN
		RAISE EXCEPTION 'shop_products.stock starts at 0; post opening stock to inventory_ledger' USING ERRCODE = 'restrict_violation';
	END IF;
	IF TG_OP = 'UPDATE' AND NEW."stock" IS DISTINCT FROM OLD."stock" AND pg_trigger_depth() < 2 THEN
		RAISE EXCEPTION 'shop_products.stock changes only through inventory_ledger' USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "shop_products_stock_guard" BEFORE INSERT OR UPDATE ON "shop_products" FOR EACH ROW EXECUTE FUNCTION "shop_products_stock_guard"();--> statement-breakpoint
-- Should always be empty. Tests and the stock page check it.
CREATE VIEW "inventory_drift" AS
SELECT sp."shop_id", sp."product_id", sp."stock", coalesce(l."total", 0) "ledger_total"
FROM "shop_products" sp
LEFT JOIN (SELECT "shop_id", "product_id", sum("delta")::int "total" FROM "inventory_ledger" GROUP BY 1, 2) l ON l."shop_id" = sp."shop_id" AND l."product_id" = sp."product_id"
WHERE sp."stock" <> coalesce(l."total", 0);--> statement-breakpoint
-- Reorder points and par levels: shops follow the brand unless they override it.
UPDATE "shop_products" sp SET "low_stock_threshold" = NULL FROM "products" p WHERE p."id" = sp."product_id" AND sp."low_stock_threshold" = p."low_stock_threshold";--> statement-breakpoint
UPDATE "products" SET "par_level" = greatest(6, "low_stock_threshold" * 2);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_par_nonnegative" CHECK ("par_level" >= 0);--> statement-breakpoint
ALTER TABLE "shop_products" ADD CONSTRAINT "shop_products_levels_nonnegative" CHECK (("low_stock_threshold" IS NULL OR "low_stock_threshold" >= 0) AND ("par_level" IS NULL OR "par_level" >= 0));--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_negative_stock_policy" CHECK ("negative_stock" IN ('block', 'warn'));--> statement-breakpoint
ALTER TABLE "brand_settings" ADD CONSTRAINT "brand_settings_po_threshold_nonnegative" CHECK ("po_approval_threshold_cents" IS NULL OR "po_approval_threshold_cents" >= 0);--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_name_present" CHECK (length(btrim("name")) BETWEEN 1 AND 120);--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_numbers_nonnegative" CHECK ("lead_time_days" >= 0 AND "minimum_order_cents" >= 0);--> statement-breakpoint
ALTER TABLE "vendor_products" ADD CONSTRAINT "vendor_products_sane" CHECK ("case_pack" >= 1 AND "cost_cents" >= 0);--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_sane" CHECK ("qty_ordered" > 0 AND "qty_received" >= 0 AND "case_pack" >= 1 AND "unit_cost_cents" >= 0);--> statement-breakpoint
ALTER TABLE "po_receipt_lines" ADD CONSTRAINT "po_receipt_lines_sane" CHECK ("qty" > 0 AND "unit_cost_cents" >= 0);--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_two_shops" CHECK ("from_shop_id" <> "to_shop_id");--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_sane" CHECK ("qty" > 0 AND ("qty_received" IS NULL OR "qty_received" BETWEEN 0 AND "qty"));--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_kind" CHECK ("kind" IN ('cycle', 'full'));--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_counted_nonnegative" CHECK ("counted" IS NULL OR "counted" >= 0);--> statement-breakpoint
CREATE INDEX "notification_jobs_shop_idx" ON "notification_jobs" USING btree ("shop_id", "run_at") WHERE "shop_id" IS NOT NULL;--> statement-breakpoint
-- Purchasing and stock permissions for the templates.
UPDATE "roles" SET "permissions" = "permissions" || '["po.create","po.send","po.receive","inventory.adjust","inventory.transfer","inventory.stocktake"]'::jsonb WHERE "key" IN ('brand_admin', 'regional_manager', 'shop_manager');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["vendors.manage","po.approve"]'::jsonb WHERE "key" IN ('brand_admin', 'regional_manager');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["po.receive","inventory.stocktake"]'::jsonb WHERE "key" IN ('front_desk');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["report.inventory_movement.view","report.inventory_movement.export","report.sell_through.view","report.sell_through.export","report.low_stock.view","report.low_stock.export","report.purchasing.view","report.purchasing.export"]'::jsonb WHERE "key" IN ('brand_admin', 'regional_manager', 'shop_manager');--> statement-breakpoint
-- Custom roles that managed inventory could receive, count and adjust stock, so they still can.
UPDATE "roles" SET "permissions" = "permissions" || '["inventory.adjust","inventory.stocktake","po.receive"]'::jsonb WHERE "key" IS NULL AND "permissions" ? 'inventory.manage';--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["report.inventory_movement.view","report.sell_through.view","report.low_stock.view"]'::jsonb WHERE "key" IS NULL AND "permissions" ? 'report.inventory.view';
