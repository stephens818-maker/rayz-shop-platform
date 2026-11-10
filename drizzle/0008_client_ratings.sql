CREATE TABLE "client_ratings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"appointment_id" uuid,
	"sale_id" uuid,
	"staff_id" uuid NOT NULL,
	"stars" smallint NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_ratings" ADD CONSTRAINT "client_ratings_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_ratings" ADD CONSTRAINT "client_ratings_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_ratings" ADD CONSTRAINT "client_ratings_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_ratings" ADD CONSTRAINT "client_ratings_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_ratings" ADD CONSTRAINT "client_ratings_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_ratings_customer_idx" ON "client_ratings" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "client_ratings_shop_customer_idx" ON "client_ratings" USING btree ("shop_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "client_ratings_staff_appt_uq" ON "client_ratings" USING btree ("staff_id","appointment_id") WHERE appointment_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "client_ratings_staff_sale_uq" ON "client_ratings" USING btree ("staff_id","sale_id") WHERE appointment_id is null and sale_id is not null;--> statement-breakpoint
ALTER TABLE "client_ratings" ADD CONSTRAINT "client_ratings_stars_range" CHECK ("stars" BETWEEN 1 AND 5);--> statement-breakpoint
ALTER TABLE "client_ratings" ADD CONSTRAINT "client_ratings_note_length" CHECK ("note" IS NULL OR char_length("note") <= 500);--> statement-breakpoint
ALTER TABLE "client_ratings" ADD CONSTRAINT "client_ratings_has_visit" CHECK ("appointment_id" IS NOT NULL OR "sale_id" IS NOT NULL);
