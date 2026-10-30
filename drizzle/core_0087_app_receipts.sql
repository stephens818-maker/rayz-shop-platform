ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "receipt_delivery" text;--> statement-breakpoint
ALTER TABLE "customers" DROP CONSTRAINT IF EXISTS "customers_receipt_delivery_chk";--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_receipt_delivery_chk" CHECK ("receipt_delivery" IS NULL OR "receipt_delivery" in ('email', 'app'));--> statement-breakpoint
ALTER TABLE "receipt_deliveries" DROP CONSTRAINT IF EXISTS "receipt_deliveries_channel";--> statement-breakpoint
ALTER TABLE "receipt_deliveries" ADD CONSTRAINT "receipt_deliveries_channel" CHECK ("channel" in ('sms', 'email', 'app', 'none'));--> statement-breakpoint
ALTER TABLE "receipt_deliveries" DROP CONSTRAINT IF EXISTS "receipt_deliveries_purpose";--> statement-breakpoint
ALTER TABLE "receipt_deliveries" ADD CONSTRAINT "receipt_deliveries_purpose" CHECK ("purpose" in ('counter', 'handoff', 'refund', 'void', 'resend', 'request', 'review', 'standing'));
