-- Database-level guarantee that no barber is ever double-booked, at any shop.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_no_double_booking"
  EXCLUDE USING gist ("staff_id" WITH =, tstzrange("starts_at", "ends_at", '[)') WITH &&)
  WHERE ("status" IN ('booked', 'confirmed', 'checked_in', 'in_service'));
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_time_order" CHECK ("ends_at" > "starts_at");
--> statement-breakpoint
ALTER TABLE "time_blocks" ADD CONSTRAINT "time_blocks_time_order" CHECK ("ends_at" > "starts_at");
--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_card_fee_cap" CHECK ("card_fee_rate" >= 0 AND "card_fee_rate" <= 0.03);
--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_tax_rates_sane" CHECK ("service_tax_rate" >= 0 AND "service_tax_rate" < 0.25 AND "product_tax_rate" >= 0 AND "product_tax_rate" < 0.25);
--> statement-breakpoint
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_balance_nonneg" CHECK ("balance_cents" >= 0);
