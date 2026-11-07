-- ST-C17: an employee's recorded, versioned and revocable consent to Stripe tip deposits.
ALTER TABLE "staff_payout_accounts" ADD COLUMN "deposit_consent_version" text;--> statement-breakpoint
ALTER TABLE "staff_payout_accounts" ADD COLUMN "deposit_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff_payout_accounts" ADD CONSTRAINT "staff_payout_accounts_deposit_consent" CHECK (("staff_payout_accounts"."deposit_consent_version" is null) = ("staff_payout_accounts"."deposit_consent_at" is null));--> statement-breakpoint
CREATE TABLE "tip_deposit_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"action" text NOT NULL,
	"version" text NOT NULL,
	"text" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tip_deposit_consents_action" CHECK ("tip_deposit_consents"."action" in ('granted', 'revoked')),
	CONSTRAINT "tip_deposit_consents_source" CHECK ("tip_deposit_consents"."source" in ('web', 'staff_app')),
	CONSTRAINT "tip_deposit_consents_text" CHECK (char_length("tip_deposit_consents"."text") <= 2000)
);--> statement-breakpoint
ALTER TABLE "tip_deposit_consents" ADD CONSTRAINT "tip_deposit_consents_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tip_deposit_consents_staff_idx" ON "tip_deposit_consents" USING btree ("staff_id","created_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "tip_deposit_consents_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'tip_deposit_consents %: consent records are never changed or removed', OLD."id";
END $$;--> statement-breakpoint
CREATE TRIGGER "tip_deposit_consents_append_only" BEFORE UPDATE OR DELETE ON "tip_deposit_consents" FOR EACH ROW EXECUTE FUNCTION "tip_deposit_consents_append_only"();
