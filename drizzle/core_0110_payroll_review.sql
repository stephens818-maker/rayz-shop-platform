-- Payroll review (SB-C1 to SB-C7): a tip refunded after it was paid is the shop's cost (absorbed as after_payout) unless the brand deducts it; employees declare the cash tips handed to them; each employee's tipped occupation code for the 2026 W-2; and the W-2 codes and 45B FICA tip credit payroll reports.
ALTER TABLE "tip_absorptions" DROP CONSTRAINT "tip_absorptions_kind";--> statement-breakpoint
ALTER TABLE "tip_absorptions" ADD CONSTRAINT "tip_absorptions_kind" CHECK ("tip_absorptions"."kind" in ('partial_refund', 'outside_window', 'rule', 'after_payout', 'dispute'));--> statement-breakpoint
ALTER TABLE "payroll_profiles" ADD COLUMN "tipped_occupation_code" text;--> statement-breakpoint
ALTER TABLE "payroll_profiles" ADD CONSTRAINT "payroll_profiles_tipped_occupation_code" CHECK ("payroll_profiles"."tipped_occupation_code" is null or "payroll_profiles"."tipped_occupation_code" ~ '^[A-Za-z0-9]{1,8}$');--> statement-breakpoint
-- Declared cash tips, with the attestation checked. Append-only: a correction is a new row replacing the old one, with a reason.
CREATE TABLE "tip_declarations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"amount_cents" integer NOT NULL,
	"source" text NOT NULL,
	"attestation" text NOT NULL,
	"replaces_id" uuid,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tip_declarations_amount" CHECK ("tip_declarations"."amount_cents" >= 0 and "tip_declarations"."amount_cents" <= 1000000),
	CONSTRAINT "tip_declarations_source" CHECK ("tip_declarations"."source" in ('staff_app', 'clock_out', 'web', 'manager')),
	CONSTRAINT "tip_declarations_reason" CHECK ("tip_declarations"."replaces_id" is null or "tip_declarations"."reason" is not null)
);--> statement-breakpoint
ALTER TABLE "tip_declarations" ADD CONSTRAINT "tip_declarations_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_declarations" ADD CONSTRAINT "tip_declarations_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_declarations" ADD CONSTRAINT "tip_declarations_replaces_id_tip_declarations_id_fk" FOREIGN KEY ("replaces_id") REFERENCES "public"."tip_declarations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_declarations" ADD CONSTRAINT "tip_declarations_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tip_declarations_replaces_uq" ON "tip_declarations" USING btree ("replaces_id");--> statement-breakpoint
CREATE INDEX "tip_declarations_shop_date_idx" ON "tip_declarations" USING btree ("shop_id","business_date");--> statement-breakpoint
CREATE INDEX "tip_declarations_staff_date_idx" ON "tip_declarations" USING btree ("staff_id","business_date");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "tip_declarations_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'tip_declarations %: declarations are never changed or removed; add a correction instead', OLD."id";
END $$;--> statement-breakpoint
CREATE TRIGGER "tip_declarations_append_only" BEFORE UPDATE OR DELETE ON "tip_declarations" FOR EACH ROW EXECUTE FUNCTION "tip_declarations_append_only"();--> statement-breakpoint
-- The W-2 codes and 45B reports are payroll reports: the brand admin and the Bookkeeper.
UPDATE "roles" SET "permissions" = "permissions" || '["report.payroll_w2_codes.view","report.payroll_w2_codes.export","report.payroll_fica_tip_credit.view","report.payroll_fica_tip_credit.export"]'::jsonb WHERE "key" IN ('brand_admin', 'bookkeeper') AND NOT ("permissions" ? 'report.payroll_w2_codes.view');
