CREATE TABLE "appointment_outreach" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_in_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"customer_id" uuid,
	"original_starts_at" timestamp with time zone NOT NULL,
	"original_staff_id" uuid NOT NULL,
	"option" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"resolution" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"next_action_at" timestamp with time zone,
	"suggested_starts_at" timestamp with time zone,
	"suggested_staff_id" uuid,
	"reassigned_staff_id" uuid,
	"reassigned_shop_id" uuid,
	"new_appointment_id" uuid,
	"flagged_at" timestamp with time zone,
	"flag_reason" text,
	"responded_at" timestamp with time zone,
	"sent_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_outreach_uq" UNIQUE("call_in_id","appointment_id")
);
--> statement-breakpoint
CREATE TABLE "call_ins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"shop_id" uuid,
	"kind" text NOT NULL,
	"reason_id" uuid,
	"reason" text NOT NULL,
	"note" text,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"start_min" integer,
	"end_min" integer,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"block_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid
);
--> statement-breakpoint
CREATE TABLE "call_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid,
	"phone" text NOT NULL,
	"customer_id" uuid,
	"direction" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"duration_sec" integer,
	"provider_call_id" text,
	"staff_id" uuid,
	"outreach_id" uuid,
	"digits" text,
	"auto_text_sent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "call_logs_provider_call_id_unique" UNIQUE("provider_call_id")
);
--> statement-breakpoint
CREATE TABLE "contact_opt_outs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"channel" text NOT NULL,
	"source" text NOT NULL,
	"customer_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_opt_outs_uq" UNIQUE("phone","channel")
);
--> statement-breakpoint
CREATE TABLE "message_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"customer_id" uuid,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"unread" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_threads_uq" UNIQUE("shop_id","phone")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"body" text NOT NULL,
	"staff_id" uuid,
	"auto" boolean DEFAULT false NOT NULL,
	"job_id" uuid,
	"provider_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rebook_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"appointment_id" uuid NOT NULL,
	"outreach_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rebook_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "brand_settings" ADD COLUMN "outreach" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "allow_other_shop" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_jobs" ADD COLUMN "provider_message_id" text;--> statement-breakpoint
ALTER TABLE "notification_jobs" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_jobs" ADD COLUMN "outreach_id" uuid;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "twilio_number" text;--> statement-breakpoint
ALTER TABLE "appointment_outreach" ADD CONSTRAINT "appointment_outreach_call_in_id_call_ins_id_fk" FOREIGN KEY ("call_in_id") REFERENCES "public"."call_ins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_outreach" ADD CONSTRAINT "appointment_outreach_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_outreach" ADD CONSTRAINT "appointment_outreach_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_outreach" ADD CONSTRAINT "appointment_outreach_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_ins" ADD CONSTRAINT "call_ins_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_ins" ADD CONSTRAINT "call_ins_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_ins" ADD CONSTRAINT "call_ins_reason_id_block_reasons_id_fk" FOREIGN KEY ("reason_id") REFERENCES "public"."block_reasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_ins" ADD CONSTRAINT "call_ins_block_id_time_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."time_blocks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_outreach_id_appointment_outreach_id_fk" FOREIGN KEY ("outreach_id") REFERENCES "public"."appointment_outreach"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_message_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."message_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_job_id_notification_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."notification_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebook_links" ADD CONSTRAINT "rebook_links_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebook_links" ADD CONSTRAINT "rebook_links_outreach_id_appointment_outreach_id_fk" FOREIGN KEY ("outreach_id") REFERENCES "public"."appointment_outreach"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_outreach_due_idx" ON "appointment_outreach" USING btree ("status","next_action_at");--> statement-breakpoint
CREATE INDEX "appointment_outreach_appt_idx" ON "appointment_outreach" USING btree ("appointment_id");--> statement-breakpoint
CREATE INDEX "appointment_outreach_customer_idx" ON "appointment_outreach" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "call_ins_staff_idx" ON "call_ins" USING btree ("staff_id","starts_at");--> statement-breakpoint
CREATE INDEX "call_ins_starts_idx" ON "call_ins" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "call_logs_phone_idx" ON "call_logs" USING btree ("phone","created_at");--> statement-breakpoint
CREATE INDEX "call_logs_shop_idx" ON "call_logs" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE INDEX "message_threads_recent_idx" ON "message_threads" USING btree ("shop_id","last_message_at");--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "rebook_links_outreach_idx" ON "rebook_links" USING btree ("outreach_id");--> statement-breakpoint
ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_outreach_id_appointment_outreach_id_fk" FOREIGN KEY ("outreach_id") REFERENCES "public"."appointment_outreach"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_jobs_provider_msg_idx" ON "notification_jobs" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "notification_jobs_outreach_idx" ON "notification_jobs" USING btree ("outreach_id");--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_twilio_number_unique" UNIQUE("twilio_number");--> statement-breakpoint
INSERT INTO "block_reasons" ("key", "label", "color", "used_for", "counts_as_lunch", "notice_exempt", "private", "sort_order")
SELECT 'emergency', 'Emergency', '#ec4899', 'time_off', false, true, true, 75
WHERE NOT EXISTS (SELECT 1 FROM "block_reasons" WHERE "key" = 'emergency' OR (lower("label") = 'emergency' AND "archived_at" IS NULL));--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["callins.mark","callins.outreach","callins.voice","inbox.view","report.call_ins.view","report.call_ins.export"]'::jsonb WHERE "key" IN ('brand_admin', 'regional_manager', 'shop_manager') AND NOT ("permissions" ? 'callins.mark');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["callins.mark_own"]'::jsonb WHERE "key" = 'brand_admin' AND NOT ("permissions" ? 'callins.mark_own');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["callins.outreach","inbox.view"]'::jsonb WHERE "key" = 'front_desk' AND NOT ("permissions" ? 'callins.outreach');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["callins.mark","callins.outreach","callins.voice","report.call_ins.view"]'::jsonb WHERE "key" IS NULL AND "permissions" ? 'timeoff.approve' AND NOT ("permissions" ? 'callins.mark');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["inbox.view"]'::jsonb WHERE "key" IS NULL AND "permissions" ? 'calendar.manage' AND NOT ("permissions" ? 'inbox.view');
