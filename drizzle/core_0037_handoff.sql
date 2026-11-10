-- Customer hand-off at checkout: the device is turned to the client for the tip, signature, receipt and payment, locked to the ticket until a staff PIN takes it back. Tickets with more than one barber split the tip between them.
ALTER TABLE "brand_settings" ADD COLUMN "handoff" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "handoff" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "shops" SET "handoff" = jsonb_build_object('tips', jsonb_build_object('type', 'percent', 'values', "tip_presets", 'allowCustom', true, 'allowNoTip', true))
WHERE "tip_presets" IS DISTINCT FROM '[20,25,30]'::jsonb AND jsonb_typeof("tip_presets") = 'array' AND jsonb_array_length("tip_presets") > 0;--> statement-breakpoint
CREATE TABLE "checkout_handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"started_by" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"draft" jsonb NOT NULL,
	"tip_cents" integer,
	"tip_choice" text,
	"tip_source" text,
	"signature" text,
	"signed_at" timestamp with time zone,
	"receipt_channel" text,
	"receipt_to" text,
	"receipt_masked" text,
	"cash_requested" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"ended_by" uuid,
	CONSTRAINT "checkout_handoffs_status" CHECK ("checkout_handoffs"."status" in ('active', 'paid', 'returned')),
	CONSTRAINT "checkout_handoffs_tip_source" CHECK ("checkout_handoffs"."tip_source" is null or "checkout_handoffs"."tip_source" in ('screen', 'reader')),
	CONSTRAINT "checkout_handoffs_receipt_channel" CHECK ("checkout_handoffs"."receipt_channel" is null or "checkout_handoffs"."receipt_channel" in ('sms', 'email', 'none')),
	CONSTRAINT "checkout_handoffs_tip" CHECK ("checkout_handoffs"."tip_cents" is null or "checkout_handoffs"."tip_cents" >= 0)
);--> statement-breakpoint
ALTER TABLE "checkout_handoffs" ADD CONSTRAINT "checkout_handoffs_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_handoffs" ADD CONSTRAINT "checkout_handoffs_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_handoffs" ADD CONSTRAINT "checkout_handoffs_started_by_staff_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_handoffs" ADD CONSTRAINT "checkout_handoffs_ended_by_staff_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_handoffs_active_uq" ON "checkout_handoffs" USING btree ("sale_id") WHERE "checkout_handoffs"."status" = 'active';--> statement-breakpoint
CREATE INDEX "checkout_handoffs_sale_idx" ON "checkout_handoffs" USING btree ("sale_id","started_at");--> statement-breakpoint
CREATE TABLE "sale_tip_shares" (
	"sale_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"weight" integer NOT NULL,
	CONSTRAINT "sale_tip_shares_pk" PRIMARY KEY("sale_id","staff_id"),
	CONSTRAINT "sale_tip_shares_weight" CHECK ("sale_tip_shares"."weight" > 0)
);--> statement-breakpoint
ALTER TABLE "sale_tip_shares" ADD CONSTRAINT "sale_tip_shares_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_tip_shares" ADD CONSTRAINT "sale_tip_shares_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sale_tip_shares_staff_idx" ON "sale_tip_shares" USING btree ("staff_id");--> statement-breakpoint
DROP INDEX "tip_ledger_payment_uq";--> statement-breakpoint
DROP INDEX "tip_ledger_refund_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "tip_ledger_payment_uq" ON "tip_ledger" USING btree ("payment_id","staff_id") WHERE "tip_ledger"."kind" = 'tip';--> statement-breakpoint
CREATE UNIQUE INDEX "tip_ledger_refund_uq" ON "tip_ledger" USING btree ("refund_id","staff_id") WHERE "tip_ledger"."kind" = 'refund';--> statement-breakpoint
-- Each barber's whole-cent share of every tip on a split ticket, and of every tip refunded from it: in proportion to the weights, largest remainder first, ties to the lower staff id (splitCents in src/domain/handoff.ts).
CREATE VIEW "tip_split_shares" AS
WITH src AS (
	SELECT 'payment'::text AS source, p."id" AS source_id, p."sale_id", p."shop_id", p."business_date", p."method"::text AS method, NULL::text AS refund_kind, p."tip_cents"::bigint AS tip_cents
	FROM "payments" p WHERE p."tip_cents" <> 0 AND EXISTS (SELECT 1 FROM "sale_tip_shares" x WHERE x."sale_id" = p."sale_id")
	UNION ALL
	SELECT 'refund'::text, r."id", r."sale_id", r."shop_id", r."business_date", r."method"::text, r."kind", r."tip_cents"::bigint
	FROM "refunds" r WHERE r."tip_cents" <> 0 AND EXISTS (SELECT 1 FROM "sale_tip_shares" x WHERE x."sale_id" = r."sale_id")
), w AS (
	SELECT src.*, x."staff_id", x."weight"::bigint AS weight, (sum(x."weight") OVER (PARTITION BY src.source, src.source_id))::bigint AS total
	FROM src JOIN "sale_tip_shares" x ON x."sale_id" = src."sale_id"
), f AS (
	SELECT w.*, (w.tip_cents * w.weight) / w.total AS base, (w.tip_cents * w.weight) % w.total AS rem FROM w
), r AS (
	SELECT f.*, f.tip_cents - (sum(f.base) OVER (PARTITION BY f.source, f.source_id))::bigint AS leftover,
		row_number() OVER (PARTITION BY f.source, f.source_id ORDER BY f.rem DESC, f."staff_id") AS rn
	FROM f
)
SELECT source, source_id, "sale_id", "shop_id", "business_date", method, refund_kind, "staff_id", tip_cents::int AS source_tip_cents,
	(base + CASE WHEN rn <= leftover THEN 1 ELSE 0 END)::int AS tip_cents
FROM r;--> statement-breakpoint
-- What a split moves in reports that credit tips to the ticket's barber: each share to its barber, less the whole tip from the ticket's barber. Adds up to zero per tip.
CREATE VIEW "tip_split_moves" AS
SELECT source, source_id, "sale_id", "shop_id", "business_date", method, refund_kind, "staff_id", tip_cents AS delta_cents FROM "tip_split_shares"
UNION ALL
SELECT DISTINCT sh.source, sh.source_id, sh."sale_id", sh."shop_id", sh."business_date", sh.method, sh.refund_kind, s."staff_id", -sh.source_tip_cents
FROM "tip_split_shares" sh JOIN "sales" s ON s."id" = sh."sale_id";--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["handoff.unlock","handoff.settings"]'::jsonb WHERE "key" = 'brand_admin' AND NOT ("permissions" ? 'handoff.unlock');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["handoff.unlock"]'::jsonb WHERE "key" IN ('regional_manager', 'shop_manager') AND NOT ("permissions" ? 'handoff.unlock');
