-- Mobile customer app (/api/v1). Additive only. Core migrations use the core_ prefix.
ALTER TABLE "customers" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "imported_from" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "identity_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "push_transactional" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "push_marketing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "sms_marketing_opt_in" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "email_marketing_opt_in" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "secure_profile" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "preferences" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "unverified_guest" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "birth_year" integer;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "age_confirmed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_stripe_customer_uq" ON "customers" ("stripe_customer_id") WHERE "stripe_customer_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "customers_imported_from_idx" ON "customers" ("imported_from");--> statement-breakpoint

ALTER TABLE "shops" ADD COLUMN "lat" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "lng" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "photo_url" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "google_review_url" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "booking_mode" text DEFAULT 'native' NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "external_booking_url" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "stripe_account_id" text;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "stripe_account_id" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "owner_entity_id" uuid;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "cancellation_policy" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "squire_frozen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_booking_mode_chk" CHECK ("booking_mode" IN ('native', 'external', 'closed'));--> statement-breakpoint

ALTER TABLE "otp_codes" ADD COLUMN "purpose" text DEFAULT 'signin' NOT NULL;--> statement-breakpoint
ALTER TABLE "otp_codes" ADD COLUMN "channel" text;--> statement-breakpoint
ALTER TABLE "otp_codes" ADD COLUMN "ip" text;--> statement-breakpoint
ALTER TABLE "otp_codes" ADD COLUMN "device_key" text;--> statement-breakpoint
ALTER TABLE "otp_codes" ADD COLUMN "verify_sid" text;--> statement-breakpoint

ALTER TABLE "refresh_tokens" ADD COLUMN "client" text;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "app_version" text;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "ip" text;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "device_id" uuid;--> statement-breakpoint

ALTER TABLE "appointments" ADD COLUMN "group_id" uuid;--> statement-breakpoint

CREATE TABLE "appointment_groups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" text NOT NULL UNIQUE,
  "customer_id" uuid REFERENCES "customers"("id"),
  "shop_id" uuid NOT NULL REFERENCES "shops"("id"),
  "mode" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "appointment_groups"("id") ON DELETE set null;--> statement-breakpoint

CREATE TABLE "customer_devices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE cascade,
  "platform" text NOT NULL,
  "provider" text NOT NULL,
  "token" text NOT NULL,
  "app_version" text,
  "os_version" text,
  "locale" text,
  "push_enabled" boolean DEFAULT true NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "customer_devices_platform_chk" CHECK ("platform" IN ('ios', 'android')),
  CONSTRAINT "customer_devices_provider_chk" CHECK ("provider" IN ('apns', 'fcm', 'expo'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "customer_devices_token_uq" ON "customer_devices" ("token");--> statement-breakpoint
CREATE INDEX "customer_devices_customer_idx" ON "customer_devices" ("customer_id");--> statement-breakpoint

CREATE TABLE "consent_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "customer_id" uuid REFERENCES "customers"("id") ON DELETE set null,
  "phone" text,
  "email" text,
  "channel" text NOT NULL,
  "action" text NOT NULL,
  "text_version" text NOT NULL,
  "source" text NOT NULL,
  "app_version" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "consent_events_channel_chk" CHECK ("channel" IN ('sms_transactional', 'sms_marketing', 'email', 'email_marketing', 'push_transactional', 'push_marketing')),
  CONSTRAINT "consent_events_action_chk" CHECK ("action" IN ('granted', 'revoked')),
  CONSTRAINT "consent_events_source_chk" CHECK ("source" IN ('ios', 'android', 'web', 'pos', 'import', 'sms'))
);--> statement-breakpoint
CREATE INDEX "consent_events_customer_idx" ON "consent_events" ("customer_id", "created_at");--> statement-breakpoint
CREATE INDEX "consent_events_phone_idx" ON "consent_events" ("phone");--> statement-breakpoint

CREATE TABLE "customer_dependents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "guardian_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE cascade,
  "dependent_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE cascade,
  "relationship" text DEFAULT 'child' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "customer_dependents_uq" UNIQUE ("guardian_id", "dependent_id")
);--> statement-breakpoint
CREATE INDEX "customer_dependents_dependent_idx" ON "customer_dependents" ("dependent_id");--> statement-breakpoint

CREATE TABLE "customer_payment_methods" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE cascade,
  "stripe_payment_method_id" text NOT NULL,
  "brand" text NOT NULL,
  "last4" text NOT NULL,
  "funding" text NOT NULL,
  "exp_month" integer,
  "exp_year" integer,
  "wallet" text,
  "is_default" boolean DEFAULT false NOT NULL,
  "detached_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "customer_payment_methods_pm_uq" ON "customer_payment_methods" ("stripe_payment_method_id");--> statement-breakpoint
CREATE INDEX "customer_payment_methods_customer_idx" ON "customer_payment_methods" ("customer_id");--> statement-breakpoint

CREATE TABLE "mobile_checkouts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "appointment_id" uuid NOT NULL REFERENCES "appointments"("id"),
  "customer_id" uuid NOT NULL REFERENCES "customers"("id"),
  "shop_id" uuid NOT NULL REFERENCES "shops"("id"),
  "idempotency_key" text,
  "tip_cents" integer DEFAULT 0 NOT NULL,
  "subtotal_cents" integer NOT NULL,
  "tax_cents" integer DEFAULT 0 NOT NULL,
  "fee_cents" integer DEFAULT 0 NOT NULL,
  "total_cents" integer NOT NULL,
  "funding" text,
  "wallet" text,
  "stripe_payment_intent_id" text,
  "status" text DEFAULT 'quoted' NOT NULL,
  "sale_id" uuid REFERENCES "sales"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "mobile_checkouts_idem_uq" ON "mobile_checkouts" ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "mobile_checkouts_pi_uq" ON "mobile_checkouts" ("stripe_payment_intent_id");--> statement-breakpoint
CREATE INDEX "mobile_checkouts_appt_idx" ON "mobile_checkouts" ("appointment_id");--> statement-breakpoint

CREATE TABLE "mobile_stripe_events" (
  "id" text PRIMARY KEY NOT NULL,
  "type" text NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "mobile_rate_buckets" (
  "key" text PRIMARY KEY NOT NULL,
  "window_start" timestamp with time zone DEFAULT now() NOT NULL,
  "count" integer DEFAULT 0 NOT NULL
);--> statement-breakpoint

CREATE TABLE "identity_tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "customer_id" uuid REFERENCES "customers"("id") ON DELETE set null,
  "phone" text,
  "email" text,
  "kind" text DEFAULT 'cant_sign_in' NOT NULL,
  "detail" text,
  "status" text DEFAULT 'open' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "identity_tasks_status_idx" ON "identity_tasks" ("status", "created_at");--> statement-breakpoint

CREATE TABLE "customer_favorites" (
  "customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE cascade,
  "staff_id" uuid NOT NULL REFERENCES "staff"("id") ON DELETE cascade,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "customer_favorites_pk" PRIMARY KEY ("customer_id", "staff_id")
);--> statement-breakpoint

CREATE TABLE "service_locales" (
  "service_id" uuid NOT NULL REFERENCES "services"("id") ON DELETE cascade,
  "locale" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  CONSTRAINT "service_locales_pk" PRIMARY KEY ("service_id", "locale")
);--> statement-breakpoint

CREATE TABLE "app_config" (
  "id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
  "min_ios" text DEFAULT '3.0.0' NOT NULL,
  "min_android" text DEFAULT '3.0.0' NOT NULL,
  "latest_ios" text DEFAULT '3.0.0' NOT NULL,
  "latest_android" text DEFAULT '3.0.0' NOT NULL,
  "ios_store_url" text DEFAULT 'https://apps.apple.com/app/id1570336126' NOT NULL,
  "android_store_url" text DEFAULT 'https://play.google.com/store/apps/details?id=com.getsquire.SquireRayz' NOT NULL,
  "flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
INSERT INTO "app_config" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint

-- Tip rows are skipped unless FEATURE_TIP_TO_BARBER=true. That path is not for W-2 employees, pending CPA.
CREATE TABLE "connect_transfers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "payment_intent_id" text NOT NULL,
  "charge_id" text,
  "transfer_group" text NOT NULL,
  "destination_account" text,
  "staff_id" uuid REFERENCES "staff"("id"),
  "shop_id" uuid NOT NULL REFERENCES "shops"("id"),
  "role" text NOT NULL,
  "amount_cents" integer NOT NULL,
  "reversed_cents" integer DEFAULT 0 NOT NULL,
  "status" text NOT NULL,
  "stripe_transfer_id" text,
  "reversal_id" text,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "connect_transfers_role_chk" CHECK ("role" IN ('shop_net', 'tip')),
  CONSTRAINT "connect_transfers_status_chk" CHECK ("status" IN ('planned', 'executed', 'reversed', 'failed', 'skipped'))
);--> statement-breakpoint
CREATE INDEX "connect_transfers_pi_idx" ON "connect_transfers" ("payment_intent_id");--> statement-breakpoint

CREATE TABLE "import_reconciliations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "shop_id" uuid REFERENCES "shops"("id"),
  "kind" text NOT NULL,
  "dry_run" boolean DEFAULT true NOT NULL,
  "frozen_at" timestamp with time zone,
  "report" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
