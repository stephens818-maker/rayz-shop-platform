-- ST-C18: tips are never reduced by card processing fees; the shop pays them.
UPDATE "staff_compensation" SET "tip_card_fee_netting" = NULL WHERE "tip_card_fee_netting" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_compensation" ADD CONSTRAINT "staff_compensation_no_tip_fee_netting" CHECK ("tip_card_fee_netting" IS NULL);--> statement-breakpoint
UPDATE "shops" SET "tip_payouts" = "tip_payouts" - 'netCardFee' WHERE "tip_payouts" ? 'netCardFee';--> statement-breakpoint
UPDATE "brand_settings" SET "tip_payouts" = "tip_payouts" - 'netCardFee' WHERE "tip_payouts" ? 'netCardFee';--> statement-breakpoint
UPDATE "tip_payouts" SET "net_cents" = "net_cents" + "fee_cents", "fee_cents" = 0, "updated_at" = now() WHERE "fee_cents" <> 0 AND "status" IN ('pending', 'held');--> statement-breakpoint
ALTER TABLE "tip_payouts" ADD CONSTRAINT "tip_payouts_no_fee_on_open" CHECK ("fee_cents" = 0 OR "status" NOT IN ('pending', 'held'));
