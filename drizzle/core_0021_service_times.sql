CREATE TYPE "public"."timing_finished_via" AS ENUM('finish', 'checkout', 'correction');--> statement-breakpoint
CREATE TYPE "public"."timing_review" AS ENUM('include', 'exclude');--> statement-breakpoint
CREATE TABLE "appointment_times" (
	"appointment_id" uuid PRIMARY KEY NOT NULL,
	"arrived_at" timestamp with time zone,
	"arrived_by" uuid,
	"started_at" timestamp with time zone,
	"started_by" uuid,
	"finished_at" timestamp with time zone,
	"finished_by" uuid,
	"finished_via" "timing_finished_via",
	"checked_out_at" timestamp with time zone,
	"checked_out_by" uuid,
	"review" "timing_review",
	"review_note" text,
	"corrected_at" timestamp with time zone,
	"corrected_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_times_order" CHECK ("appointment_times"."finished_at" is null or ("appointment_times"."started_at" is not null and "appointment_times"."finished_at" > "appointment_times"."started_at"))
);
--> statement-breakpoint
ALTER TABLE "appointment_times" ADD CONSTRAINT "appointment_times_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_times" ADD CONSTRAINT "appointment_times_arrived_by_staff_id_fk" FOREIGN KEY ("arrived_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_times" ADD CONSTRAINT "appointment_times_started_by_staff_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_times" ADD CONSTRAINT "appointment_times_finished_by_staff_id_fk" FOREIGN KEY ("finished_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_times" ADD CONSTRAINT "appointment_times_checked_out_by_staff_id_fk" FOREIGN KEY ("checked_out_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_times" ADD CONSTRAINT "appointment_times_corrected_by_staff_id_fk" FOREIGN KEY ("corrected_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_times_started_idx" ON "appointment_times" USING btree ("started_at");--> statement-breakpoint
INSERT INTO "appointment_times" ("appointment_id", "arrived_at") SELECT "id", "checked_in_at" FROM "appointments" WHERE "checked_in_at" IS NOT NULL ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["service_times.correct"]'::jsonb WHERE "key" IN ('brand_admin', 'regional_manager', 'shop_manager') AND NOT ("permissions" ? 'service_times.correct');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["report.service_times.view","report.service_times.export"]'::jsonb WHERE "key" IN ('brand_admin', 'regional_manager', 'shop_manager', 'barber') AND NOT ("permissions" ? 'report.service_times.view');
