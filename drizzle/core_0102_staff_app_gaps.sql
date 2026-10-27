-- The staff app's platform gaps (ST-C1, ST-C9, ST-C10): refresh tokens bound to the install that signed in, staff app invites by text or email apart from brand portal invites, the Squire-to-Ray'z tip payout reconciliation per shop (Squire paid through, Squire's last payout day, the manager's sign-off), each barber's confirmation of it, and year-to-date tips and earnings imported from Squire for W-2 continuity. Additive only.
ALTER TABLE "staff_app_tokens" ADD COLUMN IF NOT EXISTS "device_id" text;--> statement-breakpoint
ALTER TABLE "staff_app_tokens" ADD COLUMN IF NOT EXISTS "last_used_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_app_tokens_device_idx" ON "staff_app_tokens" ("staff_id", "device_id") WHERE "revoked_at" IS NULL AND "device_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_invites" ADD COLUMN IF NOT EXISTS "purpose" text DEFAULT 'portal' NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_invites" ADD COLUMN IF NOT EXISTS "channel" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "staff_invites" ADD CONSTRAINT "staff_invites_purpose" CHECK ("purpose" in ('portal', 'staff_app') and ("channel" is null or "channel" in ('sms', 'email')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
ALTER TABLE "shop_cutovers" ADD COLUMN IF NOT EXISTS "squire_paid_through" date;--> statement-breakpoint
ALTER TABLE "shop_cutovers" ADD COLUMN IF NOT EXISTS "squire_last_payout_on" date;--> statement-breakpoint
ALTER TABLE "shop_cutovers" ADD COLUMN IF NOT EXISTS "payout_report" jsonb;--> statement-breakpoint
ALTER TABLE "shop_cutovers" ADD COLUMN IF NOT EXISTS "payout_report_signed_by" uuid REFERENCES "staff"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "shop_cutovers" ADD COLUMN IF NOT EXISTS "payout_report_signed_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_payout_confirmations" (
  "shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
  "staff_id" uuid NOT NULL REFERENCES "staff"("id") ON DELETE cascade,
  "status" text NOT NULL,
  "squire_owed_cents" integer NOT NULL,
  "note" text,
  "decided_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "staff_payout_confirmations_pk" PRIMARY KEY ("shop_id", "staff_id"),
  CONSTRAINT "staff_payout_confirmations_status" CHECK ("status" in ('confirmed', 'disputed') and ("status" = 'confirmed' or length(trim(coalesce("note", ''))) > 0))
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_ytd_imports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "staff_id" uuid NOT NULL REFERENCES "staff"("id") ON DELETE cascade,
  "shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
  "year" smallint NOT NULL,
  "through_date" date NOT NULL,
  "card_tips_cents" integer DEFAULT 0 NOT NULL,
  "cash_tips_cents" integer DEFAULT 0 NOT NULL,
  "service_sales_cents" integer DEFAULT 0 NOT NULL,
  "product_sales_cents" integer DEFAULT 0 NOT NULL,
  "paid_out_cents" integer DEFAULT 0 NOT NULL,
  "source" text DEFAULT 'squire' NOT NULL,
  "imported_by" uuid REFERENCES "staff"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "staff_ytd_imports_year" CHECK ("year" between 2000 and 2100 and extract(year from "through_date") = "year"),
  CONSTRAINT "staff_ytd_imports_cents" CHECK ("card_tips_cents" >= 0 and "cash_tips_cents" >= 0 and "service_sales_cents" >= 0 and "product_sales_cents" >= 0 and "paid_out_cents" >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "staff_ytd_imports_uq" ON "staff_ytd_imports" ("staff_id", "shop_id", "year", "source");
