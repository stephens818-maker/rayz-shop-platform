-- ST-C9: the per-shop cutover checklist's three-way tie-out (Squire's tickets, Squire's final statement, the barbers' answers), signed by the manager and then the CPA.
ALTER TABLE "shop_cutovers" ADD COLUMN "squire_statement_cents" integer;--> statement-breakpoint
ALTER TABLE "shop_cutovers" ADD COLUMN "cpa_signed_name" text;--> statement-breakpoint
ALTER TABLE "shop_cutovers" ADD COLUMN "cpa_signed_on" date;--> statement-breakpoint
ALTER TABLE "shop_cutovers" ADD COLUMN "cpa_report" jsonb;--> statement-breakpoint
ALTER TABLE "shop_cutovers" ADD COLUMN "cpa_recorded_by" uuid;--> statement-breakpoint
ALTER TABLE "shop_cutovers" ADD COLUMN "cpa_recorded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shop_cutovers" ADD CONSTRAINT "shop_cutovers_cpa_recorded_by_staff_id_fk" FOREIGN KEY ("cpa_recorded_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_cutovers" ADD CONSTRAINT "shop_cutovers_statement" CHECK ("shop_cutovers"."squire_statement_cents" is null or "shop_cutovers"."squire_statement_cents" >= 0);--> statement-breakpoint
ALTER TABLE "shop_cutovers" ADD CONSTRAINT "shop_cutovers_cpa" CHECK (("shop_cutovers"."cpa_signed_name" is null) = ("shop_cutovers"."cpa_recorded_at" is null) and ("shop_cutovers"."cpa_signed_on" is null) = ("shop_cutovers"."cpa_recorded_at" is null) and ("shop_cutovers"."cpa_report" is null) = ("shop_cutovers"."cpa_recorded_at" is null));
