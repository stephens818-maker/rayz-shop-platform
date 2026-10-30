-- Google reviews: the review follow-up is recorded with the receipts it goes with (purpose 'review', or skipped as 'recent' when the client was asked lately), clicks on each location's Google review link, and the report's permissions. A saved review link that isn't Google's is read as no link (no button), so nothing is rewritten here.
ALTER TABLE "receipt_deliveries" DROP CONSTRAINT "receipt_deliveries_purpose";--> statement-breakpoint
ALTER TABLE "receipt_deliveries" ADD CONSTRAINT "receipt_deliveries_purpose" CHECK ("receipt_deliveries"."purpose" in ('counter', 'handoff', 'refund', 'void', 'resend', 'request', 'review'));--> statement-breakpoint
ALTER TABLE "receipt_deliveries" DROP CONSTRAINT "receipt_deliveries_skipped";--> statement-breakpoint
ALTER TABLE "receipt_deliveries" ADD CONSTRAINT "receipt_deliveries_skipped" CHECK ("receipt_deliveries"."skipped" is null or "receipt_deliveries"."skipped" in ('opted_out', 'no_consent', 'recent'));--> statement-breakpoint
CREATE INDEX "receipt_deliveries_customer_idx" ON "receipt_deliveries" USING btree ("customer_id","shop_id","purpose","created_at");--> statement-breakpoint
CREATE TABLE "review_clicks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"staff_id" uuid,
	"sale_id" uuid NOT NULL,
	"delivery_id" uuid,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_clicks_source" CHECK ("review_clicks"."source" in ('receipt', 'follow_up'))
);--> statement-breakpoint
ALTER TABLE "review_clicks" ADD CONSTRAINT "review_clicks_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_clicks" ADD CONSTRAINT "review_clicks_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_clicks" ADD CONSTRAINT "review_clicks_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_clicks" ADD CONSTRAINT "review_clicks_delivery_id_receipt_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."receipt_deliveries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_clicks_shop_idx" ON "review_clicks" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE INDEX "review_clicks_staff_idx" ON "review_clicks" USING btree ("staff_id","created_at");--> statement-breakpoint
CREATE INDEX "review_clicks_sale_idx" ON "review_clicks" USING btree ("sale_id");--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["report.google_reviews.view","report.google_reviews.export"]'::jsonb WHERE "key" IN ('brand_admin', 'regional_manager', 'shop_manager') AND NOT ("permissions" ? 'report.google_reviews.view');
